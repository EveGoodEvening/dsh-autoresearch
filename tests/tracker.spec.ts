import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableTracker, TRACKER_BUSY_TIMEOUT_MS, TRACKER_SCHEMA_VERSION, TrackerBlockedError, TrackerTransitionError } from '../src/tracker.ts'

const roots: string[] = []
const SHA = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
function fixturePath(name = 'tracker.sqlite'): string { const root = mkdtempSync(join(tmpdir(), 'autoresearch-tracker-')); roots.push(root); return join(root, name) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const trackerModuleUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'tracker.ts')).href

function trackerWorker(operation: string, data: Record<string, unknown>, barrier?: SharedArrayBuffer): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>()
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { registerHooks } = require('node:module');
    const { readFileSync } = require('node:fs');
    const ts = require('typescript');
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('./') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) specifier = specifier.slice(0, -3) + '.ts';
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (!url.endsWith('.ts')) return nextLoad(url, context);
        const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
        return { format: 'module', source, shortCircuit: true };
      }
    });
    (async () => {
      try {
        if (workerData.barrier) { const gate = new Int32Array(workerData.barrier); Atomics.add(gate, 0, 1); Atomics.notify(gate, 0); Atomics.wait(gate, 1, 0); }
        // Runtime-selected source URL lets worker threads exercise the implementation under test.
        const { DurableTracker } = await import(workerData.moduleUrl);
        const tracker = DurableTracker.open(workerData.data.path);
        if (workerData.operation === 'export') tracker.exportTsv(workerData.data.runId, workerData.data.destination);
        const version = tracker.schemaVersion(); tracker.close(); parentPort.postMessage({ ok: true, version });
      } catch (error) { parentPort.postMessage({ ok: false, name: error?.name, code: error?.code, status: error?.status, message: error?.message, causeCode: error?.cause?.code, causeErrcode: error?.cause?.errcode }); }
    })();
  `, { eval: true, workerData: { moduleUrl: trackerModuleUrl, operation, data, barrier } })
  worker.once('message', (message: Record<string, unknown>) => resolve(message))
  worker.once('error', reject)
  worker.once('exit', (code) => { if (code !== 0) reject(new Error(`tracker worker exited ${code}`)) })
  return promise
}

async function releaseWorkers(barrier: SharedArrayBuffer, count: number): Promise<void> {
  const gate = new Int32Array(barrier)
  while (Atomics.load(gate, 0) !== count) await new Promise((resolve) => setTimeout(resolve, 5))
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1, count)
}

function initial(runId = 'run-1') {
  return {
    runId, repositoryId: 'repo-identity', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: SHA,
    runTag: 'test', branch: `autoresearch/test-${runId}`, worktree: `/state/${runId}/worktree`, agentId: 'agent-1', sessionId: 'session-1',
    policy: { metric: 'score', direction: 'minimize', environment: { TOKEN: 'secret-value' }, nested: { z: 1, a: 2 } }, policySha256: HASH,
    provenance: { evaluator: 'v1', environment: { API_KEY: 'another-secret' } }, provenanceSha256: HASH,
  }
}
function artifact(id = 'stdout', overrides: Record<string, unknown> = {}) {
  return { artifactId: id, runId: 'run-1', experimentId: 'exp-0', attemptId: 'attempt-1', kind: id, location: `artifacts/${id}.txt`, sizeBytes: 4, sha256: HASH, owner: 'evaluator', retention: 'retain', ...overrides }
}
function createRunningExperiment(tracker: DurableTracker, runId = 'run-1', experimentId = 'exp-0'): void {
  tracker.transitionRun(runId, 'baseline-running')
  tracker.createExperiment({ experimentId, runId, ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: ['evaluate.mjs'] })
  tracker.transitionExperiment(experimentId, 'running', { intent: { kind: 'evaluate' } })
}
function finishAttempt(tracker: DurableTracker, attemptId = 'attempt-1'): void {
  tracker.recordAttemptObserved(attemptId, { exitedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true })
}

describe('durable SQLite tracker', () => {
  it('creates owner-only state, redacts environment values, and idempotently reopens a versioned WAL database', () => {
    const path = fixturePath(); const tracker = DurableTracker.open(path); tracker.createRun(initial())
    expect(tracker.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION)
    expect(tracker.foreignKeysEnabled()).toBe(true)
    expect(tracker.journalMode()).toBe('wal')
    expect(tracker.database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: TRACKER_BUSY_TIMEOUT_MS })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const row = tracker.getRun('run-1')!
    expect(String(row['policy_json'])).not.toContain('secret-value')
    expect(String(row['provenance_json'])).not.toContain('another-secret')
    expect(String(row['policy_json'])).toMatch(/"TOKEN":\{"sha256":"[a-f0-9]{64}"\}/)
    tracker.close()
    const reopened = DurableTracker.open(path)
    expect(reopened.getRun('run-1')).toMatchObject({ repository_id: 'repo-identity', start_commit: SHA, provenance_sha256: HASH })
    reopened.close()
  })

  it('migrates under a write transaction and classifies newer, malformed, and corrupt schemas', () => {
    const path = fixturePath(); const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, 0, 'now')")
    seed.close(); chmodSync(path, 0o600)
    const migrated = DurableTracker.open(path); expect(migrated.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION); migrated.close()
    const second = DurableTracker.open(path); expect(second.schemaVersion()).toBe(TRACKER_SCHEMA_VERSION); second.close()
    const newer = new DatabaseSync(path); newer.prepare('UPDATE schema_metadata SET version = ?').run(TRACKER_SCHEMA_VERSION + 1); newer.close()
    expectBlocked(path, 'tracker-schema-newer')

    const corruptPath = fixturePath('corrupt.sqlite'); writeFileSync(corruptPath, 'not a sqlite database', { mode: 0o600 }); expectBlocked(corruptPath, 'tracker-schema-invalid')
    const malformedPath = fixturePath('malformed.sqlite'); const malformed = new DatabaseSync(malformedPath); malformed.exec(`CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, ${TRACKER_SCHEMA_VERSION}, 'now')`); malformed.close(); chmodSync(malformedPath, 0o600); expectBlocked(malformedPath, 'tracker-schema-invalid')
  })

  it('eventually converges competing opens while migrating an old schema', async () => {
    const path = fixturePath(); const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, 0, 'now')")
    seed.close(); chmodSync(path, 0o600)
    const barrier = new SharedArrayBuffer(8)
    const opens = Array.from({ length: 4 }, () => trackerWorker('open', { path }, barrier))
    await releaseWorkers(barrier, opens.length)
    expect(await Promise.all(opens)).toEqual(Array.from({ length: opens.length }, () => ({ ok: true, version: TRACKER_SCHEMA_VERSION })))
    const inspect = new DatabaseSync(path, { readOnly: true })
    expect(inspect.prepare('SELECT version FROM schema_metadata').get()).toEqual({ version: TRACKER_SCHEMA_VERSION }); inspect.close()
  }, 15_000)

  it('classifies exhausted SQLite writer contention as a typed busy error with its cause', () => {
    const path = fixturePath(); const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, 0, 'now')"); chmodSync(path, 0o600); seed.exec('BEGIN IMMEDIATE')
    try {
      DurableTracker.open(path); throw new Error('expected tracker open to exhaust its busy timeout')
    } catch (error) {
      expect(error).toMatchObject({ name: 'TrackerBlockedError', status: 'blocked', code: 'tracker-busy' })
      const cause = (error as TrackerBlockedError).cause as { errcode?: number }
      expect([5, 6]).toContain((cause.errcode ?? 0) & 0xff)
    } finally { seed.exec('ROLLBACK'); seed.close() }
  }, TRACKER_BUSY_TIMEOUT_MS + 2_000)

  it('rolls a failed migration back without advancing metadata', () => {
    const path = fixturePath(); const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata VALUES (1, 1, 'now'); CREATE TABLE runs (run_id TEXT PRIMARY KEY) STRICT")
    seed.close(); chmodSync(path, 0o600)
    expectBlocked(path, 'tracker-schema-invalid')
    const inspect = new DatabaseSync(path, { readOnly: true })
    expect(inspect.prepare('SELECT version FROM schema_metadata').get()).toEqual({ version: 1 })
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('runs') WHERE name='terminal_quiescent'").get()).toEqual({ count: 0 })
    inspect.close()
  })

  it('enforces foreign keys, monotonic transition sequences, and exact state transitions', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial())
    expect(() => tracker.createExperiment({ experimentId: 'orphan', runId: 'missing', ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: [] })).toThrow()
    createRunningExperiment(tracker)
    tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept' })
    tracker.transitionRun('run-1', 'ready', { best: { metric: 1, commit: SHA, experimentId: 'exp-0' } })
    expect(tracker.listTransitions('run-1').map((row) => row['sequence'])).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => tracker.transitionRun('run-1', 'baseline-running')).toThrowError(TrackerTransitionError)
    tracker.close()
  })

  it('merges attempt observations monotonically, rejects conflicts, and preserves all facts after reopen', () => {
    const path = fixturePath(); const tracker = DurableTracker.open(path); tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { command: 'node', args: ['evaluate.mjs'] })
    tracker.recordAttemptObserved('attempt-1', { providerAttemptId: 'provider-1', providerPid: 12345, providerIdentity: 'provider-proof', spawnedAt: '2026-01-01T00:00:00.000Z' })
    finishAttempt(tracker)
    expect(() => tracker.recordAttemptObserved('attempt-1', { providerPid: 999 })).toThrowError(TrackerTransitionError)
    tracker.close()
    const reopened = DurableTracker.open(path); const attempt = reopened.recoveryState('run-1').unresolvedAttempt
    expect(attempt).toMatchObject({ provider_attempt_id: 'provider-1', provider_pid: 12345, provider_identity: 'provider-proof', spawned_at: '2026-01-01T00:00:00.000Z', exited_at: '2026-01-01T00:01:00.000Z', exit_code: 0, signal: null, timed_out: 0, process_tree_quiescent: 1 })
    reopened.close()
  })

  it('derives whole-process-tree quiescence before terminal persistence and lock release', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); tracker.acquireActiveLock('run-1', 'repo-identity', 'test'); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    expect(() => tracker.transitionRun('run-1', 'blocked', { terminalReason: 'stop', blockedCode: 'stop', quiescent: true })).toThrowError(TrackerTransitionError)
    expect(tracker.getRun('run-1')).toMatchObject({ state: 'baseline-running', terminal_at: null, terminal_quiescent: null, blocked_code: null })
    expect(() => tracker.releaseActiveLock('run-1')).toThrowError(TrackerTransitionError)
    finishAttempt(tracker)
    tracker.transitionExperiment('exp-0', 'cancelled', { failureCode: 'cancelled', failureMessage: 'run stopped', timedOut: false })
    tracker.transitionRun('run-1', 'blocked', { terminalReason: 'stop', blockedCode: 'stop' })
    expect(tracker.recoveryState('run-1').safeToReleaseTerminalLock).toBe(true)
    expect(tracker.releaseActiveLock('run-1')).toBe(true)
    tracker.close()
  })
  it('persists recoverable same-state blocked evidence while retaining the lock and nonterminal state', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); tracker.acquireActiveLock('run-1', 'repo-identity', 'test'); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    tracker.checkpointRecoverableBlocked('run-1', { code: 'evaluator-survival-uncertain', evidence: ['provider identity unavailable'] })
    expect(tracker.getRun('run-1')).toMatchObject({ state: 'baseline-running', terminal_at: null, terminal_quiescent: null, blocked_code: 'evaluator-survival-uncertain' })
    expect(tracker.recoveryState('run-1')).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false, activeLock: { run_id: 'run-1' } })
    expect(() => tracker.releaseActiveLock('run-1')).toThrowError(TrackerTransitionError)
    tracker.close()
  })

  it('atomically records attempt outcome, quiescence, artifacts, and their durable checkpoint linkage', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    expect(() => tracker.recordAttemptOutcome('attempt-1', { facts: { exitedAt: 'now', exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true }, artifacts: [artifact('wrong', { attemptId: 'missing' })] })).toThrow(/ownership/)
    expect(tracker.recoveryState('run-1').unresolvedAttempt).toMatchObject({ exited_at: null, process_tree_quiescent: null })
    tracker.recordAttemptOutcome('attempt-1', { facts: { exitedAt: 'now', exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true }, artifacts: [artifact()] })
    expect(tracker.recoveryState('run-1').unresolvedAttempt).toMatchObject({ exited_at: 'now', process_tree_quiescent: 1 })
    expect(tracker.database.prepare('SELECT artifact_id FROM artifacts').all()).toEqual([{ artifact_id: 'stdout' }])
    expect(tracker.database.prepare('SELECT transition_id, artifact_id FROM transition_artifacts').all()).toContainEqual({ transition_id: 'run-1:5', artifact_id: 'stdout' })
    tracker.close()
  })


  it('enforces coherent artifact and transition ownership transactionally across experiments and runs', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker)
    tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    tracker.createRun({ ...initial('run-2'), runTag: 'other', branch: 'autoresearch/other-run-2', worktree: '/state/run-2/worktree' })
    createRunningExperiment(tracker, 'run-2', 'exp-2')
    tracker.createAttemptIntent({ attemptId: 'attempt-2', runId: 'run-2', experimentId: 'exp-2', ordinal: 1 }, { kind: 'spawn' })
    expect(() => tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept', artifacts: [artifact('cross-run', { runId: 'run-2', experimentId: 'exp-2', attemptId: 'attempt-2' })] })).toThrowError(/artifact run/)
    expect(() => tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept', artifacts: [artifact('cross-attempt', { attemptId: 'attempt-2' })] })).toThrowError(/ownership/)
    expect(tracker.database.prepare('SELECT count(*) AS count FROM artifacts').get()).toEqual({ count: 0 })
    expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('exp-0')).toEqual({ state: 'running' })
    tracker.close()
  })

  it.each([
    ['accepted', { metric: 1, decision: 'accept' }],
    ['rejected', { metric: 2, decision: 'reject' }],
    ['crashed', { exitCode: 1, timedOut: false, failureCode: 'exit', failureMessage: 'failed' }],
    ['timed-out', { timedOut: true, failureCode: 'timeout', failureMessage: 'deadline' }],
    ['policy-violation', { timedOut: false, failureCode: 'policy', failureMessage: 'changed forbidden path' }],
    ['cancelled', { timedOut: false, failureCode: 'cancelled', failureMessage: 'requested' }],
  ] as const)('persists coherent %s terminal experiment facts', (state, facts) => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker); tracker.transitionExperiment('exp-0', state, facts); expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('exp-0')).toEqual({ state }); tracker.close()
  })

  it('rejects incomplete or contradictory experiment terminal facts', () => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker)
    expect(() => tracker.transitionExperiment('exp-0', 'accepted', { decision: 'accept' })).toThrowError(/metric/)
    expect(() => tracker.transitionExperiment('exp-0', 'rejected', { metric: 1, decision: 'reject', failureCode: 'exit', failureMessage: 'bad' })).toThrowError(/failure/)
    expect(() => tracker.transitionExperiment('exp-0', 'crashed', { exitCode: 1 })).toThrowError(/failure code/)
    expect(() => tracker.transitionExperiment('exp-0', 'timed-out', { timedOut: false, failureCode: 'timeout', failureMessage: 'late' })).toThrowError(/timedOut=true/)
    tracker.close()
  })

  it.each([
    ['accepted', 'reject'],
    ['rejected', 'accept'],
    ['accepted', 'arbitrary'],
    ['rejected', 'arbitrary'],
  ] as const)('%s rejects mismatched decision %s', (state, decision) => {
    const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker)
    expect(() => tracker.transitionExperiment('exp-0', state, { metric: 1, decision: decision as 'accept' | 'reject' })).toThrowError(/requires a finite metric and decision/)
    expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('exp-0')).toEqual({ state: 'running' })
    tracker.close()
  })

  it.each(['accepted', 'rejected'] as const)('%s rejects every explicitly supplied failure-shaped field', (state) => {
    const contradictions = [{ exitCode: null }, { exitCode: 0 }, { signal: null }, { signal: 'SIGTERM' }, { timedOut: false }, { timedOut: true }, { failureCode: undefined }, { failureCode: 'exit' }, { failureMessage: undefined }, { failureMessage: 'bad' }]
    for (const contradiction of contradictions) {
      const tracker = DurableTracker.open(fixturePath()); tracker.createRun(initial()); createRunningExperiment(tracker)
      expect(() => tracker.transitionExperiment('exp-0', state, { metric: 1, decision: state === 'accepted' ? 'accept' : 'reject', ...contradiction })).toThrowError(/failure facts/)
      tracker.close()
    }
  })

  it('publishes deterministic run-scoped TSV atomically and retries independently from committed state', () => {
    const databasePath = fixturePath(); const exportPath = join(databasePath, '..', 'compat', 'experiments.tsv'); mkdirSync(join(databasePath, '..', 'compat'), { mode: 0o700 })
    const tracker = DurableTracker.open(databasePath); tracker.createRun(initial()); createRunningExperiment(tracker); tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: 'run-1', experimentId: 'exp-0', ordinal: 1 }, { kind: 'spawn' })
    tracker.commitTerminalExperiment('exp-0', 'crashed', { exitCode: 1, signal: null, timedOut: false, failureCode: 'exit', failureMessage: 'line one\nline two' })
    const escape = join(databasePath, '..', 'escape'); symlinkSync(tmpdir(), escape)
    expect(() => tracker.exportTsv('run-1', join(escape, 'stolen.tsv'))).toThrow()
    expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('exp-0')).toEqual({ state: 'crashed' })
    tracker.exportTsv('run-1', exportPath); const first = readFileSync(exportPath, 'utf8'); tracker.exportTsv('run-1', exportPath)
    expect(readFileSync(exportPath, 'utf8')).toBe(first); expect(first).toContain('line one\\nline two'); expect(statSync(exportPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(databasePath, '..', 'compat', 'experiments.tsv'), 'utf8').split('\n')).toHaveLength(first.split('\n').length)
    tracker.close()
  })

  it('atomically publishes one run-scoped TSV under concurrent writers', async () => {
    const databasePath = fixturePath(); const exportPath = join(databasePath, '..', 'compat', 'experiments.tsv'); mkdirSync(join(databasePath, '..', 'compat'), { mode: 0o700 })
    const tracker = DurableTracker.open(databasePath); tracker.createRun(initial()); createRunningExperiment(tracker); tracker.transitionExperiment('exp-0', 'accepted', { metric: 1, decision: 'accept' }); tracker.close()
    const barrier = new SharedArrayBuffer(8)
    const writers = [trackerWorker('export', { path: databasePath, runId: 'run-1', destination: exportPath }, barrier), trackerWorker('export', { path: databasePath, runId: 'run-1', destination: exportPath }, barrier)]
    await releaseWorkers(barrier, writers.length)
    expect(await Promise.all(writers)).toEqual([{ ok: true, version: TRACKER_SCHEMA_VERSION }, { ok: true, version: TRACKER_SCHEMA_VERSION }])
    const published = readFileSync(exportPath, 'utf8')
    expect(published.split('\n')).toHaveLength(3); expect(published).toContain('exp-0'); expect(statSync(exportPath).mode & 0o777).toBe(0o600)
  }, 15_000)

  it('rejects public or symlinked state roots and arbitrary export destinations', () => {
    const publicRoot = mkdtempSync(join(tmpdir(), 'autoresearch-public-')); roots.push(publicRoot); chmodSync(publicRoot, 0o755)
    expect(() => DurableTracker.open(join(publicRoot, 'tracker.sqlite'))).toThrow(/state root/)
    const path = fixturePath(); const tracker = DurableTracker.open(path); tracker.createRun(initial())
    expect(() => tracker.exportTsv('run-1', join(tmpdir(), 'outside.tsv'))).toThrow(/beneath state root/)
    tracker.close()
  })
})

function expectBlocked(path: string, code: string): void {
  try { DurableTracker.open(path); throw new Error('expected tracker open to block') } catch (error) { expect(error).toBeInstanceOf(TrackerBlockedError); expect(error).toMatchObject({ status: 'blocked', code }) }
}
