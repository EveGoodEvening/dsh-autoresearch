import { readFileSync } from 'node:fs'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { Config, createEvaluatorRegistry, DEFAULT_CONFIG, normalizeRunPolicy, resolveConfig } from '../src/config.ts'
import { boundText, renderExperimentResult, renderRunResult, renderToolResult } from '../src/render.ts'
import { ACTIVATION_AUTORESEARCH_TOOL_SCHEMA, decodeActivationToolInput, decodeExperimentResult, decodeRunResult, isTargetReached } from '../src/types.ts'
import type { ActivationAutoresearchToolInput, MetricDirection } from '../src/types.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const HASH = 'c'.repeat(64)
const artifact = {
  artifactId: 'artifact-1',
  kind: 'stdout',
  location: 'artifacts/stdout.txt',
  sizeBytes: 3,
  sha256: HASH,
}
const stderr = { ...artifact, artifactId: 'artifact-2', kind: 'stderr' }
const counts = { experimentsStarted: 1, experimentsCompleted: 1, attempts: 1 }
const best = { metric: 1.5, commit: SHA_A, experimentId: 'experiment-1' }
const evidence = [{ code: 'external-mutation', message: 'worktree HEAD changed', artifacts: [] }]
const runBase = { runId: 'run-1', tracker: 'state/run-1.sqlite', counts, artifacts: [] }
const experimentBase = { experimentId: 'experiment-1', attemptId: 'attempt-1', parentCommit: SHA_A, artifacts: [] }
const exit = { exitCode: 1, signal: null, timedOut: false, stdout: artifact, stderr }

const registrationConfig = { id: 'judge', command: 'node', args: ['scripts/evaluate.mjs'], cwd: 'fixtures', environment: {}, metricName: 'score', metricDirection: 'minimize' as const, metricParserVersion: 'final-line-json-v1' as const, evaluatorFiles: ['scripts/evaluate.mjs'] }
const registration = createEvaluatorRegistry([registrationConfig]).resolve('judge')
function input(overrides: Partial<ActivationAutoresearchToolInput> = {}): ActivationAutoresearchToolInput {
  return {
    run_tag: 'contract-test',
    evaluator_id: 'judge',
    objective: 'Improve the measured score.',
    constraints: ['Keep output stable.'],
    mutable_globs: ['src/**'],
    ...overrides,
  } as ActivationAutoresearchToolInput
}

function decodeExperiment(value: Record<string, unknown>, direction: MetricDirection = 'minimize') {
  return decodeExperimentResult(value, direction, 10_000)
}

function requireAndForbid(
  decode: (value: Record<string, unknown>) => unknown,
  valid: Record<string, unknown>,
  required: readonly string[],
  forbidden: readonly [string, unknown][],
): void {
  expect(decode(valid)).toBeDefined()
  const requiredKeys = new Set([...Object.keys(valid), ...required])
  for (const key of requiredKeys) {
    const missing = { ...valid }
    delete missing[key]
    expect(() => decode(missing), `required field ${key}`).toThrow()
  }
  for (const [key, value] of forbidden) {
    expect(() => decode({ ...valid, [key]: value }), `forbidden field ${key}`).toThrow(/unexpected keys/)
  }
}

