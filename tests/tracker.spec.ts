import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableTracker, TRACKER_BUSY_TIMEOUT_MS, TRACKER_SCHEMA_VERSION, TrackerBlockedError, TrackerTransitionError } from '../src/tracker.ts'

const roots: string[] = []
const SHA = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
function fixturePath(name = 'tracker.sqlite'): string { const root = mkdtempSync(join(tmpdir(), 'autoresearch-tracker-')); roots.push(root); return join(root, name) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function initial(runId = 'run-1') {
  return {
    runId, repositoryId: 'repo-identity', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: SHA,
    runTag: 'test', branch: `autoresearch/test-${runId}`, worktree: `/state/${runId}/worktree`, agentId: 'agent-1', sessionId: 'session-1',
    policy: { metric: 'score', direction: 'minimize', nested: { z: 1, a: 2 } }, policySha256: HASH,
    provenance: { evaluator: 'v1', environment: {} }, provenanceSha256: HASH,
  }
}
function artifact(id = 'stdout') {
  return { artifactId: id, runId: 'run-1', experimentId: 'exp-0', attemptId: 'attempt-1', kind: id, location: `artifacts/${id}.txt`, sizeBytes: 4, sha256: HASH, owner: 'evaluator', retention: 'retain' }
}
function createRunningExperiment(tracker: DurableTracker): void {
  tracker.transitionRun('run-1', 'baseline-running')
  tracker.createExperiment({ experimentId: 'exp-0', runId: 'run-1', ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: ['evaluate.mjs'] })
  tracker.transitionExperiment('exp-0', 'running', { intent: { kind: 'evaluate' } })
}

describe('durable SQLite tracker', () => {
  it('atomically creates and idempotently reopens a versioned WAL database after discovery facts exist', () => {
    const path = fixturePath()
    const tracker = DurableTracker.open(path)
    tracker.createRun(initial())
    expect(tracker.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
    expect(tracker.foreignKeysEnabled()).toBe(true)
    expect(tracker.journalMode()).toBe('wal')
    expect(tracker.database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: TRACKER_BUSY_TIMEOUT_MS })
    expect(tracker.getRun('run-1')).toMatchObject({ repository_id: 'repo-identity', start_commit: SHA, state: 'initializing' })
    tracker.close()
    const reopened = DurableTracker.open(path)
    expect(reopened.getRun('run-1')).toMatchObject({ policy_json: '{"direction":"minimize","metric":"score","nested":{"a":2,"z":1}}', provenance_sha256: HASH })
    reopened.close()
  })

  it('performs forward migrations transactionally and refuses a newer schema with typed blocked evidence', () => {
    const path = fixturePath()
    const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, 0, 'now')")
    seed.close()
    const migrated = DurableTracker.open(path)
    expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
    expect(migrated.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'").get()).toEqual({ name: 'attempts' })
    migrated.close()
    const newer = new DatabaseSync(path)
    newer.prepare('UPDATE schema_metadata SET version = ?').run(TRACKER_SCHEMA_VERSION + 1)
    newer.close()
    expect(() => DurableTracker.open(path)).toThrowError(TrackerBlockedError)
    try { DurableTracker.open(path) } catch (error) { expect(error).toMatchObject({ status: 'blocked', code: 'tracker-schema-newer' }) }
  })

  it('enforces foreign keys, monotonic transition sequences, and exact state transitions', () => {
    const tracker = DurableTracker.open(fixturePath())
    tracker.createRun(initial())
    expect(() => tracker.createExperiment({ experimentId: 'orphan', runId: 'missing', ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: [] })).toThrow()
    tracker.transitionRun('run-1', 'baseline-running', { intent: { kind: 'baseline' } })
    tracker.createExperiment({ experimentId: 'exp-0', runId: 'run-1', ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: [] })
    tracker.transitionExperiment('exp-0', 'running')
    tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'baseline' })
    tracker.transitionRun('run-1', 'ready', { best: { metric: 1, commit: SHA, experimentId: 'exp-0' } })
    expect(tracker.listTransitions('run-1').map((row) => row['sequence'])).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => tracker.transitionRun('run-1', 'baseline-running')).toThrowError(TrackerTransitionError)
    tracker.close()
  })

  it('persists intent before observed evaluator facts and reports uncertain restart state without trusting PID', () => {
    const tracker = DurableTracker.open(fixturePath())
    tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { command: 'node', args: ['evaluate.mjs'] })
    let recovery = tracker.recoveryState('run-1')
    expect(recovery.unresolvedAttempt).toMatchObject({ spawn_intent_json: '{"args":["evaluate.mjs"],"command":"node"}', provider_pid: null })
    expect(recovery.processDisposition).toBe('uncertain')
    tracker.recordAttemptObserved('attempt-1', { providerAttemptId: 'provider-1', providerPid: 12345, spawnedAt: '2026-01-01T00:00:00.000Z' })
    recovery = tracker.recoveryState('run-1')
    expect(recovery.unresolvedAttempt).toMatchObject({ provider_attempt_id: 'provider-1', provider_pid: 12345, process_tree_quiescent: null })
    expect(recovery.processDisposition).toBe('uncertain')
    tracker.recordAttemptObserved('attempt-1', { exitedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, processTreeQuiescent: true })
    expect(tracker.recoveryState('run-1').processDisposition).toBe('quiescent')
    tracker.close()
  })

  it('atomically writes experiment outcome and artifact references, rolling back every partial fact on failure', () => {
    const tracker = DurableTracker.open(fixturePath())
    tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    const duplicate = artifact()
    expect(() => tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept', artifacts: [duplicate, duplicate] })).toThrow()
    expect(tracker.database.prepare('SELECT state, metric, decision FROM experiments WHERE experiment_id = ?').get('exp-0')).toEqual({ state: 'running', metric: null, decision: null })
    expect(tracker.database.prepare('SELECT count(*) AS count FROM artifacts').get()).toEqual({ count: 0 })
    tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept', outcome: { measured: true }, artifacts: [duplicate] })
    expect(tracker.database.prepare('SELECT count(*) AS count FROM transition_artifacts').get()).toEqual({ count: 1 })
    tracker.close()
  })

  it('requires durable terminal quiescence before stale active-lock release', () => {
    const tracker = DurableTracker.open(fixturePath())
    tracker.createRun(initial()); tracker.acquireActiveLock('run-1', 'repo-identity', 'test')
    expect(() => tracker.releaseActiveLock('run-1')).toThrowError(TrackerTransitionError)
    tracker.transitionRun('run-1', 'blocked', { terminalReason: 'external mutation', blockedCode: 'external-mutation', quiescent: true })
    expect(tracker.recoveryState('run-1').safeToReleaseTerminalLock).toBe(true)
    expect(tracker.releaseActiveLock('run-1')).toBe(true)
    expect(tracker.recoveryState('run-1').activeLock).toBeUndefined()
    tracker.createRun({ ...initial('run-2'), runTag: 'test', branch: 'autoresearch/test-run-2', worktree: '/state/run-2/worktree' })
    tracker.acquireActiveLock('run-2', 'repo-identity', 'test')
    tracker.close()
  })

  it('exports deterministic atomic TSV and recovery remains SQLite-only when TSV is absent or corrupt', () => {
    const databasePath = fixturePath()
    const exportPath = join(databasePath, '..', 'compat', 'experiments.tsv')
    mkdirSync(join(databasePath, '..', 'compat'))
    const tracker = DurableTracker.open(databasePath)
    tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    tracker.commitTerminalExperiment('exp-0', 'crashed', { exitCode: 1, signal: null, timedOut: false, failureCode: 'exit', failureMessage: 'line one\nline two' }, exportPath)
    const first = readFileSync(exportPath, 'utf8')
    tracker.exportTsv(exportPath)
    expect(readFileSync(exportPath, 'utf8')).toBe(first)
    expect(first).toContain('line one\\nline two')
    rmSync(exportPath)
    expect(tracker.recoveryState('run-1').run).toMatchObject({ state: 'baseline-running' })
    writeFileSync(exportPath, 'corrupted and not authoritative')
    expect(tracker.recoveryState('run-1').unresolvedExperiment).toBeUndefined()
    tracker.close()
  })
})
