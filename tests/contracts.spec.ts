import { readFileSync } from 'node:fs'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, normalizeRunPolicy, resolveConfig } from '../src/config.ts'
import { boundText, renderExperimentResult, renderRunResult, renderToolResult } from '../src/render.ts'
import { decodeExperimentResult, decodeRunResult, isTargetReached } from '../src/types.ts'
import type { AutoresearchToolInput, MetricDirection } from '../src/types.ts'

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

function input(overrides: Partial<AutoresearchToolInput> = {}): AutoresearchToolInput {
  return {
    run_tag: 'contract-test',
    objective: 'Improve the measured score.',
    constraints: ['Keep output stable.'],
    mutable_globs: ['src/**'],
    evaluation: { command: 'node', args: ['scripts/evaluate.mjs'], cwd: 'fixtures' },
    metric_name: 'score',
    metric_direction: 'minimize',
    ...overrides,
  }
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
    requireAndForbid((value) => decodeRunResult(value, 'minimize', 10_000), valid, required, forbidden)
  })

  it('enforces discriminator-specific invariants and optional best fields', () => {
    expect(decodeRunResult({ ...runBase, status: 'round-failed', reason: 'agent failed', evidence, best }, 'minimize', 10_000)).toHaveProperty('best')
    expect(decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'ready', reason: 'operator request', quiescent: true, best }, 'minimize', 10_000)).toHaveProperty('best')
    expect(() => decodeRunResult({ ...runBase, status: 'blocked', best, evidence: [] }, 'minimize', 10_000)).toThrow(/requires evidence/)
    expect(() => decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'cancelled', reason: 'operator request', quiescent: true }, 'minimize', 10_000)).toThrow(/valid prior state/)
    expect(() => decodeRunResult({ ...runBase, status: 'cancelled', lastState: 'ready', reason: 'operator request', quiescent: false }, 'minimize', 10_000)).toThrow(/quiescent/)
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
    if (expected) expect(decodeRunResult(value, direction, 10_000)).toMatchObject({ status: 'target-reached', target })
    else expect(() => decodeRunResult(value, direction, 10_000)).toThrow(/does not satisfy target/)
  })

  it('rejects malformed common and nested fields', () => {
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, metric: Number.NaN } }, 'minimize', 10_000)).toThrow(/finite/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, commit: 'abc1234' } }, 'minimize', 10_000)).toThrow(/full lowercase commit SHA/)
    expect(() => decodeRunResult({ ...runBase, counts: { ...counts, experimentsCompleted: 2 }, status: 'budget-limited', best }, 'minimize', 10_000)).toThrow(/inconsistent/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best, extra: true }, 'minimize', 10_000)).toThrow(/unexpected keys/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best }, 'minimize', 10)).toThrow(/exceeds 10/)
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
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG).toEqual({
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
  })

  it.each(['subagentProvider', 'resultsFile'] as const)('rejects removed deployment key %s', (key) => {
    expect(() => resolveConfig({ [key]: 'legacy-value' } as never)).toThrow(`Config: unknown key "${key}"`)
  })

  it('normalizes omitted run defaults down to configured deployment caps', () => {
    const config = resolveConfig({ maxExperiments: 7, maxTimeoutMs: 8_000 })
    expect(config.defaultMaxExperiments).toBe(7)
    expect(config.defaultTimeoutMs).toBe(8_000)
    expect(normalizeRunPolicy(input(), config, '/caller')).toMatchObject({ maxExperiments: 7, timeoutMs: 8_000, mode: 'background' })
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
    expect(() => normalizeRunPolicy(input({ max_experiments: 8 }), config, '/caller')).toThrow(/deployment maximum/)
    expect(() => normalizeRunPolicy(input({ timeout_ms: 8_001 }), config, '/caller')).toThrow(/deployment maximum/)
  })

  it.each([
    [{ evaluation: { command: ' node', args: [] } }, /evaluation.command/],
    [{ evaluation: { command: 'node', args: 'script.mjs' } }, /evaluation.args must be an array/],
    [{ evaluation: { command: 'node', args: ['ok\nno'] } }, /evaluation.args\[0\]/],
    [{ evaluation: { command: 'node', args: [], cwd: '/absolute' } }, /relative path/],
    [{ evaluation: { command: 'node', args: [], cwd: '../escape' } }, /relative path/],
    [{ evaluation: { command: 'node', args: [], shell: true } }, /unknown key "shell"/],
  ] as const)('rejects unsafe evaluator argv/path policy %#', (override, message) => {
    expect(() => normalizeRunPolicy(input(override as Partial<AutoresearchToolInput>), resolveConfig(), '/caller')).toThrow(message)
  })

  it('rejects reserved DSH_ evaluator environment keys during normalization', () => {
    expect(() => normalizeRunPolicy(input({ environment: { DSH_TOKEN: 'secret' } }), resolveConfig(), '/caller')).toThrow(/reserved DSH_ prefix/)
    expect(normalizeRunPolicy(input({ environment: { PATH_HINT: 'safe' } }), resolveConfig(), '/caller').environment).toEqual({ PATH_HINT: 'safe' })
  })

  it('returns a deeply immutable, deduplicated and key-stable snapshot', () => {
    const policy = normalizeRunPolicy(input({ constraints: ['same', 'same'], mutable_globs: ['src/**', 'src/**'], environment: { ZED: 'last', ALPHA: 'first' } }), resolveConfig(), '/caller')
    expect(policy.constraints).toEqual(['same'])
    expect(policy.mutableGlobs).toEqual(['src/**'])
    expect(Object.keys(policy.environment)).toEqual(['ALPHA', 'ZED'])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.evaluation)).toBe(true)
    expect(Object.isFrozen(policy.environment)).toBe(true)
  })
})

describe('Cordis patch contract', () => {
  it('parses the complete patch row with the Harness loader schema', () => {
    const parsed = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([{
      insert: [{
        id: 'autoresearch',
        name: 'dsh-autoresearch',
        config: { ...DEFAULT_CONFIG },
      }],
    }])
  })
})

describe('stable bounded rendering', () => {
  it('renders canonical run, experiment, and tool summaries in stable order', () => {
    const run = decodeRunResult({ ...runBase, status: 'budget-limited', best, artifacts: [artifact] }, 'minimize', 10_000)
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