describe('run result contracts', () => {
  it.each([
    ['target-reached', { ...runBase, status: 'target-reached', target: 2, best }, ['target', 'best'], [['reason', 'no']] ],
    ['budget-limited', { ...runBase, status: 'budget-limited', best }, ['best'], [['target', 2]] ],
    ['baseline-blocked', { ...runBase, status: 'baseline-blocked', baselineAttemptId: 'baseline-attempt', reason: 'evaluator failed', exit }, ['baselineAttemptId', 'reason', 'exit'], [['best', best]] ],
    ['blocked', { ...runBase, status: 'blocked', best, evidence }, ['best', 'evidence'], [['reason', 'no']] ],
    ['round-failed', { ...runBase, status: 'round-failed', reason: 'agent failed', evidence }, ['reason', 'evidence'], [['exit', exit]] ],
    ['cancelled', { ...runBase, status: 'cancelled', lastState: 'candidate-running', reason: 'operator request', quiescent: true }, ['lastState', 'reason', 'quiescent'], [['evidence', evidence]] ],
  ] as const)('enforces required and forbidden fields for %s', (_status, valid, required, forbidden) => {
    requireAndForbid((value) => decodeRunResult(value, 'minimize'), valid, required, forbidden)
  })

  it('enforces discriminator-specific invariants and optional best fields', () => {
    expect(decodeRunResult({ ...runBase, status: 'round-failed', reason: 'agent failed', evidence, best }, 'minimize')).toHaveProperty('best')
    expect(decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'ready', reason: 'operator request', quiescent: true, best }, 'minimize')).toHaveProperty('best')
    expect(() => decodeRunResult({ ...runBase, status: 'blocked', best, evidence: [] }, 'minimize')).toThrow(/requires evidence/)
    expect(() => decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'cancelled', reason: 'operator request', quiescent: true }, 'minimize')).toThrow(/valid prior state/)
    expect(() => decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'ready', reason: 'operator request', quiescent: false }, 'minimize')).toThrow(/quiescent/)
  })

  it.each([
    ['minimize', 4, 5, true],
    ['minimize', 5, 5, true],
    ['minimize', 6, 5, false],
    ['maximize', 6, 5, true],
    ['maximize', 5, 5, true],
    ['maximize', 4, 5, false],
  ] as const)('recomputes %s target satisfaction from best metric', (direction, metric, target, expected) => {
    expect(isTargetReached(direction, metric, target)).toBe(expected)
    const value = { ...runBase, status: 'target-reached', target, best: { ...best, metric } }
    if (expected) expect(decodeRunResult(value, direction)).toMatchObject({ status: 'target-reached', target })
    else expect(() => decodeRunResult(value, direction)).toThrow(/does not satisfy target/)
  })

  it('rejects malformed common and nested fields', () => {
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, metric: Number.NaN } }, 'minimize')).toThrow(/finite/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, commit: 'abc1234' } }, 'minimize')).toThrow(/full lowercase commit SHA/)
    expect(() => decodeRunResult({ ...runBase, counts: { ...counts, experimentsCompleted: 2 }, status: 'budget-limited', best }, 'minimize')).toThrow(/inconsistent/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best, extra: true }, 'minimize')).toThrow(/unexpected keys/)
  })

  it('accepts a 100-experiment canonical result above the presentation limit', () => {
    const artifacts = Array.from({ length: 202 }, (_, index) => ({
      ...artifact,
      artifactId: `artifact-${index}-${'a'.repeat(96)}`,
      location: `artifacts/${index}/${'b'.repeat(64)}.txt`,
    }))
    const value = {
      ...runBase,
      counts: { experimentsStarted: 100, experimentsCompleted: 100, attempts: 101 },
      artifacts,
      status: 'budget-limited',
      best,
    } as const
    expect(JSON.stringify(value).length).toBeGreaterThan(DEFAULT_CONFIG.maxResultChars)
    const decoded = decodeRunResult(value, 'minimize')
    expect(decoded).toEqual(value)
    const rendered = renderRunResult(decoded, DEFAULT_CONFIG.maxResultChars)
    expect(rendered).toHaveLength(DEFAULT_CONFIG.maxResultChars)
    expect(rendered).toMatch(/… \[truncated\]$/)
  })
})

