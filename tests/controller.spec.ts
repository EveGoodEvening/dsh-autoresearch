import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { resolveConfig, type Config } from '../src/config.ts'
import { AutoresearchRunController, type AutoresearchRunReady } from '../src/controller.ts'
import { acquireControllerClaim, currentControllerProcessIdentity, GitBoundaryError, releaseControllerClaim } from '../src/git.ts'

import { DurableTracker, TRACKER_SCHEMA_VERSION } from '../src/tracker.ts'
import { sweepRepositoryRetention } from '../src/retention.ts'
import { evaluatorEvaluationSha256, freezeEvaluatorProvenanceFromManifest } from '../src/evaluator.ts'
import { decodeRunResult, EVALUATOR_CONTRACT_GENERATION, type RunDurableState } from '../src/types.ts'
const evaluatorRegistration = { id: 'judge', command: 'fake-evaluator', args: [], metricName: 'score', metricDirection: 'minimize' as const, metricParserVersion: 'final-line-json-v1' as const, evaluatorFiles: ['evaluate.mjs'] }
const DOWNGRADE_RESEARCH_MEMORY = 'DROP TRIGGER experiments_annotation_immutable; ALTER TABLE experiments DROP COLUMN host_facts_json; ALTER TABLE experiments DROP COLUMN annotation_json;'
const input = {
  repository: '.', run_tag: 'controller-test', evaluator_id: 'judge', objective: 'improve score', mutable_globs: ['src/**'],
  max_experiments: 2, mode: 'foreground' as const,
}
const controllerConfig = () => resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] })

function parent(): Agent {
  return { id: 'parent', session: { header: { id: 'session', cwd: process.cwd() } } } as unknown as Agent
}

