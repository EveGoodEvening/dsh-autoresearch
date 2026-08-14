import { closeSync, chmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, relative } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { StateLayout } from './state-layout.js'
import type { ExperimentDurableState, RunDurableState } from './types.js'

export const TRACKER_SCHEMA_VERSION = 4
export const TRACKER_BUSY_TIMEOUT_MS = 5_000
const TRACKER_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4))

const RUN_TERMINAL: Readonly<Record<RunDurableState, boolean>> = {
  initializing: false, 'baseline-running': false, ready: false, 'candidate-prepared': false, 'candidate-running': false, deciding: false,
  completed: true, 'baseline-blocked': true, blocked: true, 'round-failed': true, cancelled: true,
}
const EXPERIMENT_TERMINAL: Readonly<Record<ExperimentDurableState, boolean>> = {
  'baseline-pending': false, running: false, accepted: true, rejected: true, crashed: true, 'timed-out': true, 'policy-violation': true, cancelled: true,
}
const RUN_TRANSITIONS: Readonly<Record<RunDurableState, readonly RunDurableState[]>> = {
  initializing: ['baseline-running', 'baseline-blocked', 'blocked', 'cancelled'],
  'baseline-running': ['ready', 'completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'],
  ready: ['candidate-prepared', 'completed', 'blocked', 'round-failed', 'cancelled'],
  'candidate-prepared': ['candidate-running', 'blocked', 'round-failed', 'cancelled'],
  'candidate-running': ['deciding', 'blocked', 'round-failed', 'cancelled'],
  deciding: ['ready', 'completed', 'blocked', 'round-failed', 'cancelled'],
  completed: [], 'baseline-blocked': [], blocked: [], 'round-failed': [], cancelled: [],
}
const EXPERIMENT_TRANSITIONS: Readonly<Record<ExperimentDurableState, readonly ExperimentDurableState[]>> = {
  'baseline-pending': ['running', 'cancelled'], running: ['accepted', 'rejected', 'crashed', 'timed-out', 'policy-violation', 'cancelled'],
  accepted: [], rejected: [], crashed: [], 'timed-out': [], 'policy-violation': [], cancelled: [],
}

export class TrackerBlockedError extends Error {
  readonly status = 'blocked' as const
  constructor(readonly code: 'tracker-schema-newer' | 'tracker-schema-invalid' | 'tracker-busy', message: string, readonly cause?: unknown) { super(message); this.name = 'TrackerBlockedError' }
}
export class TrackerTransitionError extends Error { constructor(message: string) { super(message); this.name = 'TrackerTransitionError' } }

export interface InitialRunRecord {
  runId: string; repositoryId: string; repository: string; gitCommonDir: string; callerCwd: string; startCommit: string
  runTag: string; branch: string; worktree: string; agentId?: string; sessionId?: string
  policy: unknown; policySha256: string; provenance: unknown; provenanceSha256: string; createdAt?: string
}
export interface ExperimentRecord {
  experimentId: string; runId: string; ordinal: number; kind: 'baseline' | 'candidate'; parentCommit: string
  candidateCommit?: string; command: string; args: readonly string[]; cwd?: string; createdAt?: string
}
export interface AttemptRecord { attemptId: string; runId: string; experimentId: string; ordinal: number; providerAttemptId?: string; createdAt?: string }
export interface ArtifactRecord {
  artifactId: string; runId: string; experimentId?: string; attemptId?: string; kind: string; location: string
  sizeBytes: number; sha256: string; owner: string; retention: string; metadata?: unknown; createdAt?: string
}
export interface TransitionFacts {
  intent?: unknown; outcome?: unknown; terminalReason?: string; blockedCode?: string; quiescent?: boolean
  best?: { metric: number; commit: string; experimentId: string }; artifacts?: readonly ArtifactRecord[]
}
export interface ExperimentTransitionFacts extends TransitionFacts {
  metric?: number; decision?: 'accept' | 'reject'; exitCode?: number | null; signal?: string | null; timedOut?: boolean; failureCode?: string; failureMessage?: string
}
export interface AttemptOutcome {
  providerAttemptId?: string; providerPid?: number; providerIdentity?: string; spawnedAt?: string; exitedAt?: string
  exitCode?: number | null; signal?: string | null; timedOut?: boolean; processTreeQuiescent?: boolean; failureCode?: string; failureMessage?: string
}
export interface AttemptOutcomeCheckpoint {
  readonly facts: AttemptOutcome
  readonly artifacts: readonly ArtifactRecord[]
  readonly outcome?: unknown
}
export interface RecoverableBlockedEvidence {
  readonly code: string
  readonly evidence: readonly string[]
}


export interface RecoveryState {
  run: Record<string, SQLOutputValue>; unresolvedExperiment?: Record<string, SQLOutputValue>; unresolvedAttempt?: Record<string, SQLOutputValue>
  activeLock?: Record<string, SQLOutputValue>; safeToReleaseTerminalLock: boolean; processDisposition: 'none' | 'quiescent' | 'uncertain'
}