describe('experiment result contracts', () => {
  it.each([
    ['baseline-measured', { ...experimentBase, kind: 'baseline-measured', metric: 10, commit: SHA_A }, ['metric', 'commit'], [['candidateCommit', SHA_B]] ],
    ['accepted', { ...experimentBase, kind: 'accepted', metric: 9, candidateCommit: SHA_B, previousBest: 10 }, ['metric', 'candidateCommit', 'previousBest'], [['currentBest', 10]] ],
    ['rejected', { ...experimentBase, kind: 'rejected', metric: 10, candidateCommit: SHA_B, currentBest: 10 }, ['metric', 'candidateCommit', 'currentBest'], [['previousBest', 10]] ],
    ['crashed', { ...experimentBase, kind: 'crashed', exit, reason: 'evaluator failed' }, ['exit', 'reason'], [['metric', 10]] ],
    ['timed-out', { ...experimentBase, kind: 'timed-out', exit: { ...exit, timedOut: true } }, ['exit'], [['reason', 'timeout']] ],
    ['policy-violation', { ...experimentBase, kind: 'policy-violation', candidateCommit: SHA_B, evidence }, ['candidateCommit', 'evidence'], [['exit', exit]] ],
    ['cancelled', { ...experimentBase, kind: 'cancelled', quiescent: true, reason: 'operator request' }, ['quiescent', 'reason'], [['evidence', evidence]] ],
  ] as const)('enforces required and forbidden fields for %s', (_kind, valid, required, forbidden) => {
    requireAndForbid(decodeExperiment, valid, required, forbidden)
  })

  it('requires the measured baseline commit to equal its parent commit', () => {
    expect(decodeExperiment({ ...experimentBase, kind: 'baseline-measured', metric: 10, commit: SHA_A })).toMatchObject({ commit: SHA_A })
    expect(() => decodeExperiment({ ...experimentBase, kind: 'baseline-measured', metric: 10, commit: SHA_B })).toThrow(/equal parentCommit/)
  })

  it.each([
    ['minimize', 'accepted', 9, 10, true],
    ['minimize', 'accepted', 10, 10, false],
    ['minimize', 'accepted', 11, 10, false],
    ['maximize', 'accepted', 11, 10, true],
    ['maximize', 'accepted', 10, 10, false],
    ['maximize', 'accepted', 9, 10, false],
    ['minimize', 'rejected', 9, 10, false],
    ['minimize', 'rejected', 10, 10, true],
    ['minimize', 'rejected', 11, 10, true],
    ['maximize', 'rejected', 11, 10, false],
    ['maximize', 'rejected', 10, 10, true],
    ['maximize', 'rejected', 9, 10, true],
  ] as const)('recomputes %s %s strict-decision semantics', (direction, kind, metric, reference, valid) => {
    const value = kind === 'accepted'
      ? { ...experimentBase, kind, metric, candidateCommit: SHA_B, previousBest: reference }
      : { ...experimentBase, kind, metric, candidateCommit: SHA_B, currentBest: reference }
    if (valid) expect(decodeExperiment(value, direction)).toMatchObject({ kind, metric })
    else expect(() => decodeExperiment(value, direction)).toThrow(/strictly improve/)
  })

  it('enforces exit, evidence, and quiescence invariants with optional candidate commits', () => {
    expect(decodeExperiment({ ...experimentBase, kind: 'crashed', candidateCommit: SHA_B, exit, reason: 'failed' })).toHaveProperty('candidateCommit', SHA_B)
    expect(decodeExperiment({ ...experimentBase, kind: 'timed-out', candidateCommit: SHA_B, exit: { ...exit, timedOut: true } })).toHaveProperty('candidateCommit', SHA_B)
    expect(decodeExperiment({ ...experimentBase, kind: 'cancelled', candidateCommit: SHA_B, quiescent: true, reason: 'cancelled' })).toHaveProperty('candidateCommit', SHA_B)
    expect(() => decodeExperiment({ ...experimentBase, kind: 'timed-out', exit })).toThrow(/requires timedOut/)
    expect(() => decodeExperiment({ ...experimentBase, kind: 'policy-violation', candidateCommit: SHA_B, evidence: [] })).toThrow(/requires evidence/)
    expect(() => decodeExperiment({ ...experimentBase, kind: 'cancelled', quiescent: false, reason: 'cancelled' })).toThrow(/quiescent/)
  })

  it('rejects malformed common and nested fields', () => {
    expect(() => decodeExperiment({ ...experimentBase, kind: 'baseline-measured', metric: Infinity, commit: SHA_A })).toThrow(/finite/)
    expect(() => decodeExperiment({ ...experimentBase, parentCommit: 'deadbeef', kind: 'baseline-measured', metric: 1, commit: SHA_A })).toThrow(/full lowercase commit SHA/)
    expect(() => decodeExperiment({ ...experimentBase, kind: 'accepted', metric: 1, candidateCommit: SHA_B, previousBest: 2, extra: true })).toThrow(/unexpected keys/)
    expect(() => decodeExperiment({ ...experimentBase, artifacts: [{ ...artifact, extra: true }], kind: 'baseline-measured', metric: 1, commit: SHA_A })).toThrow(/unexpected keys/)
  })
})