describe('exclusive autoresearch controller contract', () => {
  it('performs no repository, tracker, child, or evaluator effect during construction', () => {
    const ctx = new Proxy({}, { get: vi.fn(() => { throw new Error('constructor touched runtime service') }) }) as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    expect(controller.ready).toBeInstanceOf(Promise)
  })

  it('memoizes the single state-machine execution', async () => {
    const resolveExecutable = vi.fn(async () => { throw new Error('discovery stopped') })
    const ctx = { subprocess: { resolveExecutable } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    const first = controller.run()
    const second = controller.run()
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('discovery stopped')
    await expect(controller.ready).rejects.toThrow('discovery stopped')
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown evaluator id before Git discovery or any mutation', async () => {
    const resolveExecutable = vi.fn()
    const ctx = { subprocess: { resolveExecutable }, agents: { create: vi.fn() } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, evaluator_id: 'unknown' }, parent: parent(), signal: new AbortController().signal })
    await expect(controller.run()).rejects.toThrow('unknown evaluator registration id "unknown"')
    expect(resolveExecutable).not.toHaveBeenCalled()
  })

  it.each(['../escape', '/absolute', 'nested/component', 'nested\\component'])(
    'rejects unsafe resume id %s before Git discovery, tracker access, or retention',
    async resumeRunId => {
      const resolveExecutable = vi.fn()
      const trackerOpen = vi.spyOn(DurableTracker, 'openReadOnly')
      const ctx = { subprocess: { resolveExecutable } } as unknown as Context
      const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input: { ...input, run_tag: undefined, evaluator_id: undefined, resume_run_id: resumeRunId } as never, parent: parent(), signal: new AbortController().signal })
      await expect(controller.run()).rejects.toThrow(/canonical UUID v4/)
      expect(resolveExecutable).not.toHaveBeenCalled()
      expect(trackerOpen).not.toHaveBeenCalled()
      trackerOpen.mockRestore()
    },
  )

  it('rejects a symlinked canonical resume directory before tracker snapshot access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-resume-layout-'))
    const outside = mkdtempSync(join(tmpdir(), 'autoresearch-resume-outside-'))
    const runId = '00000000-0000-4000-8000-000000000000'
    const stateRoot = join(root, '.git', 'state')
    mkdirSync(join(stateRoot, 'runs'), { recursive: true, mode: 0o700 })
    symlinkSync(outside, join(stateRoot, 'runs', runId), 'dir')
    const trackerOpen = vi.spyOn(DurableTracker, 'openReadOnly')
    const discovery = { repository: root, callerCwd: root, gitCommonDir: join(root, '.git'), repositoryId: 'repo', startCommit: 'a'.repeat(40) }
    const controller = new AutoresearchRunController({} as Context, {
      config: resolveConfig({ stateRoot: 'state', evaluatorRegistrations: [evaluatorRegistration] }),
      input: { repository: root, resume_run_id: runId, objective: input.objective, mutable_globs: input.mutable_globs, mode: 'foreground' },
      parent: parent(), signal: new AbortController().signal,
      repositoryPreflight: { discovery, gitExecutable: 'git', gitOptions: { timeoutMs: 1_000, graceMs: 10, maxStdoutBytes: 1_000, maxStderrBytes: 1_000 } },
    })
    try {
      await expect(controller.run()).rejects.toThrow(/unsafe state directory/)
      expect(trackerOpen).not.toHaveBeenCalled()
    } finally {
      trackerOpen.mockRestore()
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('promptly aborts cancellation while pre-tracker executable discovery is held open', async () => {
    let entered!: () => void
    const discoveryEntered = new Promise<void>(resolve => { entered = resolve })
    const create = vi.fn()
    const resolveExecutable = vi.fn((_command: string, _env: unknown, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      entered()
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const ctx = { subprocess: { resolveExecutable }, agents: { create } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    const running = controller.run()
    await discoveryEntered
    controller.cancel('operator stop')
    await expect(running).rejects.toThrow('operator stop')
    await expect(controller.ready).rejects.toThrow('operator stop')
    await controller.dispose()
    expect(create).not.toHaveBeenCalled()
  })

  it('disposes promptly while non-cooperative preparation remains pending', async () => {
    let entered!: () => void
    const discoveryEntered = new Promise<void>(resolve => { entered = resolve })
    const resolveExecutable = vi.fn(() => new Promise<string>(() => { entered() }))
    const ctx = { subprocess: { resolveExecutable }, agents: { create: vi.fn() } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    const preparing = controller.prepare('job-1')
    void preparing.catch(() => undefined)
    await discoveryEntered
    await controller.dispose()
    await expect(controller.ready).rejects.toThrow('disposed before start')
    expect(resolveExecutable).toHaveBeenCalledOnce()
  })

  it('makes cancellation idempotent before initialization and never allocates a child', async () => {
    const resolveExecutable = vi.fn(async () => '/usr/bin/git')
    const create = vi.fn()
    const ctx = { subprocess: { resolveExecutable }, agents: { create } } as unknown as Context
    const signal = new AbortController()
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: signal.signal })
    controller.cancel('operator stop')
    controller.cancel('later reason must not replace the first')
    await expect(controller.run()).rejects.toThrow()
    await expect(controller.ready).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('disposal before run is quiescent and does not touch runtime services', async () => {
    const touched = vi.fn()
    const ctx = new Proxy({}, { get: () => { touched(); return undefined } }) as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    await controller.dispose()
    await expect(controller.ready).rejects.toThrow('disposed before start')
    expect(touched).not.toHaveBeenCalled()
  })

  it('records candidate commit lineage exactly once before evaluation', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-candidate-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite'))
      const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.createExperiment({ experimentId: 'candidate-1', runId: 'run', ordinal: 1, kind: 'candidate', parentCommit: sha, command: 'node', args: [] })
      const candidate = 'd'.repeat(40)
      tracker.recordCandidateCommit('candidate-1', candidate)
      tracker.recordCandidateCommit('candidate-1', candidate)
      expect(tracker.database.prepare('SELECT candidate_commit FROM experiments WHERE experiment_id = ?').get('candidate-1')?.['candidate_commit']).toBe(candidate)
      expect(() => tracker.recordCandidateCommit('candidate-1', 'e'.repeat(40))).toThrow(/conflicts/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('persists a terminal blocked result without releasing an uncertain evaluator lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-blocked-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite'))
      const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.acquireActiveLock('run', 'repo', 'tag')
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.createAttemptIntent({ attemptId: 'attempt', runId: 'run', experimentId: 'baseline', ordinal: 1 }, { provenanceSha256: 'c'.repeat(64) })
      tracker.commitTerminalExperiment('baseline', 'crashed', { failureCode: 'signal', failureMessage: 'provider ownership lost' })
      tracker.transitionRun('run', 'blocked', { blockedCode: 'attempt-uncertain', terminalReason: 'descendant survival is uncertain', quiescent: false })
      expect(tracker.recoveryState('run')).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false })
      expect(() => tracker.releaseActiveLock('run')).toThrow(/quiescence/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('commits a successful baseline using the accepted-state fact contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-baseline-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.commitTerminalExperiment('baseline', 'accepted', { metric: 1, decision: 'accept' })
      tracker.transitionRun('run', 'ready', { best: { metric: 1, commit: sha, experimentId: 'baseline' } })
      expect(tracker.getRun('run')).toMatchObject({ state: 'ready', best_metric: 1 })
      expect(tracker.database.prepare('SELECT state, metric, exit_code FROM experiments WHERE experiment_id = ?').get('baseline')).toMatchObject({ state: 'accepted', metric: 1, exit_code: null })
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('atomically creates and prepares one candidate without a ready-state fault window', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-prepare-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running'); tracker.transitionRun('run', 'ready', { best: { metric: 1, commit: sha, experimentId: 'baseline' } })
      tracker.prepareCandidate({ experimentId: 'candidate-1', runId: 'run', ordinal: 1, kind: 'candidate', parentCommit: sha, command: 'node', args: [], annotation: { trust: 'untrusted-child-annotation', hypothesis: 'test hypothesis', intendedEdits: ['src/code.ts'], implementationSummary: 'test summary' } }, { intent: { kind: 'candidate-snapshot', experimentId: 'candidate-1' } })
      expect(tracker.getRun('run')?.['state']).toBe('candidate-prepared')
      expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('candidate-1')?.['state']).toBe('baseline-pending')
      expect(() => tracker.prepareCandidate({ experimentId: 'candidate-2', runId: 'run', ordinal: 2, kind: 'candidate', parentCommit: sha, command: 'node', args: [], annotation: { trust: 'untrusted-child-annotation', hypothesis: 'test hypothesis', intendedEdits: ['src/code.ts'], implementationSummary: 'test summary' } }, {})).toThrow(/ready run/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const cancellationPath: Readonly<Record<Exclude<RunDurableState, 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed' | 'cancelled'>, readonly RunDurableState[]>> = {
    initializing: [],
    'baseline-running': ['baseline-running'],
    ready: ['baseline-running', 'ready'],
    'candidate-prepared': ['baseline-running', 'ready', 'candidate-prepared'],
    'candidate-running': ['baseline-running', 'ready', 'candidate-prepared', 'candidate-running'],
    deciding: ['baseline-running', 'ready', 'candidate-prepared', 'candidate-running', 'deciding'],
  }
  it.each(Object.keys(cancellationPath) as Array<keyof typeof cancellationPath>)('derives cancelled lastState only after auditing the complete canonical %s lineage', origin => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-cancellation-origin-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      for (const state of cancellationPath[origin]) tracker.transitionRun('run', state)
      tracker.transitionRun('run', 'cancelled', { terminalReason: 'operator stop', quiescent: true })
      expect(tracker.cancellationOrigin('run')).toBe(origin)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('derives cancelled lastState across canonical interleaved experiment and attempt transitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-cancellation-interleaved-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run', experimentId: 'baseline', ordinal: 1 }, { kind: 'spawn' })
      tracker.recordAttemptOutcome('attempt-1', { facts: { exitedAt: 'now', exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true }, artifacts: [], result: { kind: 'measured', metric: 1 } })
      tracker.transitionExperiment('baseline', 'accepted', { metric: 1, decision: 'accept' })
      tracker.transitionRun('run', 'cancelled', { terminalReason: 'operator stop', quiescent: true })
      expect(tracker.listTransitions('run').map(row => [row['sequence'], row['scope'], row['experiment_id']])).toEqual([
        [1, 'run', null],
        [2, 'run', null],
        [3, 'experiment', 'baseline'],
        [4, 'experiment', 'baseline'],
        [5, 'run', 'baseline'],
        [6, 'experiment', 'baseline'],
        [7, 'run', null],
      ])
      expect(tracker.cancellationOrigin('run')).toBe('baseline-running')
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['deleted-interleaved-row', 'starts-above-one', 'post-cancellation-row'] as const)('rejects globally incomplete cancellation history when it %s', fault => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-cancellation-global-history-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run', experimentId: 'baseline', ordinal: 1 }, { kind: 'spawn' })
      tracker.recordAttemptOutcome('attempt-1', { facts: { exitedAt: 'now', exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true }, artifacts: [], result: { kind: 'measured', metric: 1 } })
      tracker.transitionExperiment('baseline', 'accepted', { metric: 1, decision: 'accept' })
      tracker.transitionRun('run', 'cancelled', { terminalReason: 'operator stop', quiescent: true })
      if (fault === 'deleted-interleaved-row') tracker.database.prepare("DELETE FROM transitions WHERE transition_id = (SELECT transition_id FROM transitions WHERE run_id = 'run' AND scope = 'experiment' ORDER BY sequence LIMIT 1)").run()
      else if (fault === 'starts-above-one') tracker.database.prepare("UPDATE transitions SET sequence = sequence + 100, transition_id = run_id || ':' || (sequence + 100) WHERE run_id = 'run'").run()
      else {
        const final = tracker.listTransitions('run').at(-1)!
        const sequence = Number(final['sequence']) + 1
        tracker.database.prepare("INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES (?, 'run', 'baseline', ?, 'experiment', 'running', 'running', NULL, NULL, ?)").run(`run:${sequence}`, sequence, final['created_at'])
      }
      expect(() => tracker.cancellationOrigin('run')).toThrow()
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each((Object.keys(cancellationPath) as Array<keyof typeof cancellationPath>).filter(origin => origin !== 'initializing').flatMap(origin => ['missing-creation', 'malformed-creation', 'duplicate-creation', 'gap', 'disconnected', 'impossible-edge', 'noncanonical-id'].map(fault => [origin, fault] as const)))('rejects %s cancellation lineage with %s corruption', (origin, fault) => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-cancellation-corruption-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo/.git', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      for (const state of cancellationPath[origin]) tracker.transitionRun('run', state)
      tracker.transitionRun('run', 'cancelled', { terminalReason: 'operator stop', quiescent: true })
      const creation = tracker.database.prepare("SELECT * FROM transitions WHERE run_id = 'run' AND sequence = 1").get()!
      const final = tracker.database.prepare("SELECT * FROM transitions WHERE run_id = 'run' AND to_state = 'cancelled'").get()!
      if (fault === 'missing-creation') tracker.database.prepare('DELETE FROM transitions WHERE transition_id = ?').run(creation['transition_id'])
      else if (fault === 'malformed-creation') tracker.database.prepare("UPDATE transitions SET intent_json = '{' WHERE transition_id = ?").run(creation['transition_id'])
      else if (fault === 'duplicate-creation') tracker.database.prepare("INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES ('run:99', 'run', NULL, 99, 'run', NULL, 'initializing', '{\"kind\":\"create-run\"}', NULL, ?)").run(final['created_at'])
      else if (fault === 'gap') tracker.database.prepare('DELETE FROM transitions WHERE sequence = 2 AND run_id = ?').run('run')
      else if (fault === 'disconnected') tracker.database.prepare("UPDATE transitions SET from_state = 'initializing' WHERE transition_id = ?").run(final['transition_id'])
      else if (fault === 'impossible-edge') tracker.database.prepare("UPDATE transitions SET to_state = 'candidate-running' WHERE sequence = 2 AND run_id = ?").run('run')
      else tracker.database.prepare("UPDATE transitions SET transition_id = 'forged' WHERE transition_id = ?").run(final['transition_id'])
      expect(() => tracker.cancellationOrigin('run')).toThrow()
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['missing', 'duplicate', 'malformed', 'ambiguous'] as const)('rejects %s durable cancellation transition evidence instead of guessing lastState', fault => {
    const root = mkdtempSync(join(tmpdir(), 'autoresearch-cancellation-final-corruption-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo/.git', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'cancelled', { terminalReason: 'operator stop', quiescent: true })
      const transition = tracker.database.prepare("SELECT * FROM transitions WHERE run_id = ? AND scope = 'run' AND to_state = 'cancelled'").get('run')!
      if (fault === 'missing') tracker.database.prepare('DELETE FROM transitions WHERE transition_id = ?').run(transition['transition_id'])
      else if (fault === 'duplicate') tracker.database.prepare("INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES (?, 'run', NULL, ?, 'run', 'ready', 'cancelled', NULL, NULL, ?)").run('run:3', Number(transition['sequence']) + 1, transition['created_at'])
      else if (fault === 'malformed') tracker.database.prepare("UPDATE transitions SET from_state = 'cancelled' WHERE transition_id = ?").run(transition['transition_id'])
      else tracker.database.prepare("INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES (?, 'run', NULL, ?, 'run', 'cancelled', 'ready', NULL, NULL, ?)").run('run:3', Number(transition['sequence']) + 1, transition['created_at'])
      expect(() => tracker.cancellationOrigin('run')).toThrow()
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

class IntegrationReader implements SubprocessOutputReader {
  constructor(private readonly bytes: () => Buffer, private readonly cap: number) {}
  readFrom(fromByte: number) { const whole = this.bytes(); const retained = whole.subarray(Math.max(0, whole.length - this.cap)); return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length } }
}

class IntegrationHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly pid: number
  readonly collected
  readonly done: Promise<SubprocessOutcome>
  private exited = false
  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], outCap: number, errCap: number, afterOutcome?: () => void) {
    this.pid = child.pid ?? -1
    this.collected = { stdout: new IntegrationReader(() => Buffer.concat(stdout), outCap), stderr: new IntegrationReader(() => Buffer.concat(stderr), errCap) }
    this.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { this.exited = true; afterOutcome?.(); resolve({ exitCode, signal }) }) })
  }
  terminate(): void { if (!this.exited && this.pid > 0) try { process.kill(-this.pid, 'SIGTERM') } catch {} }
  async waitForExit(): Promise<boolean> { await this.done; return true }
}

interface EvaluationStep { stdout?: string; stderr?: string; exitCode?: number; signal?: NodeJS.Signals; hang?: boolean; edit?: (cwd: string) => void; afterOutcome?: (cwd: string) => void }
interface MatrixEvaluationStep extends EvaluationStep { spawnError?: Error; stdoutLimitBytes?: number }
type GitSpawnFailure = (spec: SubprocessSpawnSpec) => Error | undefined
class ControllerSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  evaluatorSpawns = 0
  constructor(private readonly evaluations: EvaluationStep[], private readonly onEvaluatorSpawn?: () => void, private readonly matrixEvaluations = false, private readonly gitSpawnFailure?: GitSpawnFailure) {}
  async resolveExecutable(command: string): Promise<string> { return command === 'git' ? execFileSync('which', ['git']).toString().trim() : command }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    if (spec.argv[0]?.endsWith('/git') || spec.argv[0] === 'git') {
      const failure = this.gitSpawnFailure?.(spec)
      if (failure) {
        const stdout: Buffer[] = []; const stderr: Buffer[] = []
        const child = spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(failure.message)});process.exit(1)`], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const handle = new IntegrationHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
        spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
      }
    }
    if (spec.argv[0] === 'fake-evaluator') {
      this.onEvaluatorSpawn?.()
      const step = this.evaluations[this.evaluatorSpawns++] ?? { stdout: '{"score":999}\n' }
      const matrixStep = step as MatrixEvaluationStep
      if (this.matrixEvaluations && matrixStep.spawnError) throw matrixStep.spawnError
      step.edit?.(spec.cwd)
      const script = step.hang ? 'setInterval(() => {}, 1000)' : step.signal ? `process.kill(process.pid, ${JSON.stringify(step.signal)})` : `process.stdout.write(${JSON.stringify(step.stdout ?? '')});process.stderr.write(${JSON.stringify(step.stderr ?? '')});process.exit(${step.exitCode ?? 0})`
      const afterOutcome = step.afterOutcome === undefined ? undefined : () => step.afterOutcome!(spec.cwd)
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      const child = spawn(process.execPath, ['-e', script], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      const stdoutCap = this.matrixEvaluations && matrixStep.stdoutLimitBytes !== undefined ? matrixStep.stdoutLimitBytes : typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0
      const handle = new IntegrationHandle(child, stdout, stderr, stdoutCap, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0, afterOutcome)
      spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
    }
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: [typeof spec.stdio.stdin === 'object' ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const handle = new IntegrationHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
    spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
  }
}

interface ControllerFixture { root: string; ctx: Context; parent: Agent; subprocess: ControllerSubprocess; creates: CreateAgentOptions[]; order: string[]; trackerPath: () => string; liveCount: () => number }
interface ProposalLifecycle { afterReport?: (worktree: string) => Promise<void> | void; dispose?: () => Promise<void> | void }
interface MatrixFixtureOptions { capturePrompts?: string[]; blockerClaim?: string | null; evaluatorFailures?: boolean; gitSpawnFailure?: GitSpawnFailure }
function controllerFixture(evaluations: EvaluationStep[], edits: Array<(worktree: string, ordinal: number) => void> = [], lifecycle: ProposalLifecycle = {}, matrix: MatrixFixtureOptions = {}): ControllerFixture {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-controller-e2e-'))
  execFileSync('git', ['init', '-b', 'main', root]); execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  mkdirSync(join(root, 'src', 'drift-cwd'), { recursive: true }); writeFileSync(join(root, 'src', 'code.ts'), 'export const n = 1\n'); writeFileSync(join(root, 'src', 'drift-cwd', '.gitkeep'), ''); writeFileSync(join(root, 'evaluate.mjs'), '// frozen evaluator identity\n')
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  const creates: CreateAgentOptions[] = []; const order: string[] = []; const subprocess = new ControllerSubprocess(evaluations, () => order.push('evaluator-spawn'), matrix.evaluatorFailures === true, matrix.gitSpawnFailure); const live = new Map<string, Agent>(); let lastTracker = ''
  const parentCtx = { get(name: string) { if (name === 'agentPresets') return { composedPreset: () => 'preset' }; if (name === 'sandboxPolicy') return { overrideOf: () => 'workspace-write' }; if (name === 'approval') return {}; return undefined }, effect(execute: () => () => Promise<void>) { const cleanup = execute(); let released = false; return async () => { if (!released) { released = true; await cleanup() } } } } as unknown as Context
  const parentAgent = { id: SessionId('parent'), options: { provider: 'provider', model: 'model', maxTokens: 123 }, session: { header: { id: SessionId('parent-session'), cwd: root, delegationDepth: 0 }, append: vi.fn() }, ctx: parentCtx } as unknown as Agent
  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      creates.push(options); order.push(`child-${creates.length}-create`); const tools = new Map<string, ToolDefinition>(); const listeners: Array<(execution: { name: string }, result: Readonly<ToolExecutionResult>) => void> = []
      const childCtx = { agent: undefined as Agent | undefined, get: (name: string) => name === 'agentPresets' ? { composeFrom: vi.fn() } : undefined, tools: { restrict: () => () => undefined, presentAs: () => () => undefined, register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => undefined }, guard: () => () => undefined }, systemPrompt: { context: () => () => undefined, section: () => () => undefined }, on: (name: string, listener: (execution: { name: string }, result: Readonly<ToolExecutionResult>) => void) => { if (name === 'tools/result') listeners.push(listener); return () => undefined } } as unknown as Context
      let prompt = ''; const child = { id: options.sessionId, options: options.agentOptions ?? {}, session: { header: { id: options.sessionId, ...options.meta }, append: vi.fn() }, ctx: childCtx, status: 'idle', cancel: vi.fn(), followup(message: { content: Array<{ text?: string }> }) { prompt = message.content[0]?.text ?? ''; matrix.capturePrompts?.push(prompt) }, async whenIdle() { const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { identity: { runId: string; experimentId: string; ordinal: number; nonce: string }; workspace: { worktree: string } }; edits[payload.identity.ordinal - 1]?.(payload.workspace.worktree, payload.identity.ordinal); const tool = tools.get('autoresearch_report')!; const value = await tool.execute({ ...payload.identity, hypothesis: 'candidate', intendedEdits: ['src/code.ts'], implementationSummary: 'changed code', blockerClaim: matrix.blockerClaim ?? null }, { agent: child, concludeTurn: vi.fn() } as never); listeners.forEach(listener => listener({ name: tool.name }, { isError: false, value })); await lifecycle.afterReport?.(payload.workspace.worktree) } } as unknown as Agent
      childCtx.agent = child; await options.setup?.(childCtx); live.set(String(options.sessionId), child)
      return { agent: child, dispose: async () => { order.push(`child-${creates.length}-dispose-start`); await lifecycle.dispose?.(); live.delete(String(options.sessionId)); order.push(`child-${creates.length}-dispose-end`) } }
    }, get(id: SessionId) { return live.get(String(id)) },
  }
  const ctx = Object.assign(parentCtx as unknown as Record<string, unknown>, { subprocess, agents, jobs: { list: () => [] as JobSnapshot[] } }) as unknown as Context
  parentAgent.ctx = ctx
  return { root, ctx, parent: parentAgent, subprocess, creates, order, trackerPath: () => lastTracker, liveCount: () => live.size }
}
function matrixControllerFixture(evaluations: MatrixEvaluationStep[], edits: Array<(worktree: string, ordinal: number) => void> = [], options: Omit<MatrixFixtureOptions, 'capturePrompts' | 'evaluatorFailures'> = {}) {
  const prompts: string[] = []
  return { fixture: controllerFixture(evaluations, edits, {}, { ...options, capturePrompts: prompts, evaluatorFailures: true }), prompts }
}

async function runControllerCase(f: ControllerFixture, overrides: Partial<typeof input> & Record<string, unknown> = {}, configOverrides: Config = {}) {
  const controller = createCaseController(f, overrides, undefined, configOverrides)
  const result = await controller.run(); const ready = await controller.ready; return { result, ready, tracker: DurableTracker.open(ready.tracker) }
}

function createCaseController(f: ControllerFixture, overrides: Partial<typeof input> & Record<string, unknown> = {}, resumeRunId?: string, configOverrides: Config = {}) {
  const { run_tag: _runTag, evaluator_id: _evaluatorId, ...baseInput } = input
  const { metric_direction: hostDirection, ...toolOverrides } = overrides
  const identity = resumeRunId ? { resume_run_id: resumeRunId } : { run_tag: input.run_tag, evaluator_id: input.evaluator_id }
  const registration = { ...evaluatorRegistration, metricDirection: hostDirection === 'maximize' ? 'maximize' as const : 'minimize' as const }
  return new AutoresearchRunController(f.ctx, {
    config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [registration], ...configOverrides }),
    input: { ...baseInput, ...identity, repository: f.root, mutable_globs: ['src/**'], ...toolOverrides } as never,
    parent: f.parent,
    signal: new AbortController().signal,
  })
}

function candidateAuditCommits(root: string, runId: string): string[] {
  return execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(objectname)', `refs/autoresearch/runs/${runId}/candidates/`]).toString().trim().split('\n').filter(Boolean)
}

function seedImmutableEvidence(database: DatabaseSync, triggerNames: readonly string[], mutation: () => void): void {
  const triggers = triggerNames.map(name => {
    const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.['sql']
    if (typeof sql !== 'string') throw new Error(`canonical trigger ${name} is missing`)
    return { name, sql }
  })
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`)
    mutation()
    for (const trigger of triggers) database.exec(trigger.sql)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function controllerClaims(gitCommonDir: string, runId: string): unknown[] {
  const authority = new DatabaseSync(join(gitCommonDir, 'dsh-autoresearch-locks.sqlite'), { readOnly: true })
  try { return authority.prepare('SELECT * FROM controller_claims WHERE run_id = ? ORDER BY owner_id').all(runId) }
  finally { authority.close() }
}

function registrationResumeEffects(f: ControllerFixture, ready: AutoresearchRunReady, gitCommonDir: string, transitionCount: number, authorityBytesMustRemainUnchanged = true) {
  const authorityPath = join(gitCommonDir, 'dsh-autoresearch-locks.sqlite')
  const before = {
    tracker: readFileSync(ready.tracker),
    claims: controllerClaims(gitCommonDir, ready.runId),
    authority: authorityBytesMustRemainUnchanged ? readFileSync(authorityPath) : undefined,
    head: execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']),
    refs: execFileSync('git', ['-C', f.root, 'show-ref']),
    status: execFileSync('git', ['-C', ready.worktree, 'status', '--porcelain=v1']),
    evaluatorSpawns: f.subprocess.evaluatorSpawns,
    childCount: f.creates.length,
  }
  expect(before.claims).toEqual([])
  return () => {
    expect(readFileSync(ready.tracker)).toEqual(before.tracker)
    const inspection = DurableTracker.openReadOnly(ready.tracker)
    expect(inspection.listTransitions(ready.runId)).toHaveLength(transitionCount)
    inspection.close()
    expect(controllerClaims(gitCommonDir, ready.runId)).toEqual(before.claims)
    if (before.authority !== undefined) expect(readFileSync(authorityPath)).toEqual(before.authority)
    expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD'])).toEqual(before.head)
    expect(execFileSync('git', ['-C', f.root, 'show-ref'])).toEqual(before.refs)
    expect(execFileSync('git', ['-C', ready.worktree, 'status', '--porcelain=v1'])).toEqual(before.status)
    expect(f.subprocess.evaluatorSpawns).toBe(before.evaluatorSpawns)
    expect(f.creates).toHaveLength(before.childCount)
  }
}

describe('controller real Git/SQLite outcomes', () => {
  it('activates Host registration authority and atomically persists its identity', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const controller = createCaseController(f)
    try {
      const ready = await controller.prepare()
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare('SELECT contract_generation, evaluator_id FROM run_registrations WHERE run_id = ?').get(ready.runId)).toEqual({ contract_generation: EVALUATOR_CONTRACT_GENERATION, evaluator_id: 'judge' })
      expect(String(tracker.getRun(ready.runId)?.['policy_json'])).toContain('fake-evaluator')
      tracker.close()
    } finally {
      await controller.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('rejects fresh external and symlink-escape targets before target effects', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }]); const external = controllerFixture([{ stdout: '{"score":1}\n' }]); const alias = join(f.root, 'external-alias'); symlinkSync(external.root, alias)
    try {
      for (const repository of [external.root, alias]) {
        const discoveryStart = f.subprocess.specs.length
        const controller = createCaseController(f, { repository })
        await expect(controller.run()).rejects.toMatchObject({ code: 'repository-target-outside-parent' })
        await expect(controller.ready).rejects.toMatchObject({ code: 'repository-target-outside-parent' })
        expect(f.subprocess.specs.slice(discoveryStart).every(spec => spec.cwd === f.root)).toBe(true)
        expect(f.creates).toHaveLength(0)
        expect(existsSync(join(external.root, '.git', '.autoresearch-test'))).toBe(false)
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(external.root, { recursive: true, force: true }) }
  })

  it('applies the same containment before resume tracker access', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }]); const external = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = createCaseController(f, { max_experiments: 1, target: 1 }); const ready = await first.prepare(); await first.dispose()
      const trackerBytes = readFileSync(ready.tracker); const discoveryStart = f.subprocess.specs.length; const creates = f.creates.length
      const resumed = createCaseController(f, { repository: external.root }, ready.runId)
      await expect(resumed.run()).rejects.toMatchObject({ code: 'repository-target-outside-parent' })
      expect(readFileSync(ready.tracker)).toEqual(trackerBytes)
      expect(f.subprocess.specs.slice(discoveryStart).every(spec => spec.cwd === f.root)).toBe(true)
      expect(f.creates).toHaveLength(creates)
      expect(existsSync(join(external.root, '.git', '.autoresearch-test'))).toBe(false)
    } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(external.root, { recursive: true, force: true }) }
  })

  it('blocks terminal resume on corrupt durable registration before spawn or mutation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      seedImmutableEvidence(first.tracker.database, ['run_registrations_immutable'], () => {
        first.tracker.database.prepare('UPDATE run_registrations SET registration_json = ? WHERE run_id = ?').run('{malformed', first.ready.runId)
      })
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      first.tracker.close()
      const resumed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()
      expect(resumed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'registration-corrupt' })] })
      const tracker = DurableTracker.open(first.ready.tracker)
      expect(tracker.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['command', evaluatorRegistration, { ...evaluatorRegistration, command: 'changed-evaluator' }],
    ['cwd', { ...evaluatorRegistration, cwd: 'src' }, { ...evaluatorRegistration, cwd: 'src/drift-cwd' }],
    ['environment value', { ...evaluatorRegistration, environment: { AUTHORITY_TOKEN: 'current' } }, { ...evaluatorRegistration, environment: { AUTHORITY_TOKEN: 'changed' } }],
  ] as const)('rejects nonterminal resume when the selected Host registration drifts in %s before writable effects', async (_field, currentRegistration, changedRegistration) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = createCaseController(f, { max_experiments: 1, target: 1 }, undefined, { evaluatorRegistrations: [currentRegistration] })
      const ready = await first.prepare()
      await first.dispose()
      const seeded = DurableTracker.open(ready.tracker)
      const run = seeded.getRun(ready.runId)!
      expect(run['state']).toBe('initializing')
      expect(seeded.database.prepare('SELECT contract_generation, evaluator_id FROM run_registrations WHERE run_id = ?').get(ready.runId)).toEqual({ contract_generation: EVALUATOR_CONTRACT_GENERATION, evaluator_id: 'judge' })
      const transitionCount = seeded.listTransitions(ready.runId).length
      seeded.close()
      const assertNoEffects = registrationResumeEffects(f, ready, String(run['git_common_dir']), transitionCount)

      const resumed = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [changedRegistration] }).run()

      expect(resumed).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      assertNoEffects()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([
    ['command', evaluatorRegistration, { ...evaluatorRegistration, command: 'changed-evaluator' }],
    ['cwd', { ...evaluatorRegistration, cwd: 'src' }, { ...evaluatorRegistration, cwd: 'src/drift-cwd' }],
    ['environment value', { ...evaluatorRegistration, environment: { AUTHORITY_TOKEN: 'current' } }, { ...evaluatorRegistration, environment: { AUTHORITY_TOKEN: 'changed' } }],
  ] as const)('rejects terminal replay when the selected Host registration drifts in %s before writable effects', async (_field, currentRegistration, changedRegistration) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 }, { evaluatorRegistrations: [currentRegistration] })
      const run = first.tracker.getRun(first.ready.runId)!
      expect(first.tracker.database.prepare('SELECT contract_generation, evaluator_id FROM run_registrations WHERE run_id = ?').get(first.ready.runId)).toEqual({ contract_generation: EVALUATOR_CONTRACT_GENERATION, evaluator_id: 'judge' })
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      first.tracker.close()
      const assertNoEffects = registrationResumeEffects(f, first.ready, String(run['git_common_dir']), transitionCount)

      const replayed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId, { evaluatorRegistrations: [changedRegistration] }).run()

      expect(replayed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      assertNoEffects()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([
    ['Host registration removal', []],
    ['args drift', [{ ...evaluatorRegistration, args: ['changed'] }]],
    ['evaluator-file declaration drift', [{ ...evaluatorRegistration, evaluatorFiles: ['evaluate.mjs', 'other.mjs'] }]],
    ['dataset declaration drift', [{ ...evaluatorRegistration, dataset: { kind: 'local' as const, files: ['dataset.json'] } }]],
  ] as const)('rejects nonterminal resume for %s without transitions, claims, Git effects, children, or evaluator spawns', async (_case, evaluatorRegistrations) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const controller = createCaseController(f, { max_experiments: 1, target: 1 })
      const ready = await controller.prepare()
      await controller.dispose()
      const seeded = DurableTracker.open(ready.tracker)
      const run = seeded.getRun(ready.runId)!
      expect(run['state']).toBe('initializing')
      const transitionCount = seeded.listTransitions(ready.runId).length
      seeded.close()
      const assertNoEffects = registrationResumeEffects(f, ready, String(run['git_common_dir']), transitionCount)

      const resumed = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [...evaluatorRegistrations] }).run()

      expect(resumed).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      assertNoEffects()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['Host registration removal', []],
    ['args drift', [{ ...evaluatorRegistration, args: ['changed'] }]],
  ] as const)('rejects terminal replay for %s without transitions, claims, Git effects, children, or evaluator spawns', async (_case, evaluatorRegistrations) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const run = first.tracker.getRun(first.ready.runId)!
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      first.tracker.close()
      const assertNoEffects = registrationResumeEffects(f, first.ready, String(run['git_common_dir']), transitionCount)

      const replayed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId, { evaluatorRegistrations: [...evaluatorRegistrations] }).run()

      expect(replayed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      assertNoEffects()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('successfully replays a terminal run with the exact Host registration without transitions, claims, Git effects, children, or an extra evaluator spawn', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const run = first.tracker.getRun(first.ready.runId)!
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      first.tracker.close()
      const assertNoEffects = registrationResumeEffects(f, first.ready, String(run['git_common_dir']), transitionCount, false)

      const replayed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()

      expect(replayed).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      assertNoEffects()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each(['nonterminal', 'terminal'] as const)('rejects semantically drifted canonical provenance before writable %s resume', async (kind) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      let ready: AutoresearchRunReady
      if (kind === 'terminal') { const completed = await runControllerCase(f, { max_experiments: 1, target: 1 }); ready = completed.ready; completed.tracker.close() }
      else { const controller = createCaseController(f, { max_experiments: 1, target: 1 }); ready = await controller.prepare(); await controller.dispose() }
      const tracker = DurableTracker.open(ready.tracker)
      const row = tracker.getRun(ready.runId)!
      const wrapper = JSON.parse(String(row['provenance_json'])) as { canonical: string; sha256: string }
      const semantic = JSON.parse(wrapper.canonical) as Record<string, unknown>
      semantic.metricName = 'tampered-score'
      wrapper.canonical = JSON.stringify(semantic)
      wrapper.sha256 = createHash('sha256').update(wrapper.canonical).digest('hex')
      seedImmutableEvidence(tracker.database, ['runs_immutable_identity'], () => {
        tracker.database.prepare('UPDATE runs SET provenance_json = ?, provenance_sha256 = ? WHERE run_id = ?').run(JSON.stringify(wrapper), wrapper.sha256, ready.runId)
      })
      const versionBefore = tracker.schemaVersion()
      const schemaBefore = tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      const claimsBefore = controllerClaims(String(row['git_common_dir']), ready.runId)
      const transitionCount = tracker.listTransitions(ready.runId).length
      tracker.close()
      const bytesBefore = readFileSync(ready.tracker)
      const walBefore = existsSync(`${ready.tracker}-wal`) ? readFileSync(`${ready.tracker}-wal`) : null
      const sidecarExistenceBefore = [`${ready.tracker}-wal`, `${ready.tracker}-shm`].map(existsSync)
      const resumed = await createCaseController(f, { max_experiments: 1, target: 1 }, ready.runId).run()
      expect(resumed).toMatchObject({ evidence: [expect.objectContaining({ code: 'provenance-mismatch' })] })
      expect(readFileSync(ready.tracker)).toEqual(bytesBefore)
      expect(existsSync(`${ready.tracker}-wal`) ? readFileSync(`${ready.tracker}-wal`) : null).toEqual(walBefore)
      expect([`${ready.tracker}-wal`, `${ready.tracker}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(ready.tracker)
      expect(inspection.schemaVersion()).toBe(versionBefore)
      expect(inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore)
      expect(inspection.listTransitions(ready.runId)).toHaveLength(transitionCount)
      inspection.close()
      expect(controllerClaims(String(row['git_common_dir']), ready.runId)).toEqual(claimsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(kind === 'terminal' ? 1 : 0)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([
    ['missing', "DELETE FROM run_registrations"],
    ['corrupt', "UPDATE run_registrations SET registration_json = '{'"],
    ['changed', "UPDATE run_registrations SET evaluator_id = 'other'"],
  ] as const)('blocks a %s current-contract registration without changing main/WAL bytes, schema version, or sidecar existence', async (_kind, mutation) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const trackerPath = first.ready.tracker
      const durableRun = first.tracker.getRun(first.ready.runId)!
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      const claimsBefore = controllerClaims(String(durableRun['git_common_dir']), first.ready.runId)
      seedImmutableEvidence(first.tracker.database, ['run_registrations_presence_monotonic', 'run_registrations_immutable'], () => {
        first.tracker.database.exec(mutation)
      })
      const versionBefore = first.tracker.schemaVersion()
      const schemaBefore = first.tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      first.tracker.close()
      const bytesBefore = readFileSync(trackerPath)
      const walBefore = existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null
      const sidecarExistenceBefore = [`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)
      const resumed = await createCaseController(f, {}, first.ready.runId).run()
      expect(resumed).toMatchObject({ evidence: [expect.objectContaining({ code: 'registration-corrupt' })] })
      expect(readFileSync(trackerPath)).toEqual(bytesBefore)
      expect(existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null).toEqual(walBefore)
      expect([`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(trackerPath)
      expect(inspection.schemaVersion()).toBe(versionBefore)
      expect(inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore)
      expect(inspection.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      inspection.close()
      expect(controllerClaims(String(durableRun['git_common_dir']), first.ready.runId)).toEqual(claimsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('blocks a current-contract terminal tracker missing registration even when its schema is labeled v6', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
      `)
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()

      expect(() => sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }))).toThrow(/current evaluator-contract run is missing its durable registration/)
      const inspection = DurableTracker.openReadOnly(first.ready.tracker)
      expect(inspection.schemaVersion()).toBe(6)
      inspection.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('migrates a supported v7 registered terminal tracker before canonical resume revalidation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        UPDATE schema_metadata SET version = 7 WHERE singleton = 1;
      `)
      first.tracker.close()

      const replay = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
      expect(migrated.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'run_registrations_presence_monotonic'").get()).toEqual({ name: 'run_registrations_presence_monotonic' })
      migrated.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('migrates a supported v7 registered cancelled tracker before canonical cancellation lineage revalidation', async () => {
    const f = controllerFixture([])
    try {
      const controller = createCaseController(f)
      const prepared = await controller.prepare('cancelled-v7-migration')
      controller.cancel('operator stop')
      const cancelled = await controller.run()
      await controller.dispose()
      expect(cancelled).toMatchObject({ status: 'cancelled', lastState: 'initializing' })
      const tracker = DurableTracker.open(prepared.tracker)
      tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        UPDATE schema_metadata SET version = 7 WHERE singleton = 1;
      `)
      tracker.close()

      const replay = await createCaseController(f, {}, prepared.runId).run()
      expect(replay).toEqual(cancelled)
      const migrated = DurableTracker.openReadOnly(prepared.tracker)
      expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
      migrated.close()
      expect(f.subprocess.evaluatorSpawns).toBe(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['registered-v7', 'legacy-v6'] as const)('migrates a supported older %s terminal tracker before retention identity revalidation', async (kind) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.prepare("UPDATE artifacts SET created_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?").run(first.ready.runId)
      if (kind === 'registered-v7') {
        first.tracker.database.exec(`
          ${DOWNGRADE_RESEARCH_MEMORY}
          DROP TRIGGER run_registrations_presence_monotonic;
          UPDATE schema_metadata SET version = 7 WHERE singleton = 1;
        `)
      } else {
        first.tracker.database.exec(`
          ${DOWNGRADE_RESEARCH_MEMORY}
          DROP TRIGGER run_registrations_presence_monotonic;
          DROP TRIGGER run_registrations_immutable;
          DROP TABLE run_registrations;
          UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
          UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
        `)
      }
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()

      const summary = sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }), undefined, new Date('2030-01-01T00:00:00.000Z'))
      expect(summary.artifactsPruned).toBe(2)
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
      expect(migrated.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'pruned' }])
      migrated.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([1, 2] as const)('starts a new run after sweeping a canonical v%s terminal tracker', async (version) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }, { stdout: '{"score":2}\n' }])
    try {
      const first = await runControllerCase(f, { run_tag: `legacy-v${version}`, max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        DROP TRIGGER attempts_immutable_outcome;
        ALTER TABLE attempts DROP COLUMN outcome_json;
        DROP TABLE schema_metadata;
        CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
        INSERT INTO schema_metadata VALUES (1, ${version}, 'legacy');
        DROP TRIGGER experiments_immutable_lineage;
        CREATE TRIGGER experiments_immutable_lineage BEFORE UPDATE OF run_id, ordinal, kind, parent_commit, candidate_commit, command, args_json, cwd ON experiments BEGIN SELECT RAISE(ABORT, 'immutable experiment lineage/evaluator'); END;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      if (version === 1) {
        first.tracker.database.exec(`
          DROP TRIGGER runs_immutable_identity;
          DROP TRIGGER experiments_immutable_lineage;
          DROP TRIGGER attempts_immutable_intent;
          ALTER TABLE runs DROP COLUMN terminal_quiescent;
        `)
      }
      first.tracker.close()

      const second = await runControllerCase(f, { run_tag: `after-v${version}`, max_experiments: 1, target: 2 })
      expect(second.result).toMatchObject({ status: 'target-reached', best: { metric: 2 } })
      second.tracker.close()
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
      migrated.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })


  it('replays a legacy terminal result canonically without mutation, ownership, cleanup, or spawn', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 }, { evaluatorRegistrations: [{ ...evaluatorRegistration, environment: { TOKEN: 'non-empty-secret' } }] })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare('UPDATE active_locks SET released_at = NULL WHERE run_id = ?').run(first.ready.runId)
      const durableRun = first.tracker.getRun(first.ready.runId)!
      const authority = new DatabaseSync(join(String(durableRun['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(durableRun['repository_id'], durableRun['run_tag'], first.ready.runId, '2026-01-01T00:00:00.000Z')
      authority.prepare('INSERT INTO controller_claims (run_id, owner_id, owner_pid, owner_start_token, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(first.ready.runId, 'legacy-owner', null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      const sharedAuthorityBefore = { lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId), claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId) }
      authority.close()
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const artifactsBefore = first.tracker.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId)
      first.tracker.close()
      expect(JSON.parse(String(durableRun['policy_json'])).environment).toEqual({ TOKEN: { sha256: createHash('sha256').update('non-empty-secret').digest('hex') } })
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const tracker = DurableTracker.openReadOnly(first.ready.tracker)
      expect(tracker.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(first.ready.runId)).toEqual({ released_at: null })
      const replayAuthority = new DatabaseSync(join(String(durableRun['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      expect({ lock: replayAuthority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId), claim: replayAuthority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId) }).toEqual(sharedAuthorityBefore)
      replayAuthority.close()
      expect(tracker.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId)).toEqual(artifactsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      expect(f.creates).toHaveLength(0)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('replays a registered terminal result without pruning under a live controller claim, then takes over a stale claim', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
      first.tracker.database.prepare('UPDATE artifacts SET created_at = ? WHERE run_id = ?').run(old, first.ready.runId)
      const run = first.tracker.getRun(first.ready.runId)!
      const authority = new DatabaseSync(join(String(run['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      const live = currentControllerProcessIdentity()
      authority.prepare('INSERT INTO controller_claims (run_id, owner_id, owner_pid, owner_start_token, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(first.ready.runId, 'live-owner', live.pid, live.startToken ?? null, old, old, old)
      authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(run['repository_id'], run['run_tag'], first.ready.runId, old)
      const liveAuthority = {
        lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId),
      }
      first.tracker.close()

      const replay = await createCaseController(f, {}, first.ready.runId, { artifactRetentionDays: 1 }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const retained = DurableTracker.openReadOnly(first.ready.tracker)
      expect(retained.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'retain' }])
      expect({
        lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId),
      }).toEqual(liveAuthority)
      retained.close()

      authority.prepare('UPDATE controller_claims SET owner_start_token = ? WHERE run_id = ?').run(live.startToken === undefined ? 'provably-stale' : `${BigInt(live.startToken) + 1n}`, first.ready.runId)
      const staleReplay = await createCaseController(f, {}, first.ready.runId, { artifactRetentionDays: 1 }).run()
      expect(staleReplay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const pruned = DurableTracker.openReadOnly(first.ready.tracker)
      expect(pruned.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'pruned' }])
      expect(authority.prepare('SELECT owner_id FROM controller_claims WHERE run_id = ?').get(first.ready.runId)).toBeUndefined()
      expect(authority.prepare('SELECT 1 FROM active_locks WHERE run_id = ?').get(first.ready.runId)).toBeUndefined()
      pruned.close()
      authority.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each(['missing', 'corrupt'] as const)('typed-blocks legacy terminal replay with %s retained artifact bytes without mutating durable state', async (fault) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      const artifact = first.tracker.database.prepare("SELECT experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ? AND retention = 'retain' ORDER BY kind LIMIT 1").get(first.ready.runId)!
      const artifactPath = join(first.tracker.layout.root, 'artifacts', first.ready.runId, String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`)
      first.tracker.close()
      if (fault === 'missing') unlinkSync(artifactPath)
      else writeFileSync(artifactPath, 'tampered')
      const before = readFileSync(first.ready.tracker)
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'blocked', evidence: [{ code: 'artifact-incomplete' }] })
      expect(readFileSync(first.ready.tracker)).toEqual(before)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('allows legacy terminal replay after artifact metadata is durably pruned', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare("UPDATE artifacts SET retention = 'pruned' WHERE run_id = ?").run(first.ready.runId)
      const files = first.tracker.database.prepare('SELECT experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ?').all(first.ready.runId)
      for (const artifact of files) unlinkSync(join(first.tracker.layout.root, 'artifacts', first.ready.runId, String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`))
      first.tracker.close()
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('rejects a legacy terminal tracker replacement between read-only retention classification and writable claim', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const originalOpen = DurableTracker.open.bind(DurableTracker)
    let openSpy: MockInstance | undefined
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const registrationTriggers = first.tracker.database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name IN ('run_registrations_presence_monotonic', 'run_registrations_immutable') ORDER BY name").all().map(row => String(row['sql']))
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DELETE FROM run_registrations;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
        UPDATE artifacts SET created_at = '2020-01-01T00:00:00.000Z';
      `)
      first.tracker.database.exec(registrationTriggers.join(';'))
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()
      openSpy = vi.spyOn(DurableTracker, 'open').mockImplementationOnce((path: string) => {
        const tracker = originalOpen(path)
        tracker.database.prepare("UPDATE runs SET updated_at = '2030-01-01T00:00:00.000Z' WHERE run_id = ?").run(first.ready.runId)
        return tracker
      })
      expect(() => sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }), undefined, new Date('2026-01-01T00:00:00.000Z'))).toThrow(/changed between read-only retention classification and writable open/)
      openSpy.mockRestore(); openSpy = undefined
      const inspection = DurableTracker.openReadOnly(first.ready.tracker)
      expect(inspection.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'retain' }])
      inspection.close()
    } finally {
      openSpy?.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it('rejects a pre-cutover v6 nonterminal resume without changing schema, main/WAL bytes, state, lock, or sidecar existence', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const trackerPath = first.ready.tracker
      first.tracker.database.exec(`
        ${DOWNGRADE_RESEARCH_MEMORY}
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare("UPDATE runs SET state = 'ready', terminal_quiescent = NULL WHERE run_id = ?").run(first.ready.runId)
      first.tracker.database.prepare('UPDATE active_locks SET released_at = NULL WHERE run_id = ?').run(first.ready.runId)
      const exportDirectory = join(trackerPath, '..', 'exports')
      mkdirSync(exportDirectory, { recursive: true })
      const tsvPath = join(exportDirectory, `${first.ready.runId}.tsv`)
      writeFileSync(tsvPath, 'preserve\n')
      const durableBefore = {
        version: first.tracker.schemaVersion(),
        run: first.tracker.getRun(first.ready.runId),
        lock: first.tracker.database.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        schema: first.tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        artifacts: first.tracker.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId),
        tsv: readFileSync(tsvPath),
      }
      first.tracker.close()
      const bytesBefore = readFileSync(trackerPath)
      const walBefore = existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null
      const sidecarExistenceBefore = [`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)
      sweepRepositoryRetention(String(durableBefore.run?.['git_common_dir']), '.autoresearch-test', resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] }))

      const resumed = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(resumed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'legacy-evaluator-policy-unsupported' })] })
      expect(readFileSync(trackerPath)).toEqual(bytesBefore)
      expect(existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null).toEqual(walBefore)
      expect([`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(trackerPath)
      expect({
        version: inspection.schemaVersion(),
        run: inspection.getRun(first.ready.runId),
        artifacts: inspection.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId),
        tsv: readFileSync(tsvPath),
        lock: inspection.database.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        schema: inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      }).toEqual(durableBefore)
      inspection.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['minimize', 5, 5, 'target-reached'],
    ['maximize', 5, 5, 'target-reached'],
  ] as const)('short-circuits a %s baseline target with artifacts, no child, and zero candidate budget', async (direction, metric, target, status) => {
    const f = controllerFixture([{ stdout: `{"score":${metric}}\n` }])
    try { const { result, tracker } = await runControllerCase(f, { metric_direction: direction, target, max_experiments: 1 }); expect(result).toMatchObject({ status, best: { metric }, counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } }); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('does not apply the presentation limit to canonical terminal results', async () => {
    const f = controllerFixture([{ stdout: '{"score":5}\n' }])
    try {
      const { result, tracker } = await runControllerCase(f, { target: 5, max_experiments: 1 }, { maxResultChars: 1 })
      expect(result).toMatchObject({ status: 'target-reached', best: { metric: 5 }, artifacts: expect.arrayContaining([expect.objectContaining({ kind: 'stdout' }), expect.objectContaining({ kind: 'stderr' })]) })
      expect(JSON.stringify(result).length).toBeGreaterThan(1)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('resumes across execution modes from another subdirectory after caller HEAD advances', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')])
    try {
      const initial = createCaseController(f, { repository: join(f.root, 'src'), mode: 'background', max_experiments: 1 })
      const first = await initial.run(); const ready = await initial.ready
      const tracker = DurableTracker.open(ready.tracker); const row = tracker.getRun(ready.runId)!
      const startCommit = String(row['start_commit']); const persistedPolicy = JSON.parse(String(row['policy_json'])) as Record<string, unknown>
      const provenanceSha256 = String(row['provenance_sha256'])
      const attemptProvenance = (tracker.database.prepare('SELECT spawn_intent_json FROM attempts ORDER BY ordinal').all() as Array<{ spawn_intent_json: string }>).map(attempt => { const parsed: unknown = JSON.parse(attempt.spawn_intent_json); if (!parsed || typeof parsed !== 'object' || !('provenanceSha256' in parsed)) throw new Error('attempt spawn intent lacks provenanceSha256'); return String(parsed.provenanceSha256) })
      expect(attemptProvenance).toEqual([provenanceSha256, provenanceSha256])
      tracker.close()
      expect(first.status).toBe('budget-limited')
      expect(persistedPolicy).toMatchObject({ repository: f.root, runTag: input.run_tag })
      expect(persistedPolicy).not.toHaveProperty('mode')

      const resumeDirectory = join(f.root, 'resume-cwd'); mkdirSync(resumeDirectory); writeFileSync(join(resumeDirectory, 'caller.txt'), 'caller advancement\n')
      execFileSync('git', ['-C', f.root, 'add', 'resume-cwd/caller.txt']); execFileSync('git', ['-C', f.root, 'commit', '-m', 'advance caller head'])
      expect(execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD']).toString().trim()).not.toBe(startCommit)

      const resumed = await createCaseController(f, { repository: resumeDirectory, mode: 'foreground', max_experiments: 1 }, ready.runId).run()
      expect(resumed).toEqual(first)
      expect(f.subprocess.evaluatorSpawns).toBe(2)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('persists start-commit manifest provenance when the evaluator file changes at registered-run creation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const originalCreate = DurableTracker.prototype.createRegisteredRun
    let registered: { runId: string; tracker: string; worktree: string; evaluator: Buffer } | undefined
    const createSpy = vi.spyOn(DurableTracker.prototype, 'createRegisteredRun').mockImplementation(function (record) {
      const evaluator = join(record.worktree, 'evaluate.mjs')
      registered = { runId: record.runId, tracker: this.path, worktree: record.worktree, evaluator: readFileSync(evaluator) }
      writeFileSync(evaluator, 'concurrent evaluator replacement\n')
      return originalCreate.call(this, record)
    })
    const controller = createCaseController(f, { max_experiments: 1, target: 1 })
    try {
      const [runOutcome, readyOutcome] = await Promise.allSettled([controller.run(), controller.ready])
      for (const outcome of [runOutcome, readyOutcome]) {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'fulfilled') throw new Error('dirty registered run unexpectedly continued')
        expect(outcome.reason).toBeInstanceOf(GitBoundaryError)
        expect(outcome.reason).toMatchObject({ code: 'accepted-reconcile-dirty' })
      }
      expect(f.subprocess.evaluatorSpawns).toBe(0)

      if (!registered) throw new Error('registered run was not captured')
      const tracker = DurableTracker.openReadOnly(registered.tracker)
      const row = tracker.getRun(registered.runId)!
      const registration = tracker.readRegistration(registered.runId)!
      const policy = JSON.parse(String(row['policy_json'])) as { evaluation: { command: string; args: string[]; cwd?: string }; metricName: string; metricDirection: 'minimize' | 'maximize'; environment: Record<string, string> }
      const expected = freezeEvaluatorProvenanceFromManifest({ evaluation: policy.evaluation, evaluatorFiles: registration.registration.evaluatorFiles, environment: policy.environment, metricName: policy.metricName, metricDirection: policy.metricDirection, policy: { normalizedPolicySha256: String(row['policy_sha256']), evaluationSha256: evaluatorEvaluationSha256(policy.evaluation), policy } }, registration.manifest)
      expect(row).toMatchObject({ state: 'initializing', provenance_sha256: expected.sha256 })
      expect(JSON.parse(String(row['provenance_json']))).toMatchObject({ evaluatorFileHashes: expected.evaluatorFileHashes })
      tracker.close()
    } finally {
      createSpy.mockRestore()
      if (registered && existsSync(registered.worktree)) writeFileSync(join(registered.worktree, 'evaluate.mjs'), registered.evaluator)
      await controller.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('attempts every activation cleanup phase and removes the durable partial run when cleanup phases throw', async () => {
    const f = controllerFixture([])
    const acquire = vi.spyOn(DurableTracker.prototype, 'acquireActiveLock').mockImplementation(() => { throw new Error('injected local lock failure') })
    const rollback = DurableTracker.prototype.rollbackRegisteredRunActivation
    const rollbackFault = vi.spyOn(DurableTracker.prototype, 'rollbackRegisteredRunActivation').mockImplementation(function (runId) { rollback.call(this, runId); throw new Error('injected registered-run cleanup failure') })
    const close = DurableTracker.prototype.close
    const closeFault = vi.spyOn(DurableTracker.prototype, 'close').mockImplementation(function () { close.call(this); throw new Error('injected tracker-close failure') })
    try {
      const controller = createCaseController(f)
      await expect(controller.run()).rejects.toThrow(/activation failed and 2 cleanup phase/)
      closeFault.mockRestore()
      const runsRoot = join(f.root, '.git', '.autoresearch-test', 'runs')
      const runDirectories = existsSync(runsRoot) ? readdirSync(runsRoot) : []
      expect(runDirectories).toHaveLength(1)
      const inspection = DurableTracker.openReadOnly(join(runsRoot, runDirectories[0]!, 'tracker.sqlite'))
      expect(inspection.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
      inspection.close()
      expect(execFileSync('git', ['-C', f.root, 'branch', '--list', 'autoresearch/*']).toString()).toBe('')
      expect(execFileSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain']).toString()).not.toContain('.autoresearch-test/worktrees')
    } finally {
      acquire.mockRestore(); rollbackFault.mockRestore(); closeFault.mockRestore(); rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('prepares a durable job binding, checkpoints cancellation before abort work, and starts no child or additional subprocess', async () => {
    const f = controllerFixture([])
    const close = vi.spyOn(DurableTracker.prototype, 'close')
    try {
      const controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, repository: f.root }, parent: f.parent, signal: new AbortController().signal })
      const prepared = await controller.prepare('autoresearch-7')
      const tracker = DurableTracker.open(prepared.tracker)
      expect(tracker.database.prepare("SELECT outcome_json FROM transitions WHERE run_id = ? AND outcome_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(prepared.runId)?.['outcome_json']).toContain('autoresearch-7')
      const subprocessCount = f.subprocess.specs.length
      controller.cancel('held initialization stop')
      expect(tracker.database.prepare("SELECT intent_json FROM transitions WHERE run_id = ? AND intent_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(prepared.runId)?.['intent_json']).toContain('held initialization stop')
      expect(f.creates).toHaveLength(0)
      expect(f.subprocess.specs).toHaveLength(subprocessCount)
      tracker.close()
      const fresh = await controller.run()
      expect(fresh).toMatchObject({ status: 'cancelled', lastState: 'initializing', reason: 'held initialization stop', quiescent: true })
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      const childCount = f.creates.length
      const resumed = await createCaseController(f, {}, prepared.runId).run()
      expect(resumed).toEqual(fresh)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      expect(f.creates).toHaveLength(childCount)
      const released = DurableTracker.open(prepared.tracker)
      expect(released.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(prepared.runId)?.['released_at']).not.toBeNull()
      expect(released.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(prepared.runId)?.['count']).toBe(0)
      expect(released.database.prepare("SELECT COUNT(*) AS count FROM experiments WHERE run_id = ? AND kind = 'candidate'").get(prepared.runId)?.['count']).toBe(0)
      released.close()
      await controller.dispose()
      expect(close).toHaveBeenCalled()
    } finally {
      close.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it.each(['missing-cancellation', 'duplicate-cancellation', 'malformed-cancellation', 'missing-creation', 'malformed-creation', 'duplicate-creation'] as const)('read-only blocks initializing cancellation with %s evidence before claim, recovery, retention, mutation, or spawn', async fault => {
    const f = controllerFixture([])
    try {
      const controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, repository: f.root }, parent: f.parent, signal: new AbortController().signal })
      const prepared = await controller.prepare(`corrupt-${fault}`)
      controller.cancel('terminal preflight corruption')
      await controller.run()
      await controller.dispose()
      const corrupt = DurableTracker.open(prepared.tracker)
      const cancelled = corrupt.database.prepare("SELECT * FROM transitions WHERE run_id = ? AND scope = 'run' AND to_state = 'cancelled'").get(prepared.runId)!
      if (fault === 'missing-cancellation') corrupt.database.prepare('DELETE FROM transitions WHERE transition_id = ?').run(cancelled['transition_id'])
      else if (fault === 'duplicate-cancellation') corrupt.database.prepare("INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES (?, ?, NULL, ?, 'run', 'initializing', 'cancelled', NULL, NULL, ?)").run(`duplicate-${fault}`, prepared.runId, Number(cancelled['sequence']) + 1, cancelled['created_at'])
      else if (fault === 'malformed-cancellation') corrupt.database.prepare("UPDATE transitions SET from_state = 'cancelled' WHERE transition_id = ?").run(cancelled['transition_id'])
      else if (fault === 'missing-creation') corrupt.database.prepare("DELETE FROM transitions WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing'").run(prepared.runId)
      else if (fault === 'malformed-creation') corrupt.database.prepare("UPDATE transitions SET from_state = 'cancelled' WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing'").run(prepared.runId)
      else corrupt.database.prepare("UPDATE transitions SET from_state = NULL, intent_json = (SELECT intent_json FROM transitions WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing') WHERE transition_id = (SELECT transition_id FROM transitions WHERE run_id = ? AND scope = 'run' AND from_state = 'initializing' AND to_state = 'initializing' ORDER BY sequence LIMIT 1)").run(prepared.runId, prepared.runId)
      corrupt.close()

      const authorityPath = join(f.root, '.git', 'dsh-autoresearch-locks.sqlite')
      const durableBefore = readFileSync(prepared.tracker)
      const walBefore = existsSync(`${prepared.tracker}-wal`) ? readFileSync(`${prepared.tracker}-wal`) : null
      const sidecarsBefore = [`${prepared.tracker}-wal`, `${prepared.tracker}-shm`].map(existsSync)
      const authorityBefore = readFileSync(authorityPath)
      const artifactRoot = join(dirname(prepared.tracker), 'artifacts')
      const artifactsBefore = existsSync(artifactRoot) ? readdirSync(artifactRoot, { recursive: true }).map(String).sort() : []
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      const childCount = f.creates.length

      const resumed = await createCaseController(f, {}, prepared.runId).run()
      expect(resumed).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'state-ambiguous' })] })
      expect('best' in resumed).toBe(false)
      expect(readFileSync(prepared.tracker)).toEqual(durableBefore)
      expect(existsSync(`${prepared.tracker}-wal`) ? readFileSync(`${prepared.tracker}-wal`) : null).toEqual(walBefore)
      expect([`${prepared.tracker}-wal`, `${prepared.tracker}-shm`].map(existsSync)).toEqual(sidecarsBefore)
      expect(readFileSync(authorityPath)).toEqual(authorityBefore)
      expect(existsSync(artifactRoot) ? readdirSync(artifactRoot, { recursive: true }).map(String).sort() : []).toEqual(artifactsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      expect(f.creates).toHaveLength(childCount)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['transition', 'attempt', 'artifact', 'terminal-state', 'terminal-reason', 'terminal-quiescence', 'best-facts'] as const)('rechecks terminal %s evidence after exact claim and performs no release or prune on a preflight race', async kind => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const seam = vi.spyOn(AutoresearchRunController.prototype, 'terminalResumeClaimAcquiredForTest')
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const trackerPath = first.ready.tracker; const runId = first.ready.runId
      first.tracker.close()
      let before: { lock: unknown; retention: unknown[] } | undefined
      seam.mockImplementationOnce(() => {
        const raced = DurableTracker.open(trackerPath)
        if (kind === 'transition') raced.database.prepare("UPDATE transitions SET transition_id = 'raced-transition' WHERE run_id = ? AND sequence = (SELECT MAX(sequence) FROM transitions WHERE run_id = ?)").run(runId, runId)
        else if (kind === 'attempt') raced.database.prepare('UPDATE attempts SET process_tree_quiescent = 0 WHERE run_id = ?').run(runId)
        else if (kind === 'artifact') raced.database.prepare("UPDATE artifacts SET sha256 = ? WHERE run_id = ? AND kind = 'stdout'").run('0'.repeat(64), runId)
        else if (kind === 'terminal-state') raced.database.prepare("UPDATE runs SET state = 'blocked' WHERE run_id = ?").run(runId)
        else if (kind === 'terminal-reason') raced.database.prepare("UPDATE runs SET terminal_reason = 'raced terminal reason' WHERE run_id = ?").run(runId)
        else if (kind === 'terminal-quiescence') raced.database.prepare('UPDATE runs SET terminal_quiescent = 0 WHERE run_id = ?').run(runId)
        else raced.database.prepare("UPDATE runs SET best_metric = best_metric + 1, best_commit = ?, best_experiment_id = 'raced-best' WHERE run_id = ?").run('0'.repeat(40), runId)
        before = { lock: raced.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(runId), retention: raced.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(runId) }
        raced.close()
      })
      const result = await createCaseController(f, {}, runId).run()
      expect(result).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: expect.stringMatching(/state-ambiguous|attempt-uncertain|artifact-incomplete/u) })] })
      const after = DurableTracker.openReadOnly(trackerPath)
      expect(after.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(runId)).toEqual(before?.lock)
      expect(after.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(runId)).toEqual(before?.retention)
      after.close()
    } finally { seam.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['minimize', 10, 9, 'accepted'], ['maximize', 10, 11, 'accepted'],
    ['minimize', 10, 10, 'rejected'], ['maximize', 10, 10, 'rejected'],
    ['minimize', 10, 11, 'rejected'], ['maximize', 10, 9, 'rejected'],
  ] as const)('applies strict %s decision for baseline %s candidate %s as %s', async (direction, baseline, candidate, state) => {
    const assertCandidateHead = (cwd: string) => { expect(execFileSync('git', ['-C', cwd, 'show', '-s', '--format=%s', 'HEAD']).toString().trim()).toMatch(/^autoresearch candidate /u); expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1']).toString()).toBe('') }
    const f = controllerFixture([{ stdout: `{"score":${baseline}}\n` }, { stdout: `{"score":${candidate}}\n`, edit: assertCandidateHead }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${candidate}\n`)])
    try { const { result, tracker } = await runControllerCase(f, { metric_direction: direction, max_experiments: 1 }); expect(result.status).toBe('budget-limited'); const row = tracker.database.prepare("SELECT state, decision, metric, candidate_commit FROM experiments WHERE kind = 'candidate'").get()!; expect(row).toMatchObject({ state, decision: state === 'accepted' ? 'accept' : 'reject', metric: candidate }); expect(String(row['candidate_commit'])).toMatch(/^[0-9a-f]{40}$/); expect(f.creates).toHaveLength(1); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['exit', { exitCode: 9, stderr: 'bounded exit failure' }],
    ['signal', { signal: 'SIGTERM' as const, stderr: 'bounded signal failure' }],
    ['timeout', { hang: true }],
    ['output-limit', { stdout: 'x'.repeat(256), stdoutLimitBytes: 32 }],
    ['metric-protocol', { stdout: '{"notScore":1}\n' }],
    ['spawn', { spawnError: new Error('provider refused spawn') }],
  ] as const)('continues live after proven-quiescent candidate %s failure with exact bounded accounting and handoff', async (code, failure) => {
    let acceptedBeforeSecondChild = ''
    const { fixture: f, prompts } = matrixControllerFixture(
      [{ stdout: '{"score":10}\n' }, failure, { stdout: '{"score":11}\n' }],
      [
        worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n'),
        worktree => { acceptedBeforeSecondChild = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD']).toString().trim(); writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 3\n') },
      ],
    )
    try {
      const overrides = code === 'timeout' ? { max_experiments: 2, timeout_ms: 250 } : { max_experiments: 2 }
      const { result, ready, tracker } = await runControllerCase(f, overrides)
      const startCommit = execFileSync('git', ['-C', f.root, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim()
      expect(result).toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 2, experimentsCompleted: 2, attempts: 3 }, best: { commit: startCommit, metric: 10 } })
      expect(acceptedBeforeSecondChild).toBe(startCommit)
      expect(f.creates).toHaveLength(2)
      expect(f.subprocess.evaluatorSpawns).toBe(3)
      expect(prompts[1]).toContain(`"failureCode":"${code}"`)
      expect(prompts[1]).toContain(`"code":"${code}"`)
      expect(tracker.database.prepare("SELECT ordinal,state,failure_code FROM experiments WHERE kind='candidate' ORDER BY ordinal").all()).toEqual([
        { ordinal: 1, state: code === 'timeout' ? 'timed-out' : 'crashed', failure_code: code },
        { ordinal: 2, state: 'rejected', failure_code: null },
      ])
      expect(tracker.database.prepare("SELECT ordinal,process_tree_quiescent FROM attempts WHERE experiment_id LIKE '%-candidate-%' ORDER BY experiment_id,ordinal").all()).toEqual([
        { ordinal: 1, process_tree_quiescent: 1 },
        { ordinal: 1, process_tree_quiescent: 1 },
      ])
      const failed = tracker.database.prepare("SELECT experiment_id FROM experiments WHERE kind='candidate' AND ordinal=1").get()!
      const artifactKinds = tracker.database.prepare('SELECT kind FROM artifacts WHERE experiment_id=? ORDER BY kind').all(failed['experiment_id'])
      expect(artifactKinds).toEqual(code === 'spawn' ? [] : [{ kind: 'stderr' }, { kind: 'stdout' }])
      if (code === 'spawn') {
        const attempt = tracker.database.prepare('SELECT attempt_id FROM attempts WHERE experiment_id = ?').get(failed['experiment_id'])!
        expect(existsSync(join(tracker.layout.root, 'artifacts', ready.runId, String(failed['experiment_id']), String(attempt['attempt_id'])))).toBe(false)
      }
      const candidateCommits = tracker.database.prepare("SELECT candidate_commit FROM experiments WHERE kind='candidate' ORDER BY ordinal").all().map(row => String(row['candidate_commit']))
      expect(candidateAuditCommits(f.root, ready.runId).sort()).toEqual(candidateCommits.sort())
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id=?').get(ready.runId)?.['released_at']).not.toBeNull()
      expect(controllerClaims(String(tracker.getRun(ready.runId)?.['git_common_dir']), ready.runId)).toEqual([])
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['exit', { exitCode: 9 }],
    ['signal', { signal: 'SIGTERM' as const }],
    ['timeout', { hang: true }],
    ['output-limit', { stdout: 'x'.repeat(256), stdoutLimitBytes: 32 }],
    ['metric-protocol', { stdout: 'not-json\n' }],
    ['spawn', { spawnError: new Error('provider refused spawn') }],
  ] as const)('continues %s failure idempotently after the terminal-experiment crash barrier', async (code, failure) => {
    const { fixture: f } = matrixControllerFixture(
      [{ stdout: '{"score":10}\n' }, failure, { stdout: '{"score":11}\n' }],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n'), worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 3\n')],
    )
    const transition = DurableTracker.prototype.transitionRun
    let interrupted = false
    const barrier = vi.spyOn(DurableTracker.prototype, 'transitionRun').mockImplementation(function (runId, state, facts, at) {
      if (!interrupted && state === 'deciding' && (facts?.outcome as { kind?: string } | undefined)?.kind === 'candidate-evaluation-failed') { interrupted = true; throw new Error(`candidate ${code} cleanup barrier`) }
      return transition.call(this, runId, state, facts, at)
    })
    const overrides = code === 'timeout' ? { max_experiments: 2, timeout_ms: 250 } : { max_experiments: 2 }
    try {
      const first = createCaseController(f, overrides)
      await expect(first.run()).rejects.toThrow(`candidate ${code} cleanup barrier`)
      const ready = await first.ready
      barrier.mockRestore()
      const resumed = await createCaseController(f, overrides, ready.runId).run()
      expect(resumed).toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 2, experimentsCompleted: 2, attempts: 3 } })
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare("SELECT ordinal,state,failure_code FROM experiments WHERE kind='candidate' ORDER BY ordinal").all()).toEqual([
        { ordinal: 1, state: code === 'timeout' ? 'timed-out' : 'crashed', failure_code: code },
        { ordinal: 2, state: 'rejected', failure_code: null },
      ])
      if (code === 'spawn') {
        const failed = tracker.database.prepare("SELECT experiment_id FROM experiments WHERE kind='candidate' AND ordinal=1").get()!
        const attempt = tracker.database.prepare('SELECT attempt_id FROM attempts WHERE experiment_id = ?').get(failed['experiment_id'])!
        expect(tracker.database.prepare('SELECT kind FROM artifacts WHERE attempt_id = ?').all(attempt['attempt_id'])).toEqual([])
        expect(existsSync(join(tracker.layout.root, 'artifacts', ready.runId, String(failed['experiment_id']), String(attempt['attempt_id'])))).toBe(false)
      }
      expect(await createCaseController(f, overrides, ready.runId).run()).toEqual(resumed)
      expect(f.creates).toHaveLength(2)
      expect(f.subprocess.evaluatorSpawns).toBe(3)
      tracker.close()
    } finally { barrier.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['exit', { exitCode: 9 }], ['signal', { signal: 'SIGTERM' as const }], ['timeout', { hang: true }],
    ['output-limit', { stdout: 'x'.repeat(256), stdoutLimitBytes: 32 }], ['metric-protocol', { stdout: 'not-json\n' }], ['spawn', { spawnError: new Error('provider refused spawn') }],
  ] as const)('consumes the last candidate budget on %s failure without creating a next child', async (code, failure) => {
    const { fixture: f } = matrixControllerFixture([{ stdout: '{"score":10}\n' }, failure], [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')])
    const overrides = code === 'timeout' ? { max_experiments: 1, timeout_ms: 250 } : { max_experiments: 1 }
    try {
      const { result, tracker } = await runControllerCase(f, overrides)
      expect(result).toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 1, experimentsCompleted: 1, attempts: 2 } })
      expect(f.creates).toHaveLength(1)
      expect(f.subprocess.evaluatorSpawns).toBe(2)
      expect(tracker.database.prepare("SELECT ordinal,state,failure_code FROM experiments WHERE kind='candidate'").get()).toEqual({ ordinal: 1, state: code === 'timeout' ? 'timed-out' : 'crashed', failure_code: code })
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('resumes artifact discards only under the winning controller claim and completes them after a crash', async () => {
    const { fixture: f } = matrixControllerFixture(
      [{ stdout: '{"score":10}\n' }, { spawnError: new Error('provider refused spawn') }],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
    )
    const fault = vi.spyOn(DurableTracker.prototype, 'artifactDiscardMarkedForTest').mockImplementation(() => {
      throw new Error('artifact discard crash')
    })
    try {
      const interrupted = createCaseController(f, { max_experiments: 1 })
      await expect(interrupted.run()).rejects.toThrow('artifact discard crash')
      const ready = await interrupted.ready
      fault.mockRestore()

      const ownerTracker = DurableTracker.open(ready.tracker)
      const artifactRows = ownerTracker.database.prepare("SELECT artifact_id, experiment_id, attempt_id, kind, location, retention, size_bytes FROM artifacts WHERE retention = 'discarding' ORDER BY kind").all() as Array<{ artifact_id: string; experiment_id: string; attempt_id: string; kind: string; location: string; retention: string; size_bytes: number }>
      expect(artifactRows).toHaveLength(2)
      const { experiment_id: experimentId, attempt_id: attemptId } = artifactRows[0]!
      const artifactPaths = artifactRows.map(row => join(ownerTracker.layout.root, 'artifacts', ready.runId, row.experiment_id, row.attempt_id, `${row.kind}.log`))
      expect(artifactRows.map((row, index) => ({ exists: existsSync(artifactPaths[index]!), bytes: readFileSync(artifactPaths[index]!).length, durableBytes: row.size_bytes }))).toEqual([
        { exists: true, bytes: 0, durableBytes: 0 },
        { exists: true, bytes: 0, durableBytes: 0 },
      ])
      const ownerId = 'active-owner'
      const ownerProcess = currentControllerProcessIdentity()
      acquireControllerClaim(ownerTracker, ready.runId, ownerId, 60_000, new Date(), ownerProcess)

      await expect(createCaseController(f, { max_experiments: 1 }, ready.runId).run()).rejects.toMatchObject({ code: 'run-controller-active' })
      expect(ownerTracker.database.prepare("SELECT artifact_id, retention FROM artifacts WHERE experiment_id = ? AND attempt_id = ? ORDER BY kind").all(experimentId, attemptId)).toEqual(artifactRows.map(({ artifact_id, retention }) => ({ artifact_id, retention })))
      expect(artifactPaths.every(existsSync)).toBe(true)
      const genericTracker = DurableTracker.open(ready.tracker)
      expect(genericTracker.database.prepare("SELECT artifact_id, retention FROM artifacts WHERE experiment_id = ? AND attempt_id = ? ORDER BY kind").all(experimentId, attemptId)).toEqual(artifactRows.map(({ artifact_id, retention }) => ({ artifact_id, retention })))
      expect(artifactPaths.every(existsSync)).toBe(true)
      genericTracker.close()

      releaseControllerClaim(ownerTracker, ready.runId, ownerId, ownerProcess)
      ownerTracker.close()
      const completed = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(completed).toMatchObject({ status: 'budget-limited', counts: { attempts: 2 } })
      const recovered = DurableTracker.openReadOnly(ready.tracker)
      expect(recovered.database.prepare('SELECT * FROM artifacts WHERE experiment_id = ? AND attempt_id = ?').all(experimentId, attemptId)).toEqual([])
      expect(artifactPaths.every(path => !existsSync(path))).toBe(true)
      recovered.close()
    } finally {
      fault.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  async function seedTerminalDiscardingFixture(f: ControllerFixture) {
    const terminal = createCaseController(f, { max_experiments: 1 })
    await expect(terminal.run()).resolves.toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 1, experimentsCompleted: 1, attempts: 2 }, best: { metric: 10 } })
    const ready = await terminal.ready
    const tracker = DurableTracker.open(ready.tracker)
    const run = tracker.getRun(ready.runId)!
    const localLock = tracker.database.prepare('SELECT acquired_at FROM active_locks WHERE run_id = ?').get(ready.runId)!
    expect(tracker.readRegistration(ready.runId)).not.toBeNull()
    expect(JSON.parse(String(tracker.database.prepare("SELECT intent_json FROM transitions WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing'").get(ready.runId)?.['intent_json']))).toMatchObject({ kind: 'create-run', contractGeneration: EVALUATOR_CONTRACT_GENERATION })
    const experiment = tracker.database.prepare("SELECT experiment_id FROM experiments WHERE run_id = ? AND kind = 'candidate' AND ordinal = 1").get(ready.runId)!
    const experimentId = String(experiment['experiment_id'])
    const attempt = tracker.database.prepare('SELECT attempt_id FROM attempts WHERE run_id = ? AND experiment_id = ? AND ordinal = 1').get(ready.runId, experimentId)!
    const attemptId = String(attempt['attempt_id'])
    expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ?').get(ready.runId, experimentId, attemptId)).toEqual({ n: 0 })
    const artifactDir = join(tracker.layout.root, 'artifacts', ready.runId, experimentId, attemptId)
    mkdirSync(artifactDir, { recursive: true })
    const emptySha256 = createHash('sha256').update('').digest('hex')
    const createdAt = new Date().toISOString()
    tracker.database.exec('BEGIN IMMEDIATE')
    try {
      const insert = tracker.database.prepare('INSERT INTO artifacts (artifact_id, run_id, experiment_id, attempt_id, kind, location, size_bytes, sha256, owner, retention, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, \'evaluator\', \'retain\', ?, ?)')
      for (const kind of ['stderr', 'stdout'] as const) {
        const path = join(artifactDir, `${kind}.log`)
        writeFileSync(path, '')
        chmodSync(path, 0o600)
        insert.run(`${attemptId}-${kind}`, ready.runId, experimentId, attemptId, kind, `artifact:sha256:${createHash('sha256').update(path).digest('hex')}`, emptySha256, '{"truncated":false}', createdAt)
      }
      tracker.database.prepare('UPDATE active_locks SET released_at = NULL WHERE run_id = ?').run(ready.runId)
      tracker.database.exec('COMMIT')
    } catch (error) {
      tracker.database.exec('ROLLBACK')
      tracker.close()
      throw error
    }
    const crash = vi.spyOn(DurableTracker.prototype, 'artifactDiscardMarkedForTest').mockImplementation(() => { throw new Error('terminal artifact discard crash') })
    try {
      expect(() => tracker.discardProvenNoProcessCandidateArtifacts(attemptId)).toThrow('terminal artifact discard crash')
    } finally {
      crash.mockRestore()
      tracker.close()
    }
    const authority = new DatabaseSync(join(f.root, '.git', 'dsh-autoresearch-locks.sqlite'))
    authority.prepare('INSERT OR REPLACE INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(run['repository_id'], run['run_tag'], ready.runId, localLock['acquired_at'])
    authority.prepare('DELETE FROM controller_claims WHERE run_id = ?').run(ready.runId)
    expect(authority.prepare('SELECT repository_id, run_tag, run_id FROM active_locks WHERE run_id = ?').get(ready.runId)).toMatchObject({ run_id: ready.runId })
    expect(authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').all(ready.runId)).toEqual([])
    authority.close()
    return { ready, experimentId, attemptId }
  }

  it('recovers a terminal crash at the durable discarding mark before releasing or retaining the run', async () => {
    const { fixture: f } = matrixControllerFixture(
      [{ stdout: '{"score":10}\n' }, { spawnError: new Error('provider refused spawn') }],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
    )
    try {
      const { ready, experimentId, attemptId } = await seedTerminalDiscardingFixture(f)
      const before = DurableTracker.openReadOnly(ready.tracker)
      expect(before.database.prepare("SELECT retention FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ? ORDER BY kind").all(ready.runId, experimentId, attemptId)).toEqual([{ retention: 'discarding' }, { retention: 'discarding' }])
      const baselineArtifacts = before.database.prepare("SELECT artifact_id FROM artifacts WHERE run_id = ? AND experiment_id LIKE '%-baseline' ORDER BY artifact_id").all(ready.runId)
      expect(baselineArtifacts).toHaveLength(2)
      expect(before.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)).toEqual({ released_at: null })
      before.close()
      const authority = new DatabaseSync(join(f.root, '.git', 'dsh-autoresearch-locks.sqlite'))
      expect(authority.prepare('SELECT repository_id, run_tag, run_id FROM active_locks WHERE run_id = ?').get(ready.runId)).toMatchObject({ run_id: ready.runId })
      expect(authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').all(ready.runId)).toEqual([])
      const resumed = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(resumed).toMatchObject({ status: 'budget-limited', artifacts: baselineArtifacts.map(row => expect.objectContaining({ artifactId: row['artifact_id'] })) })
      expect(await createCaseController(f, { max_experiments: 1 }, ready.runId).run()).toEqual(resumed)
      const after = DurableTracker.openReadOnly(ready.tracker)
      expect(after.database.prepare('SELECT artifact_id FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(ready.runId)).toEqual(baselineArtifacts)
      expect(after.database.prepare('SELECT * FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ?').all(ready.runId, experimentId, attemptId)).toEqual([])
      expect(after.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)?.['released_at']).not.toBeNull()
      expect(authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').all(ready.runId)).toEqual([])
      expect(authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').all(ready.runId)).toEqual([])
      authority.close()
      after.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['malformed-pair', 'nonspawn'] as const)('rejects terminal %s discarding evidence read-only without artifact, lock, or retention mutation', async faultKind => {
    const { fixture: f } = matrixControllerFixture(
      [{ stdout: '{"score":10}\n' }, { spawnError: new Error('provider refused spawn') }],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
    )
    try {
      const { ready, experimentId, attemptId } = await seedTerminalDiscardingFixture(f)
      const corrupt = DurableTracker.open(ready.tracker)
      if (faultKind === 'malformed-pair') corrupt.database.prepare("UPDATE artifacts SET owner = 'host' WHERE run_id = ? AND kind = 'stdout'").run(ready.runId)
      else {
        const outcome = JSON.stringify({ kind: 'failed', code: 'exit', message: 'evaluator exited with code 9' })
        seedImmutableEvidence(corrupt.database, ['attempts_immutable_outcome'], () => corrupt.database.prepare("UPDATE attempts SET outcome_json = ?, failure_code = 'exit', failure_message = 'evaluator exited with code 9', exit_code = 9, provider_pid = 1234, spawned_at = created_at WHERE run_id = ? AND experiment_id = ? AND attempt_id = ?").run(outcome, ready.runId, experimentId, attemptId))
        corrupt.database.prepare("UPDATE experiments SET state = 'crashed', failure_code = 'exit', failure_message = 'evaluator exited with code 9', exit_code = 9, host_facts_json = ? WHERE run_id = ? AND experiment_id = ?").run(JSON.stringify({ failure: { code: 'exit', exitCode: 9 } }), ready.runId, experimentId)
        expect(corrupt.database.prepare('SELECT outcome_json, failure_code, failure_message, exit_code, signal, timed_out, process_tree_quiescent FROM attempts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ?').get(ready.runId, experimentId, attemptId)).toEqual({ outcome_json: outcome, failure_code: 'exit', failure_message: 'evaluator exited with code 9', exit_code: 9, signal: null, timed_out: 0, process_tree_quiescent: 1 })
        const experiment = corrupt.database.prepare('SELECT state, failure_code, failure_message, exit_code, signal, timed_out, host_facts_json FROM experiments WHERE run_id = ? AND experiment_id = ?').get(ready.runId, experimentId)!
        expect(experiment).toMatchObject({ state: 'crashed', failure_code: 'exit', failure_message: 'evaluator exited with code 9', exit_code: 9, signal: null, timed_out: 0 })
        expect(JSON.parse(String(experiment['host_facts_json']))).toMatchObject({ failure: { code: 'exit', exitCode: 9 } })
      }
      corrupt.close()
      const durableBefore = readFileSync(ready.tracker)
      const authorityPath = join(f.root, '.git', 'dsh-autoresearch-locks.sqlite')
      const authorityBefore = readFileSync(authorityPath)
      const artifactRoot = join(dirname(ready.tracker), 'artifacts')
      const artifactsBefore = readdirSync(artifactRoot, { recursive: true }).map(String).sort()
      const resumed = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(resumed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'artifact-incomplete' })] })
      expect(readFileSync(ready.tracker)).toEqual(durableBefore)
      expect(readFileSync(authorityPath)).toEqual(authorityBefore)
      expect(readdirSync(artifactRoot, { recursive: true }).map(String).sort()).toEqual(artifactsBefore)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('reruns a proven-quiescent candidate evaluation exactly once from its recorded candidate commit', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }, { stdout: '{"score":8}\n' }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')])
    const original = DurableTracker.prototype.recordAttemptOutcome
    let candidateInterruptions = 0
    const fault = vi.spyOn(DurableTracker.prototype, 'recordAttemptOutcome').mockImplementation(function (attemptId, facts) {
      if (attemptId.includes('-candidate-') && candidateInterruptions < 2) {
        candidateInterruptions++
        this.database.prepare('UPDATE attempts SET process_tree_quiescent = 1 WHERE attempt_id = ?').run(attemptId)
        throw new Error(`candidate outcome barrier ${candidateInterruptions}`)
      }
      return original.call(this, attemptId, facts)
    })
    try {
      const first = createCaseController(f, { max_experiments: 1 }); await expect(first.run()).rejects.toThrow('candidate outcome barrier 1'); const ready = await first.ready
      const trackerBefore = DurableTracker.open(ready.tracker)
      const candidateCommit = String(trackerBefore.database.prepare("SELECT candidate_commit FROM experiments WHERE kind = 'candidate'").get()?.['candidate_commit'])
      expect(candidateCommit).toMatch(/^[0-9a-f]{40}$/u)
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      trackerBefore.close()
      await expect(createCaseController(f, { max_experiments: 1 }, ready.runId).run()).rejects.toThrow('candidate outcome barrier 2')
      fault.mockRestore()
      const terminal = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(terminal.status).toBe('blocked')
      if (terminal.status !== 'blocked') throw new Error(`expected blocked recovery result, received ${terminal.status}`)
      expect(terminal.counts).toEqual({ experimentsStarted: 1, experimentsCompleted: 1, attempts: 3 })
      expect(terminal.evidence).toEqual([{ code: 'recovery-rerun-exhausted', message: 'canonical evaluator measurement recovery reruns are exhausted', artifacts: [] }])
      const tracker = DurableTracker.open(ready.tracker)
      const acceptedCommit = String(tracker.getRun(ready.runId)?.['best_commit'])
      expect(tracker.getRun(ready.runId)).toMatchObject({ state: 'blocked', blocked_code: 'recovery-rerun-exhausted', terminal_reason: 'canonical evaluator measurement recovery reruns are exhausted', terminal_quiescent: 1 })
      expect(tracker.database.prepare("SELECT candidate_commit, state, failure_code FROM experiments WHERE kind = 'candidate'").get()).toEqual({ candidate_commit: candidateCommit, state: 'crashed', failure_code: 'recovery-rerun-exhausted' })
      expect(tracker.database.prepare("SELECT ordinal, process_tree_quiescent, exited_at FROM attempts WHERE experiment_id LIKE '%-candidate-%' ORDER BY ordinal").all()).toEqual([
        { ordinal: 1, process_tree_quiescent: 1, exited_at: null },
        { ordinal: 2, process_tree_quiescent: 1, exited_at: null },
      ])
      expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(acceptedCommit)
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)?.['released_at']).not.toBeNull()
      expect(controllerClaims(String(tracker.getRun(ready.runId)?.['git_common_dir']), ready.runId)).toEqual([])
      tracker.close()
      const replay = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(replay).toEqual(terminal)
      expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(acceptedCommit)
      expect(f.subprocess.evaluatorSpawns).toBe(3)
    } finally { fault.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('replays exhausted baseline recovery without fabricating an evaluator exit', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }, { stdout: '{"score":8}\n' }])
    const original = DurableTracker.prototype.recordAttemptOutcome
    let interruptions = 0
    const fault = vi.spyOn(DurableTracker.prototype, 'recordAttemptOutcome').mockImplementation(function (attemptId, facts) {
      if (attemptId.includes('-baseline-') && interruptions < 2) {
        interruptions++
        this.database.prepare('UPDATE attempts SET process_tree_quiescent = 1 WHERE attempt_id = ?').run(attemptId)
        throw new Error(`baseline outcome barrier ${interruptions}`)
      }
      return original.call(this, attemptId, facts)
    })
    try {
      const first = createCaseController(f, { max_experiments: 1 })
      await expect(first.run()).rejects.toThrow('baseline outcome barrier 1')
      const ready = await first.ready
      await expect(createCaseController(f, { max_experiments: 1 }, ready.runId).run()).rejects.toThrow('baseline outcome barrier 2')
      fault.mockRestore()
      const terminal = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(terminal).toMatchObject({ status: 'round-failed', evidence: [{ code: 'recovery-rerun-exhausted' }], counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 2 } })
      expect(terminal).not.toHaveProperty('exit')
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.getRun(ready.runId)).toMatchObject({ state: 'blocked', blocked_code: 'recovery-rerun-exhausted', terminal_quiescent: 1 })
      expect(tracker.database.prepare("SELECT state, failure_code FROM experiments WHERE kind = 'baseline'").get()).toEqual({ state: 'crashed', failure_code: 'recovery-rerun-exhausted' })
      expect(tracker.database.prepare("SELECT a.ordinal, a.process_tree_quiescent, a.exited_at FROM attempts a INNER JOIN experiments e ON e.run_id = a.run_id AND e.experiment_id = a.experiment_id WHERE a.run_id = ? AND e.kind = 'baseline' ORDER BY a.ordinal").all(ready.runId)).toEqual([
        { ordinal: 1, process_tree_quiescent: 1, exited_at: null },
        { ordinal: 2, process_tree_quiescent: 1, exited_at: null },
      ])
      tracker.close()
      expect(await createCaseController(f, { max_experiments: 1 }, ready.runId).run()).toEqual(terminal)
      expect(f.creates).toHaveLength(0)
      expect(f.subprocess.evaluatorSpawns).toBe(2)
    } finally { fault.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['accept', 9, 'before-publication'], ['accept', 9, 'after-publication'],
    ['reject', 11, 'before-publication'], ['reject', 11, 'after-publication'],
  ] as const)('reconciles an interrupted %s decision with metric %s at %s deterministically and idempotently', async (decision, metric, barrier) => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: `{"score":${metric}}\n` }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${metric}\n`)])
    const checkpoint = DurableTracker.prototype.checkpointRun
    const commitTerminal = DurableTracker.prototype.commitTerminalExperiment
    let hits = 0
    const fault = barrier === 'before-publication'
      ? vi.spyOn(DurableTracker.prototype, 'checkpointRun').mockImplementation(function (runId, facts, at) {
          if ((facts.intent as { kind?: string } | undefined)?.kind === 'git-reconciliation' && hits++ === 0) throw new Error('decision barrier before publication')
          return checkpoint.call(this, runId, facts, at)
        })
      : vi.spyOn(DurableTracker.prototype, 'commitTerminalExperiment').mockImplementation(function (experimentId, state, facts, at) {
          if (experimentId.includes('-candidate-') && hits++ === 0) throw new Error('decision barrier after publication')
          return commitTerminal.call(this, experimentId, state, facts, at)
        })
    try {
      const interrupted = createCaseController(f, { max_experiments: 1 }); await expect(interrupted.run()).rejects.toThrow(`decision barrier ${barrier === 'before-publication' ? 'before' : 'after'} publication`); const ready = await interrupted.ready
      fault.mockRestore()
      const candidates = DurableTracker.open(ready.tracker)
      const rowBefore = candidates.database.prepare("SELECT candidate_commit FROM experiments WHERE kind = 'candidate'").get()!
      const candidateCommit = String(rowBefore['candidate_commit']); const startCommit = execFileSync('git', ['-C', f.root, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim()
      candidates.close()
      const [left, right] = await Promise.allSettled([createCaseController(f, { max_experiments: 1 }, ready.runId).run(), createCaseController(f, { max_experiments: 1 }, ready.runId).run()])
      expect([left, right].some(result => result.status === 'fulfilled' && result.value.status === 'budget-limited')).toBe(true)
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare("SELECT state, decision, metric, candidate_commit FROM experiments WHERE kind = 'candidate'").get()).toEqual({ state: decision === 'accept' ? 'accepted' : 'rejected', decision, metric, candidate_commit: candidateCommit })
      const run = tracker.getRun(ready.runId)!
      expect(run['best_commit']).toBe(decision === 'accept' ? candidateCommit : startCommit)
      expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(decision === 'accept' ? candidateCommit : startCommit)
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM attempts WHERE experiment_id LIKE '%-candidate-%'").get()?.['n']).toBe(1)
      expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM transitions WHERE scope = 'experiment' AND experiment_id LIKE '%-candidate-%' AND to_state = ?").get(decision === 'accept' ? 'accepted' : 'rejected')?.['n']).toBe(1)
      tracker.close()
    } finally { fault.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('persists a terminal experiment and artifacts before the next child and releases only after terminal run persistence', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }, { stdout: '{"score":8}\n' }], [(worktree, ordinal) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${ordinal + 1}\n`), (worktree, ordinal) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${ordinal + 1}\n`)])

    try { const { result, tracker } = await runControllerCase(f, { max_experiments: 2 }); expect(result).toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 2, experimentsCompleted: 2, attempts: 3 } }); const experiments = tracker.database.prepare("SELECT state FROM experiments WHERE kind='candidate' ORDER BY ordinal").all(); expect(experiments).toEqual([{ state: 'accepted' }, { state: 'accepted' }]); expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull(); expect(f.order.filter(item => item.includes('child'))).toEqual(['child-1-create', 'child-1-dispose-start', 'child-1-dispose-end', 'child-2-create', 'child-2-dispose-start', 'child-2-dispose-end']); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each(['live', 'crash-resume'] as const)('durably records frozen-file disappearance evidence and safely replays after %s evaluation', async mode => {
    const f = controllerFixture(
      [
        { stdout: '{"score":10}\n' },
        { stdout: '{"score":9}\n', stderr: 'bounded evaluator stderr\n', afterOutcome: worktree => rmSync(join(worktree, 'evaluate.mjs')) },
      ],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
    )
    const commitTerminal = DurableTracker.prototype.commitTerminalExperiment
    let interrupted = false
    const barrier = mode === 'crash-resume'
      ? vi.spyOn(DurableTracker.prototype, 'commitTerminalExperiment').mockImplementation(function (experimentId, state, facts, at) {
          if (experimentId.includes('-candidate-') && !interrupted) { interrupted = true; throw new Error('crash after durable frozen mismatch attempt') }
          return commitTerminal.call(this, experimentId, state, facts, at)
        })
      : undefined
    try {
      const controller = createCaseController(f, { max_experiments: 1 })
      let ready: AutoresearchRunReady
      let result
      if (barrier) {
        await expect(controller.run()).rejects.toThrow('crash after durable frozen mismatch attempt')
        ready = await controller.ready
        barrier.mockRestore()
        const stranded = DurableTracker.openReadOnly(ready.tracker)
        expect(stranded.database.prepare("SELECT state FROM experiments WHERE kind = 'candidate'").get()).toEqual({ state: 'running' })
        expect(stranded.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)).toEqual({ released_at: null })
        stranded.close()
        result = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      } else {
        result = await controller.run()
        ready = await controller.ready
      }
      expect(result).toMatchObject({ status: 'blocked', evidence: [{ code: 'provenance-mismatch' }] })
      const tracker = DurableTracker.openReadOnly(ready.tracker)
      const run = tracker.getRun(ready.runId)!
      const candidate = tracker.database.prepare("SELECT experiment_id, state, failure_code, failure_message FROM experiments WHERE kind = 'candidate'").get()!
      expect(candidate).toMatchObject({ state: 'policy-violation', failure_code: 'provenance-mismatch' })
      expect(String(candidate['failure_message'])).toMatch(/ENOENT|frozen .*file|immutable manifest/iu)
      const attempt = tracker.database.prepare('SELECT attempt_id, exited_at, exit_code, signal, timed_out, process_tree_quiescent, failure_code, failure_message, outcome_json FROM attempts WHERE experiment_id = ?').get(candidate['experiment_id'])!
      expect(attempt).toMatchObject({ exit_code: 0, signal: null, timed_out: 0, process_tree_quiescent: 1, failure_code: null, failure_message: null })
      const durableOutcome = JSON.parse(String(attempt['outcome_json']))
      expect(durableOutcome).toEqual({ kind: 'measured', metric: 9 })
      expect(tracker.database.prepare('SELECT kind, size_bytes, owner, retention FROM artifacts WHERE attempt_id = ? ORDER BY kind').all(attempt['attempt_id'])).toEqual([
        { kind: 'stderr', size_bytes: 25, owner: 'evaluator', retention: 'retain' },
        { kind: 'stdout', size_bytes: 12, owner: 'evaluator', retention: 'retain' },
      ])
      const mismatchTransitions = tracker.listTransitions(ready.runId).flatMap(row => {
        if (row['outcome_json'] === null) return []
        const outcome = JSON.parse(String(row['outcome_json'])) as { kind?: string; code?: string; evaluatorResult?: unknown; evidence?: Array<{ code: string }> }
        return outcome.kind === 'frozen-file-policy-mismatch' ? [{ kind: outcome.kind, code: outcome.code, evaluatorResult: outcome.evaluatorResult, evidence: outcome.evidence?.map(item => ({ code: item.code })) }] : []
      })
      expect(mismatchTransitions).toEqual([{ kind: 'frozen-file-policy-mismatch', code: 'provenance-mismatch', evaluatorResult: durableOutcome, evidence: [{ code: 'provenance-mismatch' }] }])
      expect(run).toMatchObject({ state: 'blocked', blocked_code: 'provenance-mismatch', terminal_quiescent: 1 })
      expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(run['best_commit'])
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)?.['released_at']).not.toBeNull()
      tracker.close()
      expect(await createCaseController(f, { max_experiments: 1 }, ready.runId).run()).toEqual(result)
    } finally {
      barrier?.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it('retains nonterminal ownership when frozen-mismatch persistence itself fails', async () => {
    const f = controllerFixture(
      [
        { stdout: '{"score":10}\n' },
        { stdout: '{"score":9}\n', afterOutcome: worktree => writeFileSync(join(worktree, 'evaluate.mjs'), '// mutated after evaluator outcome\n') },
      ],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
    )
    const original = DurableTracker.prototype.recordAttemptOutcome
    const fault = vi.spyOn(DurableTracker.prototype, 'recordAttemptOutcome').mockImplementation(function (attemptId, checkpoint, at) {
      if (attemptId.includes('-candidate-')) throw new Error('injected frozen mismatch persistence failure')
      return original.call(this, attemptId, checkpoint, at)
    })
    try {
      const controller = createCaseController(f, { max_experiments: 1 })
      await expect(controller.run()).rejects.toThrow('injected frozen mismatch persistence failure')
      const ready = await controller.ready
      const tracker = DurableTracker.openReadOnly(ready.tracker)
      expect(tracker.database.prepare("SELECT state FROM experiments WHERE kind = 'candidate'").get()).toEqual({ state: 'running' })
      expect(tracker.database.prepare("SELECT exited_at, process_tree_quiescent, outcome_json FROM attempts WHERE experiment_id IN (SELECT experiment_id FROM experiments WHERE kind = 'candidate')").get()).toEqual({ exited_at: null, process_tree_quiescent: null, outcome_json: null })
      expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE experiment_id IN (SELECT experiment_id FROM experiments WHERE kind = ?)').get('candidate')).toEqual({ n: 0 })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)).toEqual({ released_at: null })
      tracker.close()
    } finally {
      fault.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it.each(['live', 'resume'] as const)('retains the run lock when frozen evaluator rejection git reconciliation is blocked during %s recovery', async mode => {
    let armGitFailure = false
    let gitFailures = 0
    const { fixture: f } = matrixControllerFixture(
      [
        { stdout: '{"score":10}\n' },
        { stdout: '{"score":9}\n', afterOutcome: worktree => { writeFileSync(join(worktree, 'evaluate.mjs'), '// violated frozen evaluator after outcome\n'); armGitFailure = true } },
      ],
      [worktree => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
      { gitSpawnFailure: spec => armGitFailure && spec.argv.includes('read-tree') && spec.argv.includes('--reset') && gitFailures++ === 0 ? new Error('injected rejected-head git failure') : undefined },
    )
    const checkpoint = DurableTracker.prototype.checkpointRun
    const barrier = mode === 'resume'
      ? vi.spyOn(DurableTracker.prototype, 'checkpointRun').mockImplementation(function (runId, facts, at) {
          const intent = facts.intent as { kind?: string; outcome?: { kind?: string; code?: string } } | undefined
          if (intent?.kind === 'git-reconciliation' && intent.outcome?.kind === 'terminal-block' && intent.outcome.code === 'provenance-mismatch') {
            checkpoint.call(this, runId, facts, at)
            throw new Error('frozen rejection crash barrier')
          }
          return checkpoint.call(this, runId, facts, at)
        })
      : undefined
    try {
      const controller = createCaseController(f, { max_experiments: 1 })
      let ready: AutoresearchRunReady
      let result
      if (mode === 'resume') {
        await expect(controller.run()).rejects.toThrow('frozen rejection crash barrier')
        ready = await controller.ready
        const seeded = DurableTracker.open(ready.tracker)
        const experimentId = String(seeded.database.prepare("SELECT experiment_id FROM experiments WHERE run_id = ? AND kind = 'candidate' ORDER BY ordinal DESC LIMIT 1").get(ready.runId)!['experiment_id'])
        expect(seeded.database.prepare('SELECT outcome_json, failure_code FROM attempts WHERE run_id = ? AND experiment_id = ? ORDER BY ordinal DESC LIMIT 1').get(ready.runId, experimentId)).toEqual({ outcome_json: JSON.stringify({ kind: 'measured', metric: 9 }), failure_code: null })
        expect(seeded.database.prepare('SELECT state, failure_code, failure_message FROM experiments WHERE run_id = ? AND experiment_id = ?').get(ready.runId, experimentId)).toMatchObject({ state: 'policy-violation', failure_code: 'provenance-mismatch' })
        expect(seeded.getRun(ready.runId)).toMatchObject({ state: 'deciding' })
        const mismatchBarrier = seeded.listTransitions(ready.runId).map(row => row['outcome_json'] === null ? undefined : JSON.parse(String(row['outcome_json']))).find(outcome => outcome?.kind === 'frozen-file-policy-mismatch')
        expect(mismatchBarrier).toMatchObject({ code: 'provenance-mismatch', evaluatorResult: { kind: 'measured', metric: 9 } })
        seeded.close()
        barrier!.mockRestore()
        result = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      } else {
        result = await controller.run()
        ready = await controller.ready
      }
      if (result.status !== 'blocked') throw new Error(`expected blocked result, received ${result.status}`)
      const evidence = result.evidence
      expect(evidence.map(item => ({ code: item.code, artifacts: item.artifacts }))).toEqual([
        { code: 'git-command-failed', artifacts: [] },
        { code: 'git-command-failed', artifacts: [] },
      ])
      expect(evidence.map(item => item.message)).toEqual(evidence.map(item => item.message.trim()))
      expect(evidence.every(item => item.message.length > 0)).toBe(true)
      expect(decodeRunResult(result, 'minimize')).toEqual(result)
      expect(gitFailures).toBe(1)
      const tracker = DurableTracker.openReadOnly(ready.tracker)
      const candidateAttempt = tracker.database.prepare("SELECT outcome_json, failure_code FROM attempts WHERE run_id = ? AND experiment_id IN (SELECT experiment_id FROM experiments WHERE run_id = ? AND kind = 'candidate') ORDER BY ordinal DESC LIMIT 1").get(ready.runId, ready.runId)
      expect(candidateAttempt).toEqual({ outcome_json: JSON.stringify({ kind: 'measured', metric: 9 }), failure_code: null })
      const mismatchTransitions = tracker.listTransitions(ready.runId).flatMap(row => {
        if (row['outcome_json'] === null) return []
        const transition = JSON.parse(String(row['outcome_json'])) as { kind?: string; code?: string; evaluatorResult?: unknown }
        return transition.kind === 'frozen-file-policy-mismatch' ? [{ kind: transition.kind, code: transition.code, evaluatorResult: transition.evaluatorResult }] : []
      })
      expect(mismatchTransitions).toEqual([{ kind: 'frozen-file-policy-mismatch', code: 'provenance-mismatch', evaluatorResult: { kind: 'measured', metric: 9 } }])
      expect(tracker.getRun(ready.runId)).toMatchObject({ state: 'deciding', blocked_code: 'git-reconciliation-failed' })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(ready.runId)).toEqual({ released_at: null })
      const outcome = JSON.parse(String(tracker.listTransitions(ready.runId).at(-1)?.['outcome_json'])) as { kind: string; code: string; head: string }
      expect(outcome).toMatchObject({ kind: 'git-reconciliation-blocked', code: 'git-command-failed', head: 'uncertain' })
      tracker.close()
    } finally {
      barrier?.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('durably retains the terminal lock when proposal disposal leaves child ownership uncertain', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [], { dispose: async () => { throw new Error('child disposal failed') } })
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result.status).toBe('blocked')
      expect(tracker.getRun(result.runId)).toMatchObject({ state: 'blocked', terminal_quiescent: 0 })
      expect(tracker.recoveryState(result.runId)).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('awaits proposal disposal once on controller failure and leaves no registration or job', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [(worktree) => writeFileSync(join(worktree, 'package.json'), '{}\n')])
    try {
      const { result, tracker } = await runControllerCase(f, { mutable_globs: ['**'], max_experiments: 1 })
      expect(result.status).toBe('round-failed')
      expect(f.order.filter(item => item.includes('dispose'))).toEqual(['child-1-dispose-start', 'child-1-dispose-end'])
      expect(f.liveCount()).toBe(0)
      expect(f.ctx.jobs.list()).toEqual([])
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('does not spawn an evaluator until a child-owned late mutation and proposal disposal are quiescent', async () => {
    let lateMutation: Promise<void> | undefined
    const f = controllerFixture(
      [{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }],
      [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
      {
        afterReport(worktree) {
          const mutation = Promise.withResolvers<void>()
          lateMutation = mutation.promise
          setTimeout(() => { writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 3\n'); f.order.push('late-mutation'); mutation.resolve() }, 20)
        },
        async dispose() { await lateMutation },
      },
    )
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result.status).toBe('budget-limited')
      const disposalEnd = f.order.indexOf('child-1-dispose-end')
      expect(f.order.indexOf('late-mutation')).toBeGreaterThan(f.order.indexOf('child-1-dispose-start'))
      expect(disposalEnd).toBeLessThan(f.order.lastIndexOf('evaluator-spawn'))
      expect(f.liveCount()).toBe(0)
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([{ stdout: '', exitCode: 9 }, { stdout: '{"score":1}\n', stderr: 'failure', exitCode: 7 }, { stdout: 'not-json\n' }])('classifies baseline evaluator failure with only canonical durable artifacts and no child', async step => {
    const f = controllerFixture([step])
    try {
      const { result, tracker } = await runControllerCase(f); expect(result.status).toBe('baseline-blocked'); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT state FROM experiments').get()?.['state']).toBe('crashed')
      // decodeRunResult has already validated this discriminated baseline-blocked result.
      const terminal = result as { artifacts: Array<{ artifactId: string; kind: string }>; exit: { stdout: { artifactId: string }; stderr: { artifactId: string } } }
      const refs = terminal.artifacts
      expect(refs.map(item => item.kind).sort()).toEqual(['stderr', 'stdout']); expect(new Set(refs.map(item => item.artifactId)).size).toBe(2); expect(refs).toContainEqual(expect.objectContaining(terminal.exit.stdout)); expect(refs).toContainEqual(expect.objectContaining(terminal.exit.stderr)); expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2); tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('revalidates terminal baseline artifacts before cancellation can release the lock', async () => {
    const f = controllerFixture([{ stdout: '', exitCode: 9 }])
    const transitionRun = DurableTracker.prototype.transitionRun
    let controller!: AutoresearchRunController
    let observedTerminalBaseline = false
    const transitionSpy = vi.spyOn(DurableTracker.prototype, 'transitionRun').mockImplementation(function (runId, to, facts, at) {
      const transitionId = transitionRun.call(this, runId, to, facts, at)
      if (to === 'baseline-blocked') {
        observedTerminalBaseline = true
        const artifact = this.database.prepare("SELECT run_id, experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ? AND kind = 'stdout'").get(runId)!
        unlinkSync(join(this.layout.root, 'artifacts', String(artifact['run_id']), String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`))
        controller.cancel('operator stop after terminal persistence')
      }
      return transitionId
    })
    try {
      controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, repository: f.root, mutable_globs: ['src/**'] }, parent: f.parent, signal: new AbortController().signal })
      const result = await controller.run()
      const ready = await controller.ready
      const tracker = DurableTracker.open(ready.tracker)
      expect(observedTerminalBaseline).toBe(true)
      expect(result).toMatchObject({ status: 'round-failed', evidence: [{ code: 'artifact-incomplete' }] })
      expect(tracker.getRun(result.runId)).toMatchObject({ state: 'baseline-blocked' })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).toBeNull()
      tracker.close()
    } finally {
      transitionSpy.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('persists baseline signal artifacts with zero child allocation and zero candidate budget', async () => {
    const f = controllerFixture([{ signal: 'SIGTERM', stdout: 'partial', stderr: 'terminated' }])
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result).toMatchObject({ status: 'baseline-blocked', counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } })
      expect(f.creates).toHaveLength(0)
      expect(tracker.database.prepare('SELECT state, signal FROM experiments').get()).toMatchObject({ state: 'crashed', signal: 'SIGTERM' })
      expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })


  it('classifies a real evaluator timeout, awaits process-tree exit, retains artifacts, and spawns no child', async () => {
    const f = controllerFixture([{ hang: true }])
    try { const { result, tracker } = await runControllerCase(f, { timeout_ms: 25 }); expect(result.status).toBe('baseline-blocked'); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT state FROM experiments').get()?.['state']).toBe('timed-out'); expect(tracker.database.prepare('SELECT timed_out, process_tree_quiescent FROM attempts').get()).toEqual({ timed_out: 1, process_tree_quiescent: 1 }); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('prunes failed-attempt artifact bytes while preserving terminal replay metadata', async () => {
    const f = controllerFixture([{ stdout: '', stderr: 'failed', exitCode: 9 }])
    try {
      const { result, ready, tracker } = await runControllerCase(f, {}, { retainFailedArtifacts: false })
      expect(result.status).toBe('baseline-blocked')
      const rows = tracker.database.prepare('SELECT run_id, experiment_id, attempt_id, kind, retention FROM artifacts ORDER BY kind').all()
      expect(rows.map(row => row['retention'])).toEqual(['pruned', 'pruned'])
      for (const row of rows) {
        const path = join(tracker.layout.root, 'artifacts', String(row['run_id']), String(row['experiment_id']), String(row['attempt_id']), `${String(row['kind'])}.log`)
        expect(existsSync(path)).toBe(false)
      }
      tracker.database.prepare("UPDATE artifacts SET retention = 'pruning' WHERE artifact_id = (SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT 1)").run()
      tracker.close()

      const replay = await createCaseController(f, {}, ready.runId, { retainFailedArtifacts: false }).run()
      expect(replay.status).toBe('baseline-blocked')
      expect(replay.artifacts).toHaveLength(2)
      expect(replay.artifacts.every(item => !('retention' in item))).toBe(true)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      const replayedTracker = DurableTracker.open(ready.tracker)
      expect(replayedTracker.database.prepare('SELECT DISTINCT retention FROM artifacts').all()).toEqual([{ retention: 'pruned' }])
      replayedTracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('sweeps expired artifact bytes and TSV exports before the next repository run', async () => {
    const f = controllerFixture([{ stdout: '{"score":5}\n' }, { stdout: '{"score":7}\n' }])
    try {
      const first = await runControllerCase(f, { run_tag: 'retention-first', target: 5, max_experiments: 1 }, { exportTsv: true })
      const old = new Date(Date.now() - 3 * 86_400_000)
      first.tracker.database.prepare('UPDATE artifacts SET created_at = ?').run(old.toISOString())
      const artifactPaths = first.tracker.database.prepare('SELECT run_id, experiment_id, attempt_id, kind FROM artifacts ORDER BY kind').all().map(row => join(first.tracker.layout.root, 'artifacts', String(row['run_id']), String(row['experiment_id']), String(row['attempt_id']), `${String(row['kind'])}.log`))
      const tsvPath = join(first.tracker.layout.root, 'exports', `${first.ready.runId}.tsv`)
      expect(artifactPaths.every(path => existsSync(path))).toBe(true)
      expect(existsSync(tsvPath)).toBe(true)
      utimesSync(tsvPath, old, old)
      first.tracker.close()

      const second = await runControllerCase(f, { run_tag: 'retention-second', target: 7, max_experiments: 1 }, { artifactRetentionDays: 1, tsvRetentionDays: 1 })
      second.tracker.close()
      const swept = DurableTracker.open(first.ready.tracker)
      expect(swept.database.prepare('SELECT DISTINCT retention FROM artifacts').all()).toEqual([{ retention: 'pruned' }])
      expect(artifactPaths.every(path => !existsSync(path))).toBe(true)
      expect(existsSync(tsvPath)).toBe(false)
      swept.close()

      const replay = await createCaseController(f, { target: 5, max_experiments: 1 }, first.ready.runId, { artifactRetentionDays: 1, tsvRetentionDays: 1 }).run()
      expect(replay).toMatchObject({ status: 'target-reached', best: { metric: 5 } })
      expect(f.subprocess.evaluatorSpawns).toBe(2)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('removes every safe terminal worktree when retainWorktrees is false by itself', async () => {
    const f = controllerFixture([{ stdout: '', exitCode: 9 }])
    try {
      const { result, ready, tracker } = await runControllerCase(f, {}, { retainWorktrees: false, cleanupWorktreesOnSuccess: false })
      expect(result.status).toBe('baseline-blocked')
      expect(existsSync(ready.worktree)).toBe(false)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['failed', { stdout: '', exitCode: 9 }, {}, 'baseline-blocked', true],
    ['successful', { stdout: '{"score":5}\n' }, { target: 5, max_experiments: 1 }, 'target-reached', false],
  ] as const)('limits cleanupWorktreesOnSuccess to %s terminal outcomes', async (_label, evaluation, overrides, status, retained) => {
    const f = controllerFixture([evaluation])
    try {
      const { result, ready, tracker } = await runControllerCase(f, overrides, { retainWorktrees: false, cleanupWorktreesOnSuccess: true })
      expect(result.status).toBe(status)
      expect(existsSync(ready.worktree)).toBe(retained)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('treats forbidden child edits as a host policy failure while a child blocker claim remains non-authoritative', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [(worktree) => writeFileSync(join(worktree, 'package.json'), '{}\n')], {}, { blockerClaim: 'the child claims this policy edit is required' })
    try { const { result, tracker } = await runControllerCase(f, { mutable_globs: ['**'], max_experiments: 1 }); expect(result).toMatchObject({ status: 'round-failed' }); expect(String((result as { reason: string }).reason)).toMatch(/forbidden|protected|policy/iu); expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE kind='candidate'").get()?.['n']).toBe(0); const outcomes = tracker.listTransitions(String((result as { runId: string }).runId)).map(row => String(row['outcome_json'])); expect(outcomes.some(value => value.includes('child-blocker-claim') && value.includes('false'))).toBe(true); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