export class DurableTracker {
  readonly database: DatabaseSync
  readonly layout: StateLayout
  private closed = false
  private constructor(readonly path: string, database: DatabaseSync, layout: StateLayout) { this.database = database; this.layout = layout }

  static open(path: string): DurableTracker {
    const layout = StateLayout.open(dirname(path)); const safePath = layout.assertContained(path)
    const deadline = Date.now() + TRACKER_BUSY_TIMEOUT_MS
    let lastBusyError: unknown
    let retryDelayMs = 1
    while (true) {
      let database: DatabaseSync | undefined
      try {
        const remainingMs = Math.max(1, deadline - Date.now())
        database = new DatabaseSync(safePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, timeout: remainingMs })
        chmodSync(safePath, 0o600)
        const tracker = new DurableTracker(safePath, database, layout)
        tracker.configure(remainingMs); tracker.migrate(deadline); tracker.validateSchema(); tracker.secureSidecars()
        tracker.database.exec(`PRAGMA busy_timeout = ${TRACKER_BUSY_TIMEOUT_MS}`)
        return tracker
      } catch (error) {
        try { database?.close() } catch { /* preserve original failure */ }
        if (error instanceof TrackerBlockedError) throw error
        if (!isSqliteBusyOrLocked(error)) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker is corrupt, malformed, or has an incompatible schema', error)
        lastBusyError = error
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) throw new TrackerBlockedError('tracker-busy', 'tracker schema is busy after the configured timeout', lastBusyError)
        sleep(Math.min(retryDelayMs, remainingMs))
        retryDelayMs = Math.min(retryDelayMs * 2, 50)
      }
    }
  }
  close(): void { if (!this.closed) { this.database.close(); this.closed = true } }
  schemaVersion(): number { return Number(this.database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get()!['version']) }
  foreignKeysEnabled(): boolean { return Number(this.database.prepare('PRAGMA foreign_keys').get()!['foreign_keys']) === 1 }
  journalMode(): string { return String(this.database.prepare('PRAGMA journal_mode').get()!['journal_mode']) }

  createRun(record: InitialRunRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      this.database.prepare(`INSERT INTO runs (run_id, repository_id, repository, git_common_dir, caller_cwd, start_commit, run_tag, branch, worktree,
        agent_id, session_id, policy_json, policy_sha256, provenance_json, provenance_sha256, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`).run(
        record.runId, record.repositoryId, record.repository, record.gitCommonDir, record.callerCwd, record.startCommit, record.runTag, record.branch, record.worktree,
        record.agentId ?? null, record.sessionId ?? null, canonicalJson(redactEnvironment(record.policy)), record.policySha256,
        canonicalJson(redactEnvironment(record.provenance)), record.provenanceSha256, at, at)
      this.insertTransition(record.runId, null, 'run', null, 'initializing', { intent: { kind: 'create-run' } }, at)
    })
  }
  acquireActiveLock(runId: string, repositoryId: string, runTag: string, acquiredAt = new Date().toISOString()): void {
    this.transaction(() => { const run = this.requireRun(runId); if (run['repository_id'] !== repositoryId || run['run_tag'] !== runTag) throw new TrackerTransitionError('active lock identity must match immutable run identity'); this.database.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, runTag, runId, acquiredAt) })
  }
  releaseActiveLock(runId: string, releasedAt = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const run = this.requireRun(runId)
      if (!RUN_TERMINAL[String(run['state']) as RunDurableState] || run['terminal_quiescent'] !== 1 || !this.isRunQuiescent(runId)) throw new TrackerTransitionError('active lock release requires terminal persistence and durable whole-process-tree quiescence')
      return Number(this.database.prepare('UPDATE active_locks SET released_at = ? WHERE run_id = ? AND released_at IS NULL').run(releasedAt, runId).changes) === 1
    })
  }

  createExperiment(record: ExperimentRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      this.requireRun(record.runId)
      if (this.database.prepare(`SELECT 1 FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running')`).get(record.runId)) throw new TrackerTransitionError('a run may not create a new experiment while another is unresolved')
      this.database.prepare(`INSERT INTO experiments (experiment_id, run_id, ordinal, kind, parent_commit, candidate_commit, state, command, args_json, cwd, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'baseline-pending', ?, ?, ?, ?, ?)`).run(record.experimentId, record.runId, record.ordinal, record.kind, record.parentCommit, record.candidateCommit ?? null, record.command, canonicalJson(record.args), record.cwd ?? null, at, at)
      this.insertTransition(record.runId, record.experimentId, 'experiment', null, 'baseline-pending', { intent: { kind: 'create-experiment' } }, at)
    })
  }
  recordCandidateCommit(experimentId: string, candidateCommit: string, updatedAt = new Date().toISOString()): void {
    if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) throw new TrackerTransitionError('candidate commit must be a full lowercase SHA')
    this.transaction(() => {
      const experiment = this.requireExperiment(experimentId)
      if (experiment['kind'] !== 'candidate' || experiment['state'] !== 'baseline-pending') throw new TrackerTransitionError('candidate commit outcome requires a pending candidate experiment')
      if (experiment['candidate_commit'] === candidateCommit) return
      if (experiment['candidate_commit'] !== null) throw new TrackerTransitionError('candidate commit conflicts with durable lineage')
      this.database.prepare('UPDATE experiments SET candidate_commit = ?, updated_at = ? WHERE experiment_id = ?').run(candidateCommit, updatedAt, experimentId)
    })
  }

  createAttemptIntent(record: AttemptRecord, intent: unknown): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => { const experiment = this.requireExperiment(record.experimentId); if (experiment['state'] !== 'running') throw new TrackerTransitionError('attempt spawn intent requires a running experiment'); if (experiment['run_id'] !== record.runId) throw new TrackerTransitionError('attempt ownership must match experiment run'); this.database.prepare(`INSERT INTO attempts (attempt_id, run_id, experiment_id, ordinal, provider_attempt_id, spawn_intent_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.attemptId, record.runId, record.experimentId, record.ordinal, record.providerAttemptId ?? null, canonicalJson(intent), at, at) })
  }
  recordAttemptObserved(attemptId: string, facts: AttemptOutcome, updatedAt = new Date().toISOString()): void {
    this.transaction(() => {
      const attempt = this.database.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
      if (!attempt) throw new TrackerTransitionError(`unknown attempt ${attemptId}`)
      this.mergeAttemptObservation(attempt, facts, updatedAt)
    })
  }
  checkpointRun(runId: string, facts: TransitionFacts, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const run = this.requireRun(runId)
      const state = String(run['state']) as RunDurableState
      if (RUN_TERMINAL[state]) throw new TrackerTransitionError('same-state checkpoints require a nonterminal run')
      this.validateAndInsertArtifacts(runId, null, facts.artifacts ?? [])
      this.database.prepare('UPDATE runs SET updated_at = ?, blocked_code = COALESCE(?, blocked_code) WHERE run_id = ?').run(at, facts.blockedCode ?? null, runId)
      return this.insertTransition(runId, null, 'run', state, state, facts, at)
    })
  }
  checkpointRecoverableBlocked(runId: string, blocked: RecoverableBlockedEvidence, at = new Date().toISOString()): number {
    if (!blocked.code.trim() || blocked.evidence.length === 0 || blocked.evidence.some(item => !item.trim())) throw new TrackerTransitionError('recoverable blocked checkpoint requires typed non-empty evidence')
    return this.transaction(() => {
      const run = this.requireRun(runId)
      const state = String(run['state']) as RunDurableState
      if (RUN_TERMINAL[state]) throw new TrackerTransitionError('recoverable blocked checkpoint requires a nonterminal run')
      if (!this.database.prepare('SELECT 1 FROM active_locks WHERE run_id = ? AND released_at IS NULL').get(runId) || this.isRunQuiescent(runId)) throw new TrackerTransitionError('recoverable blocked checkpoint requires an active lock and uncertain process disposition')
      const outcome = { kind: 'recoverable-blocked', evidence: [...blocked.evidence] }
      this.database.prepare('UPDATE runs SET updated_at = ?, blocked_code = ? WHERE run_id = ?').run(at, blocked.code, runId)
      return this.insertTransition(runId, null, 'run', state, state, { blockedCode: blocked.code, outcome }, at)
    })
  }
  checkpointExperiment(experimentId: string, facts: ExperimentTransitionFacts, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const experiment = this.requireExperiment(experimentId)
      const state = String(experiment['state']) as ExperimentDurableState
      if (EXPERIMENT_TERMINAL[state]) throw new TrackerTransitionError('same-state checkpoints require a nonterminal experiment')
      if (facts.metric !== undefined && !Number.isFinite(facts.metric)) throw new TrackerTransitionError('experiment checkpoint metric must be finite')
      const runId = String(experiment['run_id'])
      this.validateAndInsertArtifacts(runId, experimentId, facts.artifacts ?? [])
      this.database.prepare('UPDATE experiments SET metric = COALESCE(?, metric), decision = COALESCE(?, decision), failure_code = COALESCE(?, failure_code), failure_message = COALESCE(?, failure_message), updated_at = ? WHERE experiment_id = ?').run(facts.metric ?? null, facts.decision ?? null, facts.failureCode ?? null, facts.failureMessage ?? null, at, experimentId)
      return this.insertTransition(runId, experimentId, 'experiment', state, state, facts, at)
    })
  }


  recordAttemptOutcome(attemptId: string, checkpoint: AttemptOutcomeCheckpoint, updatedAt = new Date().toISOString()): number {
    return this.transaction(() => {
      const attempt = this.database.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
      if (!attempt) throw new TrackerTransitionError(`unknown attempt ${attemptId}`)
      this.mergeAttemptObservation(attempt, checkpoint.facts, updatedAt)
      const runId = String(attempt['run_id'])
      const experimentId = String(attempt['experiment_id'])
      this.validateAndInsertArtifacts(runId, experimentId, checkpoint.artifacts)
      const run = this.requireRun(runId)
      const state = String(run['state']) as RunDurableState
      if (RUN_TERMINAL[state]) throw new TrackerTransitionError('attempt outcome requires a nonterminal run')
      return this.insertTransition(runId, experimentId, 'run', state, state, { outcome: checkpoint.outcome ?? checkpoint.facts, artifacts: checkpoint.artifacts }, updatedAt)
    })
  }


  transitionRun(runId: string, to: RunDurableState, facts: TransitionFacts = {}, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const run = this.requireRun(runId); const from = String(run['state']) as RunDurableState; validateTransition('run', from, to)
      if (RUN_TERMINAL[to]) {
        const quiescent = this.isRunQuiescent(runId)
        const unresolved = this.database.prepare(`SELECT 1 FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running') LIMIT 1`).get(runId)
        if (!quiescent && (to !== 'blocked' || unresolved)) throw new TrackerTransitionError('terminal run transition requires durable whole-process-tree quiescence for every attempt')
        if (unresolved) throw new TrackerTransitionError('terminal run transition requires every experiment to be terminal')
      }
      this.validateAndInsertArtifacts(runId, null, facts.artifacts ?? [])
      const terminalQuiescent = RUN_TERMINAL[to] ? Number(this.isRunQuiescent(runId)) : null
      this.database.prepare(`UPDATE runs SET state = ?, updated_at = ?, terminal_reason = ?, blocked_code = ?, terminal_at = ?, terminal_quiescent = ?,
        best_metric = COALESCE(?, best_metric), best_commit = COALESCE(?, best_commit), best_experiment_id = COALESCE(?, best_experiment_id) WHERE run_id = ?`).run(
        to, at, facts.terminalReason ?? null, facts.blockedCode ?? null, RUN_TERMINAL[to] ? at : null, terminalQuiescent,
        facts.best?.metric ?? null, facts.best?.commit ?? null, facts.best?.experimentId ?? null, runId)
      return this.insertTransition(runId, null, 'run', from, to, facts, at)
    })
  }
  transitionExperiment(experimentId: string, to: ExperimentDurableState, facts: ExperimentTransitionFacts = {}, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const experiment = this.requireExperiment(experimentId); const from = String(experiment['state']) as ExperimentDurableState; validateTransition('experiment', from, to); validateExperimentFacts(to, facts)
      const runId = String(experiment['run_id']); this.validateAndInsertArtifacts(runId, experimentId, facts.artifacts ?? [])
      this.database.prepare(`UPDATE experiments SET state = ?, metric = ?, decision = ?, exit_code = ?, signal = ?, timed_out = ?, failure_code = ?, failure_message = ?, terminal_at = ?, updated_at = ? WHERE experiment_id = ?`).run(
        to, facts.metric ?? null, facts.decision ?? null, facts.exitCode ?? null, facts.signal ?? null, facts.timedOut === undefined ? null : Number(facts.timedOut), facts.failureCode ?? null, facts.failureMessage ?? null, EXPERIMENT_TERMINAL[to] ? at : null, at, experimentId)
      return this.insertTransition(runId, experimentId, 'experiment', from, to, facts, at)
    })
  }
  commitTerminalExperiment(experimentId: string, to: Exclude<ExperimentDurableState, 'baseline-pending' | 'running'>, facts: ExperimentTransitionFacts, at = new Date().toISOString()): number { return this.transitionExperiment(experimentId, to, facts, at) }

  getRun(runId: string): Record<string, SQLOutputValue> | undefined { return this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) }
  listTransitions(runId: string): Record<string, SQLOutputValue>[] { return this.database.prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence').all(runId) }
  recoveryState(runId: string): RecoveryState {
    const run = this.requireRun(runId); const unresolvedExperiment = this.database.prepare(`SELECT * FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running') ORDER BY ordinal DESC LIMIT 1`).get(runId)
    const unresolvedAttempt = unresolvedExperiment ? this.database.prepare('SELECT * FROM attempts WHERE experiment_id = ? ORDER BY ordinal DESC LIMIT 1').get(unresolvedExperiment['experiment_id']!) : undefined
    const activeLock = this.database.prepare('SELECT * FROM active_locks WHERE run_id = ? AND released_at IS NULL').get(runId); const quiescent = this.isRunQuiescent(runId)
    return { run, ...(unresolvedExperiment ? { unresolvedExperiment } : {}), ...(unresolvedAttempt ? { unresolvedAttempt } : {}), ...(activeLock ? { activeLock } : {}), safeToReleaseTerminalLock: Boolean(activeLock && RUN_TERMINAL[String(run['state']) as RunDurableState] && run['terminal_quiescent'] === 1 && quiescent), processDisposition: !this.database.prepare('SELECT 1 FROM attempts WHERE run_id = ? LIMIT 1').get(runId) ? 'none' : quiescent ? 'quiescent' : 'uncertain' }
  }

  exportTsv(runId: string, path: string): void {
    this.requireRun(runId); const destination = this.layout.assertContained(path)
    const rows = this.database.prepare(`SELECT e.ordinal, e.kind, e.experiment_id, e.parent_commit, e.candidate_commit, e.state, e.metric, e.decision, e.exit_code, e.signal, e.timed_out, e.failure_code, e.failure_message, e.terminal_at FROM experiments e WHERE e.run_id = ? ORDER BY e.ordinal, e.experiment_id`).all(runId)
    const columns = ['ordinal','kind','experiment_id','parent_commit','candidate_commit','state','metric','decision','exit_code','signal','timed_out','failure_code','failure_message','terminal_at']
    const body = [columns.join('\t'), ...rows.map((row) => columns.map((column) => tsvCell(row[column])).join('\t'))].join('\n') + '\n'
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(descriptor, body, { encoding: 'utf8' }); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(temporary, destination); chmodSync(destination, 0o600)
      const directory = openSync(dirname(destination), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch (error) { try { unlinkSync(temporary) } catch { /* best effort for derived output */ }; throw error }
  }

  private configure(busyTimeoutMs: number): void { this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL;`) }
  private migrate(deadline: number): void {
    while (true) {
      this.database.exec(`PRAGMA busy_timeout = ${Math.max(1, deadline - Date.now())}`)
      const done = this.transaction(() => {
        const metadata = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get()
        if (!metadata) {
          MIGRATIONS[1]!(this.database)
          this.database.prepare('UPDATE schema_metadata SET version = 1 WHERE singleton = 1').run()
          return false
        }
        const rows = this.database.prepare('SELECT singleton, version FROM schema_metadata').all()
        if (rows.length !== 1 || rows[0]?.['singleton'] !== 1) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema metadata must contain exactly singleton row 1')
        const version = Number(rows[0]['version'])
        if (!Number.isSafeInteger(version) || version < 0) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema version is invalid')
        if (version > TRACKER_SCHEMA_VERSION) throw new TrackerBlockedError('tracker-schema-newer', `tracker schema ${version} is newer than supported ${TRACKER_SCHEMA_VERSION}`)
        if (version === TRACKER_SCHEMA_VERSION) return true
        const next = version + 1; MIGRATIONS[next]!(this.database); this.database.prepare('UPDATE schema_metadata SET version = ? WHERE singleton = 1').run(next); return false
      })
      if (done) return
    }
  }
  private validateSchema(): void {
    const integrity = String(this.database.prepare('PRAGMA integrity_check').get()?.['integrity_check']); if (integrity !== 'ok') throw new TrackerBlockedError('tracker-schema-invalid', `tracker integrity check failed: ${integrity}`)
    const required: Record<string, readonly string[]> = { runs: ['run_id','state','terminal_quiescent'], experiments: ['experiment_id','run_id','state','metric'], attempts: ['attempt_id','run_id','experiment_id','process_tree_quiescent'], artifacts: ['artifact_id','run_id','experiment_id','attempt_id'], transitions: ['transition_id','run_id','experiment_id','sequence'], transition_artifacts: ['transition_id','artifact_id'], active_locks: ['run_id','repository_id','run_tag'] }
    for (const [table, columns] of Object.entries(required)) { const actual = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row['name']))); if (columns.some((column) => !actual.has(column))) throw new TrackerBlockedError('tracker-schema-invalid', `tracker table ${table} is missing required columns`) }
    for (const trigger of ['runs_immutable_identity','experiments_immutable_lineage','attempts_immutable_intent']) if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)) throw new TrackerBlockedError('tracker-schema-invalid', `tracker is missing invariant trigger ${trigger}`)
    for (const index of ['active_locks_live','experiments_recovery','attempts_recovery']) if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)) throw new TrackerBlockedError('tracker-schema-invalid', `tracker is missing recovery index ${index}`)
    if (!this.foreignKeysEnabled()) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker foreign keys are disabled')
  }
  private secureSidecars(): void { for (const suffix of ['', '-wal', '-shm']) { try { this.layout.secureFile(`${this.path}${suffix}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } } }
  private transaction<T>(operation: () => T): T { this.database.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.database.exec('COMMIT'); return result } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* transaction may already be aborted */ }; throw error } }
  private requireRun(runId: string): Record<string, SQLOutputValue> { const row = this.getRun(runId); if (!row) throw new TrackerTransitionError(`unknown run ${runId}`); return row }
  private requireExperiment(experimentId: string): Record<string, SQLOutputValue> { const row = this.database.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId); if (!row) throw new TrackerTransitionError(`unknown experiment ${experimentId}`); return row }
  private mergeAttemptObservation(attempt: Record<string, SQLOutputValue>, facts: AttemptOutcome, updatedAt: string): void {
    const mapping: readonly [keyof AttemptOutcome, string, (value: unknown) => unknown][] = [
      ['providerAttemptId','provider_attempt_id',identity], ['providerPid','provider_pid',identity], ['providerIdentity','provider_identity',identity], ['spawnedAt','spawned_at',identity],
      ['exitedAt','exited_at',identity], ['exitCode','exit_code',identity], ['signal','signal',identity], ['timedOut','timed_out',booleanInteger],
      ['processTreeQuiescent','process_tree_quiescent',booleanInteger], ['failureCode','failure_code',identity], ['failureMessage','failure_message',identity],
    ]
    const assignments: string[] = []; const values: unknown[] = []
    for (const [property, column, convert] of mapping) {
      if (!hasOwn(facts, property)) continue
      const next = convert(facts[property]); const previous = attempt[column]
      if (previous !== null && previous !== next && !(column === 'process_tree_quiescent' && previous === 0 && next === 1)) throw new TrackerTransitionError(`attempt observation conflicts with durable ${column}`)
      assignments.push(`${column} = ?`); values.push(next)
    }
    if (assignments.length === 0) return
    assignments.push('updated_at = ?'); values.push(updatedAt, attempt['attempt_id'])
    this.database.prepare(`UPDATE attempts SET ${assignments.join(', ')} WHERE attempt_id = ?`).run(...values as SQLOutputValue[])
  }
  private isRunQuiescent(runId: string): boolean { return !this.database.prepare('SELECT 1 FROM attempts WHERE run_id = ? AND process_tree_quiescent IS NOT 1 LIMIT 1').get(runId) }
  private validateAndInsertArtifacts(runId: string, experimentId: string | null, artifacts: readonly ArtifactRecord[]): void {
    const statement = this.database.prepare(`INSERT INTO artifacts (artifact_id, run_id, experiment_id, attempt_id, kind, location, size_bytes, sha256, owner, retention, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const artifact of artifacts) {
      if (artifact.runId !== runId) throw new TrackerTransitionError('artifact run must match transition run')
      if (experimentId !== null && artifact.experimentId !== experimentId) throw new TrackerTransitionError('artifact experiment must match experiment transition')
      if (artifact.attemptId !== undefined) { if (artifact.experimentId === undefined) throw new TrackerTransitionError('attempt-owned artifact requires an experiment owner'); const attempt = this.database.prepare('SELECT run_id, experiment_id FROM attempts WHERE attempt_id = ?').get(artifact.attemptId); if (!attempt || attempt['run_id'] !== runId || attempt['experiment_id'] !== artifact.experimentId) throw new TrackerTransitionError('artifact attempt ownership is incoherent') }
      if (artifact.experimentId !== undefined) { const owner = this.database.prepare('SELECT run_id FROM experiments WHERE experiment_id = ?').get(artifact.experimentId); if (!owner || owner['run_id'] !== runId) throw new TrackerTransitionError('artifact experiment ownership is incoherent') }
      statement.run(artifact.artifactId, runId, artifact.experimentId ?? null, artifact.attemptId ?? null, artifact.kind, artifact.location, artifact.sizeBytes, artifact.sha256, artifact.owner, artifact.retention, artifact.metadata === undefined ? null : canonicalJson(artifact.metadata), artifact.createdAt ?? new Date().toISOString())
    }
  }
  private insertTransition(runId: string, experimentId: string | null, scope: 'run' | 'experiment', from: string | null, to: string, facts: TransitionFacts, at: string): number {
    const sequence = Number(this.database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM transitions WHERE run_id = ?').get(runId)!['next']); const transitionId = `${runId}:${sequence}`
    this.database.prepare(`INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(transitionId, runId, experimentId, sequence, scope, from, to, facts.intent === undefined ? null : canonicalJson(facts.intent), facts.outcome === undefined ? null : canonicalJson(facts.outcome), at)
    const link = this.database.prepare('INSERT INTO transition_artifacts (transition_id, artifact_id) VALUES (?, ?)'); for (const artifact of facts.artifacts ?? []) link.run(transitionId, artifact.artifactId)
    return sequence
  }
}