describe('configuration and policy normalization', () => {
  it('resolves every omitted deployment default', () => {
    const { evaluatorRegistry: resolvedRegistry, ...resolvedDefaults } = resolveConfig()
    const { evaluatorRegistry: defaultRegistry, ...expectedDefaults } = DEFAULT_CONFIG
    expect(resolvedDefaults).toEqual(expectedDefaults)
    expect(resolvedRegistry.registrations).toEqual(defaultRegistry.registrations)
    expect(DEFAULT_CONFIG).toMatchObject({
      gitExecutable: 'git',
      stateRoot: 'dsh-autoresearch',
      branchPrefix: 'autoresearch/',
      defaultMaxExperiments: 20,
      maxExperiments: 100,
      maxHandoffChars: 16_384,
      maxResultChars: 16_384,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 1_048_576,
      defaultTimeoutMs: 900_000,
      maxTimeoutMs: 3_600_000,
      terminationGraceMs: 5_000,
      maxActiveRunsPerRepository: 1,
      artifactRetentionDays: 30,
      retainFailedArtifacts: true,
      retainWorktrees: true,
      cleanupWorktreesOnSuccess: false,
      exportTsv: true,
      tsvRetentionDays: 30,
    })
    expect(DEFAULT_CONFIG.evaluatorRegistry.registrations).toEqual([])
  })

  it.each(['subagentProvider', 'resultsFile'] as const)('rejects removed deployment key %s', (key) => {
    expect(() => resolveConfig({ [key]: 'legacy-value' } as never)).toThrow(`Config: unknown key "${key}"`)
  })

  it('normalizes omitted run defaults down to configured deployment caps', () => {
    const config = resolveConfig({ maxExperiments: 7, maxTimeoutMs: 8_000 })
    expect(config.defaultMaxExperiments).toBe(7)
    expect(config.defaultTimeoutMs).toBe(8_000)
    expect(normalizeRunPolicy(input(), config, '/caller', registration)).toMatchObject({ maxExperiments: 7, timeoutMs: 8_000, mode: 'background' })
  })

  it('enforces cap and retention cross-field combinations', () => {
    expect(() => resolveConfig({ maxExperiments: 7, defaultMaxExperiments: DEFAULT_CONFIG.defaultMaxExperiments })).toThrow(/defaultMaxExperiments/)
    expect(() => resolveConfig({ maxTimeoutMs: 8_000, defaultTimeoutMs: DEFAULT_CONFIG.defaultTimeoutMs })).toThrow(/defaultTimeoutMs/)
    expect(() => resolveConfig({ retainWorktrees: true, cleanupWorktreesOnSuccess: true })).toThrow(/cannot both be true/)
    expect(resolveConfig({ retainWorktrees: false, cleanupWorktreesOnSuccess: true, retainFailedArtifacts: false, exportTsv: false, tsvRetentionDays: 1 })).toMatchObject({
      retainWorktrees: false,
      cleanupWorktreesOnSuccess: true,
      retainFailedArtifacts: false,
      exportTsv: false,
      tsvRetentionDays: 1,
    })
    expect(resolveConfig({ retainWorktrees: false, cleanupWorktreesOnSuccess: false })).toMatchObject({ retainWorktrees: false, cleanupWorktreesOnSuccess: false })
    const config = resolveConfig({ maxExperiments: 7, maxTimeoutMs: 8_000 })
    expect(() => normalizeRunPolicy(input({ max_experiments: 8 }), config, '/caller', registration)).toThrow(/deployment maximum/)
    expect(() => normalizeRunPolicy(input({ timeout_ms: 8_001 }), config, '/caller', registration)).toThrow(/deployment maximum/)
  })

  it.each([
    [{ command: ' node' }, /command/],
    [{ args: 'script.mjs' }, /args must be an array/],
    [{ args: ['ok\nno'] }, /args\[0\]/],
    [{ cwd: '/absolute' }, /repository-relative path/],
    [{ cwd: '../escape' }, /parent components/],
    [{ shell: true }, /unknown key "shell"/],
    [{ environment: { DSH_TOKEN: 'host-owned' } }, /environment name DSH_TOKEN is reserved/],
  ] as const)('rejects unsafe Host evaluator registration %#', (override, message) => {
    expect(() => createEvaluatorRegistry([{ ...registrationConfig, ...override } as never])).toThrow(message)
  })

  it('preserves non-reserved Host-owned evaluator environment keys during registration normalization', () => {
    const selected = createEvaluatorRegistry([{ ...registrationConfig, environment: { PATH_HINT: 'safe' } }]).resolve('judge')
    expect(normalizeRunPolicy(input(), resolveConfig(), '/caller', selected).environment).toEqual({ PATH_HINT: 'safe' })
  })

  it('returns a deeply immutable, deduplicated and key-stable activated policy snapshot', () => {
    const selected = createEvaluatorRegistry([{ ...registrationConfig, environment: { ZED: 'last', ALPHA: 'first' } }]).resolve('judge')
    const policy = normalizeRunPolicy(input({ constraints: ['same', 'same'], mutable_globs: ['src/**', 'src/**'] }), resolveConfig(), '/caller', selected)
    expect(policy.constraints).toEqual(['same'])
    expect(policy.mutableGlobs).toEqual(['src/**'])
    expect(Object.keys(policy.environment)).toEqual(['ALPHA', 'ZED'])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.evaluation)).toBe(true)
    expect(Object.isFrozen(policy.environment)).toBe(true)
  })

  it('normalizes a deterministic Host-owned evaluator registry and resolves exact IDs', () => {
    const base = { command: 'node', args: ['score.mjs'], environment: { ZED: '2', ALPHA: '1' }, metricName: 'score', metricDirection: 'minimize' as const, metricParserVersion: 'final-line-json-v1' as const, evaluatorFiles: ['scripts/score.mjs'] }
    const registry = createEvaluatorRegistry([
      { ...base, id: 'z-judge', dataset: { kind: 'external', digest: `sha256:${'a'.repeat(64)}`, identity: 'benchmark-v1' } },
      { ...base, id: 'a-judge', dataset: { kind: 'local', files: ['data/train.json'], identity: 'train-v1' } },
    ])
    expect(registry.registrations.map(item => item.evaluatorId)).toEqual(['a-judge', 'z-judge'])
    expect(Object.keys(registry.resolve('a-judge').environment)).toEqual(['ALPHA', 'ZED'])
    expect(registry.resolve('a-judge')).toBe(registry.registrations[0])
    const datasetless = createEvaluatorRegistry([{ ...base, id: 'datasetless' }]).resolve('datasetless')
    expect(datasetless.dataset).toEqual({ kind: 'none' })
    for (const dataset of [{}, { kind: 'none', files: [] }, { kind: 'local' }, { kind: 'external' }]) {
      expect(() => createEvaluatorRegistry([{ ...base, id: 'malformed', dataset } as never])).toThrow(/dataset/)
    }
    expect(() => registry.resolve('unknown')).toThrow('unknown evaluator registration id "unknown"')
    expect(() => createEvaluatorRegistry([{ ...base, id: 'host-owned', environment: { DSH_TOKEN: 'override' } }])).toThrow(/environment name DSH_TOKEN is reserved/)
    expect(() => createEvaluatorRegistry([{ ...base, id: 'extended', shell: true } as never])).toThrow(/unknown key "shell"/)
    expect(() => createEvaluatorRegistry([{ ...base, id: 'same' }, { ...base, id: 'same' }])).toThrow('duplicate evaluator registration id "same"')
  })

  it('keeps Loader evaluator registration requirements in parity with the runtime config contract', () => {
    const registrations = Config.dict?.['evaluatorRegistrations']
    const fields = registrations?.inner?.dict
    expect(fields).toBeDefined()
    for (const key of ['id', 'command', 'args', 'metricName', 'metricDirection', 'metricParserVersion', 'evaluatorFiles']) expect(fields?.[key]?.meta.required).toBe(true)
    for (const key of ['cwd', 'environment']) expect(fields?.[key]?.meta.required).not.toBe(true)
    expect(fields?.['dataset']?.meta.required).not.toBe(true)
    expect(fields?.['dataset']?.meta.default).toEqual({ kind: 'none' })
  })

  it('exposes the activated discriminated contract without raw authority keys', () => {
    const common = { objective: 'improve', mutable_globs: ['src/**'] }
    expect(decodeActivationToolInput({ ...common, run_tag: 'new', evaluator_id: 'judge' })).toMatchObject({ evaluator_id: 'judge' })
    expect(() => decodeActivationToolInput({ ...common, run_tag: 'new' })).toThrow(/evaluator_id/)
    const durableRunId = '00000000-0000-4000-8000-000000000000'
    expect(decodeActivationToolInput({ ...common, resume_run_id: durableRunId })).not.toHaveProperty('evaluator_id')
    for (const evaluatorId of ['matching', 'mismatching', 'unknown']) expect(() => decodeActivationToolInput({ ...common, resume_run_id: durableRunId, evaluator_id: evaluatorId })).toThrow(/unknown key "evaluator_id"/)
    for (const unsafe of ['run-1', '../escape', '/absolute', 'nested/component', 'nested\\component', '00000000-0000-4000-0000-000000000000']) expect(() => decodeActivationToolInput({ ...common, resume_run_id: unsafe })).toThrow(/canonical UUID v4/)
    for (const key of ['evaluation', 'metric_name', 'metric_direction', 'environment', 'provenance', 'exceptional_allowlists']) expect(() => decodeActivationToolInput({ ...common, run_tag: 'new', evaluator_id: 'judge', [key]: {} })).toThrow(new RegExp(`unknown key "${key}"`))
    expect(JSON.stringify(ACTIVATION_AUTORESEARCH_TOOL_SCHEMA)).not.toMatch(/evaluation|metric_name|metric_direction|environment|provenance|exceptional_allowlists/)
  })

  it('validates every activation common field with policy semantics', () => {
    const valid = { repository: '/repo', objective: 'improve', constraints: ['stable'], mutable_globs: ['src/**'], timeout_ms: 1, max_experiments: 1, target: 0, mode: 'background', run_tag: 'new', evaluator_id: 'judge' }
    for (const [field, values] of Object.entries({
      repository: [7, '', ' padded '],
      objective: [7, '', ' padded '],
      constraints: [7, {}, ['ok', 7], ['bad\nvalue']],
      mutable_globs: [7, [], ['ok', 7], ['/absolute'], ['../escape']],
      timeout_ms: ['1', 0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1],
      max_experiments: ['1', 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1],
      target: ['0', Number.NaN, Number.POSITIVE_INFINITY],
      mode: [7, 'production', 'BACKGROUND'],
    })) {
      for (const value of values) expect(() => decodeActivationToolInput({ ...valid, [field]: value })).toThrow()
    }
    expect(decodeActivationToolInput(valid)).toEqual(valid)
  })

  it('authors only value-schema DSL keys while the strict decoder enforces numeric bounds', () => {
    const schema = ACTIVATION_AUTORESEARCH_TOOL_SCHEMA
    expect(schema.mutable_globs).toMatchObject({ required: true, items: { type: 'string' } })
    expect(schema.timeout_ms).toEqual(expect.objectContaining({ type: 'number' }))
    expect(schema.max_experiments).toEqual(expect.objectContaining({ type: 'number' }))
    expect(Object.keys(schema.timeout_ms)).not.toEqual(expect.arrayContaining(['minimum', 'maximum', 'multipleOf']))
    expect(Object.keys(schema.max_experiments)).not.toEqual(expect.arrayContaining(['minimum', 'maximum', 'multipleOf']))
    expect(schema.mode).toMatchObject({ enum: ['background', 'foreground'] })
  })

  it('returns a fresh canonical deeply frozen activation snapshot', () => {
    const source = { objective: 'improve', constraints: ['stable', 'stable'], mutable_globs: ['src/**', 'src/**'], run_tag: 'new', evaluator_id: 'judge' }
    const decoded = decodeActivationToolInput(source)
    expect(decoded).not.toBe(source)
    expect(decoded.constraints).not.toBe(source.constraints)
    expect(decoded.mutable_globs).not.toBe(source.mutable_globs)
    expect(decoded.constraints).toEqual(['stable'])
    expect(decoded.mutable_globs).toEqual(['src/**'])
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.constraints)).toBe(true)
    expect(Object.isFrozen(decoded.mutable_globs)).toBe(true)
    source.constraints[0] = 'mutated'
    source.mutable_globs[0] = 'other/**'
    source.objective = 'mutated'
    expect(decoded).toMatchObject({ objective: 'improve', constraints: ['stable'], mutable_globs: ['src/**'] })
    expect(() => (decoded.mutable_globs as unknown as string[]).push('other/**')).toThrow()
  })
})

