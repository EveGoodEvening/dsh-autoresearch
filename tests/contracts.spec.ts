import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, normalizeRunPolicy, resolveConfig } from '../src/config.ts'
import { boundText, renderExperimentResult, renderRunResult, renderToolResult } from '../src/render.ts'
import { decodeExperimentResult, decodeRunResult, isTargetReached } from '../src/types.ts'
import type { AutoresearchToolInput } from '../src/types.ts'

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
const counts = { experimentsStarted: 1, experimentsCompleted: 1, attempts: 1 }
const best = { metric: 1.5, commit: SHA_A, experimentId: 'experiment-1' }
const runBase = { runId: 'run-1', tracker: 'state/run-1.sqlite', counts, artifacts: [] }
const experimentBase = { experimentId: 'experiment-1', attemptId: 'attempt-1', parentCommit: SHA_A, artifacts: [] }
const exit = { exitCode: 1, signal: null, timedOut: false, stdout: artifact, stderr: { ...artifact, artifactId: 'artifact-2', kind: 'stderr' } }

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


describe('run result contracts', () => {
  it('keeps baseline failure distinct from post-baseline blocking', () => {
    const baselineBlocked = decodeRunResult({
      ...runBase,
      status: 'baseline-blocked',
      baselineAttemptId: 'baseline-attempt',
      reason: 'evaluator failed',
      exit,
    }, 'minimize', 10_000)
    expect(baselineBlocked).not.toHaveProperty('best')

    const blocked = decodeRunResult({
      ...runBase,
      status: 'blocked',
      best,
      evidence: [{ code: 'external-mutation', message: 'worktree HEAD changed', artifacts: [] }],
    }, 'minimize', 10_000)
    expect(blocked).toMatchObject({ status: 'blocked', best })

    expect(() => decodeRunResult({ ...baselineBlocked, best }, 'minimize', 10_000)).toThrow(/unexpected keys/)
    expect(() => decodeRunResult({ ...baselineBlocked, best: null }, 'minimize', 10_000)).toThrow(/unexpected keys/)
    expect(() => decodeRunResult({ ...runBase, status: 'blocked', evidence: [] }, 'minimize', 10_000)).toThrow()
    expect(() => decodeRunResult({ ...runBase, status: 'blocked', best, evidence: [] }, 'minimize', 10_000)).toThrow(/requires evidence/)
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

  it('rejects non-finite metrics, abbreviated SHAs, unknown keys, and oversized JSON', () => {
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, metric: Number.NaN } }, 'minimize', 10_000)).toThrow(/finite/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best: { ...best, commit: 'abc1234' } }, 'minimize', 10_000)).toThrow(/full lowercase commit SHA/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best, extra: true }, 'minimize', 10_000)).toThrow(/unexpected keys/)
    expect(() => decodeRunResult({ ...runBase, status: 'budget-limited', best }, 'minimize', 10)).toThrow(/exceeds 10/)
  })
})

describe('experiment result contracts', () => {
  it('decodes strict-improvement and tie decision facts without losing direction-independent values', () => {
    const minimizeAccepted = decodeExperimentResult({ ...experimentBase, kind: 'accepted', metric: 9, candidateCommit: SHA_B, previousBest: 10 }, 10_000)
    const maximizeAccepted = decodeExperimentResult({ ...experimentBase, kind: 'accepted', metric: 11, candidateCommit: SHA_B, previousBest: 10 }, 10_000)
    const minimizeTie = decodeExperimentResult({ ...experimentBase, kind: 'rejected', metric: 10, candidateCommit: SHA_B, currentBest: 10 }, 10_000)
    const maximizeTie = decodeExperimentResult({ ...experimentBase, kind: 'rejected', metric: 10, candidateCommit: SHA_B, currentBest: 10 }, 10_000)

    expect(minimizeAccepted.metric).toBeLessThan(minimizeAccepted.previousBest)
    expect(maximizeAccepted.metric).toBeGreaterThan(maximizeAccepted.previousBest)
    expect(minimizeTie.metric).toBe(minimizeTie.currentBest)
    expect(maximizeTie.metric).toBe(maximizeTie.currentBest)
  })

  it('rejects non-finite metrics, non-full SHAs, and unknown nested or top-level keys', () => {
    expect(() => decodeExperimentResult({ ...experimentBase, kind: 'baseline-measured', metric: Infinity, commit: SHA_A }, 10_000)).toThrow(/finite/)
    expect(() => decodeExperimentResult({ ...experimentBase, parentCommit: 'deadbeef', kind: 'baseline-measured', metric: 1, commit: SHA_A }, 10_000)).toThrow(/full lowercase commit SHA/)
    expect(() => decodeExperimentResult({ ...experimentBase, kind: 'accepted', metric: 1, candidateCommit: SHA_B, previousBest: 2, extra: true }, 10_000)).toThrow(/unexpected keys/)
    expect(() => decodeExperimentResult({ ...experimentBase, artifacts: [{ ...artifact, extra: true }], kind: 'baseline-measured', metric: 1, commit: SHA_A }, 10_000)).toThrow(/unexpected keys/)
  })
})

describe('configuration and policy normalization', () => {
  it('normalizes omitted defaults down to configured deployment caps', () => {
    const config = resolveConfig({ maxExperiments: 7, maxTimeoutMs: 8_000 })
    expect(config.defaultMaxExperiments).toBe(7)
    expect(config.defaultTimeoutMs).toBe(8_000)

    const policy = normalizeRunPolicy(input(), config, '/caller')
    expect(policy.maxExperiments).toBe(7)
    expect(policy.timeoutMs).toBe(8_000)
    expect(policy.mode).toBe('background')
  })

  it('rejects explicit default or run-policy escalation above deployment caps', () => {
    expect(() => resolveConfig({ maxExperiments: 7, defaultMaxExperiments: DEFAULT_CONFIG.defaultMaxExperiments })).toThrow(/defaultMaxExperiments/)
    expect(() => resolveConfig({ maxTimeoutMs: 8_000, defaultTimeoutMs: DEFAULT_CONFIG.defaultTimeoutMs })).toThrow(/defaultTimeoutMs/)
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

  it('returns a deeply immutable, deduplicated and key-stable snapshot', () => {
    const source = input({
      constraints: ['same', 'same'],
      mutable_globs: ['src/**', 'src/**'],
      environment: { ZED: 'last', ALPHA: 'first' },
    })
    const policy = normalizeRunPolicy(source, resolveConfig(), '/caller')
    expect(policy.constraints).toEqual(['same'])
    expect(policy.mutableGlobs).toEqual(['src/**'])
    expect(Object.keys(policy.environment)).toEqual(['ALPHA', 'ZED'])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.evaluation)).toBe(true)
    expect(Object.isFrozen(policy.environment)).toBe(true)
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

    const experiment = decodeExperimentResult({ ...experimentBase, kind: 'accepted', metric: 1.25, candidateCommit: SHA_B, previousBest: 1.5 }, 10_000)
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