const MIGRATIONS: Record<number, (database: DatabaseSync) => void> = {
  1(database) { database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
    INSERT OR IGNORE INTO schema_metadata VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository TEXT NOT NULL, git_common_dir TEXT NOT NULL, caller_cwd TEXT NOT NULL, start_commit TEXT NOT NULL CHECK(length(start_commit)=40), run_tag TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, agent_id TEXT, session_id TEXT, policy_json TEXT NOT NULL, policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64), provenance_json TEXT NOT NULL, provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256)=64), state TEXT NOT NULL CHECK(state IN ('initializing','baseline-running','ready','candidate-prepared','candidate-running','deciding','completed','baseline-blocked','blocked','round-failed','cancelled')), best_metric REAL, best_commit TEXT, best_experiment_id TEXT, terminal_reason TEXT, blocked_code TEXT, terminal_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository_id, run_id), UNIQUE(repository_id, branch), UNIQUE(repository_id, worktree)) STRICT;
    CREATE TABLE experiments (experiment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), kind TEXT NOT NULL CHECK(kind IN ('baseline','candidate')), parent_commit TEXT NOT NULL CHECK(length(parent_commit)=40), candidate_commit TEXT, state TEXT NOT NULL CHECK(state IN ('baseline-pending','running','accepted','rejected','crashed','timed-out','policy-violation','cancelled')), command TEXT NOT NULL, args_json TEXT NOT NULL, cwd TEXT, exit_code INTEGER, signal TEXT, timed_out INTEGER CHECK(timed_out IN (0,1)), metric REAL, decision TEXT, failure_code TEXT, failure_message TEXT, terminal_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, ordinal), UNIQUE(run_id, experiment_id)) STRICT;
    CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT, experiment_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 1), provider_attempt_id TEXT, spawn_intent_json TEXT NOT NULL, provider_pid INTEGER CHECK(provider_pid > 0), provider_identity TEXT, spawned_at TEXT, exited_at TEXT, exit_code INTEGER, signal TEXT, timed_out INTEGER CHECK(timed_out IN (0,1)), process_tree_quiescent INTEGER CHECK(process_tree_quiescent IN (0,1)), failure_code TEXT, failure_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(experiment_id, ordinal), UNIQUE(run_id, attempt_id), FOREIGN KEY(run_id, experiment_id) REFERENCES experiments(run_id, experiment_id) ON DELETE RESTRICT) STRICT;
    CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT, experiment_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, location TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), sha256 TEXT NOT NULL CHECK(length(sha256)=64), owner TEXT NOT NULL, retention TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, location), FOREIGN KEY(run_id, experiment_id) REFERENCES experiments(run_id, experiment_id) ON DELETE RESTRICT, FOREIGN KEY(run_id, attempt_id) REFERENCES attempts(run_id, attempt_id) ON DELETE RESTRICT) STRICT;
    CREATE TABLE transitions (transition_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT, experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE RESTRICT, sequence INTEGER NOT NULL CHECK(sequence >= 1), scope TEXT NOT NULL CHECK(scope IN ('run','experiment')), from_state TEXT, to_state TEXT NOT NULL, intent_json TEXT, outcome_json TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, sequence)) STRICT;
    CREATE TABLE transition_artifacts (transition_id TEXT NOT NULL REFERENCES transitions(transition_id) ON DELETE RESTRICT, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT, PRIMARY KEY(transition_id, artifact_id)) STRICT;
    CREATE TABLE active_locks (run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT, repository_id TEXT NOT NULL, run_tag TEXT NOT NULL, acquired_at TEXT NOT NULL, released_at TEXT) STRICT;
    CREATE INDEX runs_recovery ON runs(repository_id, state, run_tag); CREATE INDEX experiments_recovery ON experiments(run_id, state, ordinal); CREATE INDEX attempts_recovery ON attempts(experiment_id, ordinal, process_tree_quiescent); CREATE INDEX artifacts_owner ON artifacts(run_id, experiment_id, attempt_id); CREATE INDEX transitions_scope ON transitions(run_id, experiment_id, sequence); CREATE UNIQUE INDEX active_locks_live ON active_locks(repository_id, run_tag) WHERE released_at IS NULL;
  `) },
  2(database) { database.exec(`ALTER TABLE runs ADD COLUMN terminal_quiescent INTEGER CHECK(terminal_quiescent IN (0,1)); CREATE TRIGGER runs_immutable_identity BEFORE UPDATE OF repository_id, repository, git_common_dir, caller_cwd, start_commit, run_tag, branch, worktree, policy_json, policy_sha256, provenance_json, provenance_sha256 ON runs BEGIN SELECT RAISE(ABORT, 'immutable run identity/policy/provenance'); END; CREATE TRIGGER experiments_immutable_lineage BEFORE UPDATE OF run_id, ordinal, kind, parent_commit, candidate_commit, command, args_json, cwd ON experiments BEGIN SELECT RAISE(ABORT, 'immutable experiment lineage/evaluator'); END; CREATE TRIGGER attempts_immutable_intent BEFORE UPDATE OF run_id, experiment_id, ordinal, spawn_intent_json ON attempts BEGIN SELECT RAISE(ABORT, 'immutable attempt identity/intent'); END;`) },
  3(_database) { /* Version 3 tightens repository-level transactional invariants without destructive table rebuilds. */ },
  4(database) { database.exec(`DROP TRIGGER experiments_immutable_lineage; CREATE TRIGGER experiments_immutable_lineage BEFORE UPDATE OF run_id, ordinal, kind, parent_commit, candidate_commit, command, args_json, cwd ON experiments WHEN OLD.run_id != NEW.run_id OR OLD.ordinal != NEW.ordinal OR OLD.kind != NEW.kind OR OLD.parent_commit != NEW.parent_commit OR OLD.command != NEW.command OR OLD.args_json != NEW.args_json OR OLD.cwd IS NOT NEW.cwd OR OLD.candidate_commit IS NOT NULL OR NEW.candidate_commit IS NULL OR length(NEW.candidate_commit) != 40 BEGIN SELECT RAISE(ABORT, 'immutable experiment lineage/evaluator'); END;`) },
}

function validateTransition(scope: 'run', from: RunDurableState, to: RunDurableState): void
function validateTransition(scope: 'experiment', from: ExperimentDurableState, to: ExperimentDurableState): void
function validateTransition(scope: 'run' | 'experiment', from: RunDurableState | ExperimentDurableState, to: RunDurableState | ExperimentDurableState): void { const allowed = scope === 'run' ? RUN_TRANSITIONS[from as RunDurableState] : EXPERIMENT_TRANSITIONS[from as ExperimentDurableState]; if (!allowed?.includes(to as never)) throw new TrackerTransitionError(`invalid ${scope} transition ${from} -> ${to}`) }
function validateExperimentFacts(state: ExperimentDurableState, facts: ExperimentTransitionFacts): void {
  if (facts.metric !== undefined && !Number.isFinite(facts.metric)) throw new TrackerTransitionError('metric must be finite')
  const terminalFields = facts.metric !== undefined || facts.decision !== undefined || facts.exitCode !== undefined || facts.signal !== undefined || facts.timedOut !== undefined || facts.failureCode !== undefined || facts.failureMessage !== undefined
  if (!EXPERIMENT_TERMINAL[state]) { if (terminalFields) throw new TrackerTransitionError('nonterminal experiment transition cannot carry terminal outcome facts'); return }
  if (state === 'accepted' || state === 'rejected') { const requiredDecision = state === 'accepted' ? 'accept' : 'reject'; if (facts.metric === undefined || facts.decision !== requiredDecision) throw new TrackerTransitionError(`${state} requires a finite metric and decision '${requiredDecision}'`); if (hasOwn(facts, 'exitCode') || hasOwn(facts, 'signal') || hasOwn(facts, 'timedOut') || hasOwn(facts, 'failureCode') || hasOwn(facts, 'failureMessage')) throw new TrackerTransitionError(`${state} cannot carry failure facts`); return }
  if (facts.metric !== undefined || facts.decision !== undefined) throw new TrackerTransitionError(`${state} cannot carry decision metric facts`)
  if (!facts.failureCode || !facts.failureMessage) throw new TrackerTransitionError(`${state} requires failure code and message`)
  if (state === 'timed-out' && facts.timedOut !== true) throw new TrackerTransitionError('timed-out requires timedOut=true')
  if (state !== 'timed-out' && facts.timedOut === true) throw new TrackerTransitionError(`${state} cannot claim timeout`)
}
function hasOwn(value: object, property: PropertyKey): boolean { return Object.prototype.hasOwnProperty.call(value, property) }
function isSqliteBusyOrLocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const sqliteError = error as { code?: unknown; errcode?: unknown }
  if (sqliteError.code === 'SQLITE_BUSY' || sqliteError.code === 'SQLITE_LOCKED') return true
  const numericCode = typeof sqliteError.errcode === 'number' ? sqliteError.errcode : typeof sqliteError.code === 'number' ? sqliteError.code : undefined
  return numericCode !== undefined && ((numericCode & 0xff) === 5 || (numericCode & 0xff) === 6)
}
function sleep(milliseconds: number): void { Atomics.wait(TRACKER_RETRY_WAIT, 0, 0, milliseconds) }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)])); if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('tracker JSON snapshots require finite numbers'); if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('tracker snapshots must be JSON values'); return value }
function redactEnvironment(value: unknown): unknown { if (Array.isArray(value)) return value.map(redactEnvironment); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key.toLowerCase() === 'environment' && item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).map(([name, secret]) => [name, { sha256: createHash('sha256').update(String(secret)).digest('hex') }])) : redactEnvironment(item)])) }
function identity(value: unknown): unknown { return value }
function booleanInteger(value: unknown): number { return Number(value) }
function tsvCell(value: SQLOutputValue | undefined): string { if (value === null || value === undefined) return ''; return String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\r', '\\r').replaceAll('\n', '\\n') }