describe('Cordis patch contract', () => {
  it('parses the complete patch row with the Harness loader schema', () => {
    const parsed = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
    const patchDefaults = Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([key]) => key !== 'evaluatorRegistry'))
    expect(parsed).toEqual([{
      insert: [{
        id: 'autoresearch',
        name: 'dsh-autoresearch',
        config: { ...patchDefaults, evaluatorRegistrations: [] },
      }],
    }])
  })
})

describe('stable bounded rendering', () => {
  it('renders canonical run, experiment, and tool summaries in stable order', () => {
    const run = decodeRunResult({ ...runBase, status: 'budget-limited', best, artifacts: [artifact] }, 'minimize')
    expect(renderRunResult(run, 10_000)).toBe([
      'Autoresearch run run-1: budget-limited',
      'Tracker: state/run-1.sqlite',
      `Best: 1.5 at ${SHA_A} (experiment-1)`,
      'Experiments: 1/1; attempts: 1',
      'Artifacts: artifact-1',
    ].join('\n'))

    const experiment = decodeExperimentResult({ ...experimentBase, kind: 'accepted', metric: 1.25, candidateCommit: SHA_B, previousBest: 1.5 }, 'minimize', 10_000)
    expect(renderExperimentResult(experiment, 10_000)).toBe([
      'Experiment experiment-1: accepted',
      `Parent: ${SHA_A}`,
      'Attempt: attempt-1',
      'Metric: 1.25',
      `Candidate: ${SHA_B}`,
    ].join('\n'))

    expect(renderToolResult({ kind: 'background', runId: 'run-1', jobId: 'job-1', tracker: 'tracker.db', branch: 'autoresearch/run-1', worktree: '/tmp/run-1' }, 10_000)).toBe([
      'Started autoresearch run run-1 as job job-1.',
      'Tracker: tracker.db',
      'Branch: autoresearch/run-1',
      'Worktree: /tmp/run-1',
    ].join('\n'))
  })

  it('truncates deterministically at the exact requested bound', () => {
    expect(boundText('abcdefghijk', 10)).toBe('\n… [trunca')
    const rendered = renderRunResult({ ...runBase, status: 'budget-limited', best } as never, 48)
    expect(rendered).toHaveLength(48)
    expect(rendered).toMatch(/… \[truncated\]$/)
  })
})
