import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { ExperimentDurableState, RunDurableState } from './types.js'

export const TRACKER_SCHEMA_VERSION = 2
export const TRACKER_BUSY_TIMEOUT_MS = 5_000

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
  'baseline-pending': ['running', 'cancelled'],
  running: ['accepted', 'rejected', 'crashed', 'timed-out', 'policy-violation', 'cancelled'],
  accepted: [], rejected: [], crashed: [], 'timed-out': [], 'policy-violation': [], cancelled: [],
}

export class TrackerBlockedError extends Error {
  readonly status = 'blocked' as const
  constructor(readonly code: 'tracker-schema-newer' | 'tracker-schema-invalid', message: string) { super(message); this.name = 'TrackerBlockedError' }
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
export interface AttemptRecord {
  attemptId: string; runId: string; experimentId: string; ordinal: number; providerAttemptId?: string; createdAt?: string
}
export interface ArtifactRecord {
  artifactId: string; runId: string; experimentId?: string; attemptId?: string; kind: string; location: string
  sizeBytes: number; sha256: string; owner: string; retention: string; metadata?: unknown; createdAt?: string
}
export interface TransitionFacts {
  intent?: unknown; outcome?: unknown; terminalReason?: string; blockedCode?: string; quiescent?: boolean
  best?: { metric: number; commit: string; experimentId: string }; artifacts?: readonly ArtifactRecord[]
}
export interface AttemptOutcome {
  providerAttemptId?: string; providerPid?: number; providerIdentity?: string; spawnedAt?: string; exitedAt?: string
  exitCode?: number | null; signal?: string | null; timedOut?: boolean; processTreeQuiescent?: boolean; failureCode?: string; failureMessage?: string
}

export interface RecoveryState {
  run: Record<string, SQLOutputValue>; unresolvedExperiment?: Record<string, SQLOutputValue>
  unresolvedAttempt?: Record<string, SQLOutputValue>; activeLock?: Record<string, SQLOutputValue>
  safeToReleaseTerminalLock: boolean; processDisposition: 'none' | 'quiescent' | 'uncertain'
}

export class DurableTracker {
  readonly database: DatabaseSync
  private closed = false
  private constructor(readonly path: string, database: DatabaseSync) { this.database = database }

  static open(path: string): DurableTracker {
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, timeout: TRACKER_BUSY_TIMEOUT_MS })
    const tracker = new DurableTracker(path, database)
    try { tracker.configure(); tracker.migrate(); return tracker } catch (error) { database.close(); throw error }
  }
  close(): void { if (!this.closed) { this.database.close(); this.closed = true } }
  schemaVersion(): number { return Number(this.database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get()!['version']) }
  foreignKeysEnabled(): boolean { return Number(this.database.prepare('PRAGMA foreign_keys').get()!['foreign_keys']) === 1 }
  journalMode(): string { return String(this.database.prepare('PRAGMA journal_mode').get()!['journal_mode']) }

  createRun(record: InitialRunRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      this.database.prepare(`INSERT INTO runs (
        run_id, repository_id, repository, git_common_dir, caller_cwd, start_commit, run_tag, branch, worktree,
        agent_id, session_id, policy_json, policy_sha256, provenance_json, provenance_sha256, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`).run(
        record.runId, record.repositoryId, record.repository, record.gitCommonDir, record.callerCwd, record.startCommit,
        record.runTag, record.branch, record.worktree, record.agentId ?? null, record.sessionId ?? null,
        canonicalJson(record.policy), record.policySha256, canonicalJson(record.provenance), record.provenanceSha256, at, at,
      )
      this.insertTransition(record.runId, null, 'run', null, 'initializing', { intent: { kind: 'create-run' } }, at)
    })
  }

  acquireActiveLock(runId: string, repositoryId: string, runTag: string, acquiredAt = new Date().toISOString()): void {
    this.transaction(() => {
      const run = this.requireRun(runId)
      if (run['repository_id'] !== repositoryId || run['run_tag'] !== runTag) throw new TrackerTransitionError('active lock identity must match immutable run identity')
      this.database.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, runTag, runId, acquiredAt)
    })
  }
  releaseActiveLock(runId: string, releasedAt = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const run = this.requireRun(runId)
      if (!RUN_TERMINAL[String(run['state']) as RunDurableState]) throw new TrackerTransitionError('active lock may be released only after terminal run persistence')
      const result = this.database.prepare('UPDATE active_locks SET released_at = ? WHERE run_id = ? AND released_at IS NULL').run(releasedAt, runId)
      return Number(result.changes) === 1
    })
  }

  createExperiment(record: ExperimentRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      const unresolved = this.database.prepare(`SELECT experiment_id FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running')`).get(record.runId)
      if (unresolved) throw new TrackerTransitionError('a run may not create a new experiment while another is unresolved')
      this.database.prepare(`INSERT INTO experiments (
        experiment_id, run_id, ordinal, kind, parent_commit, candidate_commit, state, command, args_json, cwd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'baseline-pending', ?, ?, ?, ?, ?)`).run(
        record.experimentId, record.runId, record.ordinal, record.kind, record.parentCommit, record.candidateCommit ?? null,
        record.command, canonicalJson(record.args), record.cwd ?? null, at, at,
      )
      this.insertTransition(record.runId, record.experimentId, 'experiment', null, 'baseline-pending', { intent: { kind: 'create-experiment' } }, at)
    })
  }

  createAttemptIntent(record: AttemptRecord, intent: unknown): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      const experiment = this.requireExperiment(record.experimentId)
      if (experiment['state'] !== 'running') throw new TrackerTransitionError('attempt spawn intent requires a running experiment')
      if (experiment['run_id'] !== record.runId) throw new TrackerTransitionError('attempt ownership must match experiment run')
      this.database.prepare(`INSERT INTO attempts (attempt_id, run_id, experiment_id, ordinal, provider_attempt_id, spawn_intent_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.attemptId, record.runId, record.experimentId, record.ordinal, record.providerAttemptId ?? null, canonicalJson(intent), at, at)
    })
  }
  recordAttemptObserved(attemptId: string, facts: AttemptOutcome, updatedAt = new Date().toISOString()): void {
    this.transaction(() => {
      const attempt = this.database.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
      if (!attempt) throw new TrackerTransitionError(`unknown attempt ${attemptId}`)
      this.database.prepare(`UPDATE attempts SET provider_attempt_id = COALESCE(?, provider_attempt_id), provider_pid = ?, provider_identity = ?,
        spawned_at = ?, exited_at = ?, exit_code = ?, signal = ?, timed_out = ?, process_tree_quiescent = ?, failure_code = ?, failure_message = ?, updated_at = ? WHERE attempt_id = ?`).run(
        facts.providerAttemptId ?? null, facts.providerPid ?? null, facts.providerIdentity ?? null, facts.spawnedAt ?? null,
        facts.exitedAt ?? null, facts.exitCode ?? null, facts.signal ?? null, facts.timedOut === undefined ? null : Number(facts.timedOut),
        facts.processTreeQuiescent === undefined ? null : Number(facts.processTreeQuiescent), facts.failureCode ?? null, facts.failureMessage ?? null, updatedAt, attemptId,
      )
    })
  }

  transitionRun(runId: string, to: RunDurableState, facts: TransitionFacts = {}, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const run = this.requireRun(runId); const from = String(run['state']) as RunDurableState
      validateTransition('run', from, to)
      if (RUN_TERMINAL[to] && facts.quiescent !== true) throw new TrackerTransitionError('terminal run transition requires quiescent=true')
      this.insertArtifacts(facts.artifacts ?? [])
      this.database.prepare(`UPDATE runs SET state = ?, updated_at = ?, terminal_reason = ?, blocked_code = ?, terminal_at = ?, terminal_quiescent = ?,
        best_metric = COALESCE(?, best_metric), best_commit = COALESCE(?, best_commit), best_experiment_id = COALESCE(?, best_experiment_id) WHERE run_id = ?`).run(
        to, at, facts.terminalReason ?? null, facts.blockedCode ?? null, RUN_TERMINAL[to] ? at : null,
        RUN_TERMINAL[to] ? 1 : null, facts.best?.metric ?? null, facts.best?.commit ?? null, facts.best?.experimentId ?? null, runId,
      )
      return this.insertTransition(runId, null, 'run', from, to, facts, at)
    })
  }

  transitionExperiment(experimentId: string, to: ExperimentDurableState, facts: TransitionFacts & {
    metric?: number; decision?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; failureCode?: string; failureMessage?: string
  } = {}, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const experiment = this.requireExperiment(experimentId); const from = String(experiment['state']) as ExperimentDurableState
      validateTransition('experiment', from, to)
      if (facts.metric !== undefined && !Number.isFinite(facts.metric)) throw new TrackerTransitionError('metric must be finite')
      this.insertArtifacts(facts.artifacts ?? [])
      this.database.prepare(`UPDATE experiments SET state = ?, metric = ?, decision = ?, exit_code = ?, signal = ?, timed_out = ?, failure_code = ?, failure_message = ?, terminal_at = ?, updated_at = ? WHERE experiment_id = ?`).run(
        to, facts.metric ?? null, facts.decision ?? null, facts.exitCode ?? null, facts.signal ?? null, facts.timedOut === undefined ? null : Number(facts.timedOut),
        facts.failureCode ?? null, facts.failureMessage ?? null, EXPERIMENT_TERMINAL[to] ? at : null, at, experimentId,
      )
      return this.insertTransition(String(experiment['run_id']), experimentId, 'experiment', from, to, facts, at)
    })
  }

  commitTerminalExperiment(experimentId: string, to: Exclude<ExperimentDurableState, 'baseline-pending' | 'running'>, facts: TransitionFacts & {
    metric?: number; decision?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; failureCode?: string; failureMessage?: string
  }, compatibilityTsvPath?: string, at = new Date().toISOString()): number {
    const sequence = this.transitionExperiment(experimentId, to, facts, at)
    if (compatibilityTsvPath !== undefined) this.exportTsv(compatibilityTsvPath)
    return sequence
  }

  getRun(runId: string): Record<string, SQLOutputValue> | undefined { return this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) }
  listTransitions(runId: string): Record<string, SQLOutputValue>[] { return this.database.prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence').all(runId) }
  recoveryState(runId: string): RecoveryState {
    const run = this.requireRun(runId)
    const unresolvedExperiment = this.database.prepare(`SELECT * FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running') ORDER BY ordinal DESC LIMIT 1`).get(runId)
    const unresolvedAttempt = unresolvedExperiment ? this.database.prepare('SELECT * FROM attempts WHERE experiment_id = ? ORDER BY ordinal DESC LIMIT 1').get(unresolvedExperiment['experiment_id']!) : undefined
    const activeLock = this.database.prepare('SELECT * FROM active_locks WHERE run_id = ? AND released_at IS NULL').get(runId)
    const quiescent = unresolvedAttempt?.['process_tree_quiescent']
    return { run, ...(unresolvedExperiment ? { unresolvedExperiment } : {}), ...(unresolvedAttempt ? { unresolvedAttempt } : {}), ...(activeLock ? { activeLock } : {}),
      safeToReleaseTerminalLock: Boolean(activeLock && RUN_TERMINAL[String(run['state']) as RunDurableState] && run['terminal_quiescent'] === 1),
      processDisposition: !unresolvedAttempt ? 'none' : quiescent === 1 ? 'quiescent' : 'uncertain' }
  }

  exportTsv(path: string): void {
    const rows = this.database.prepare(`SELECT e.ordinal, e.kind, e.experiment_id, e.parent_commit, e.candidate_commit, e.state, e.metric, e.decision,
      e.exit_code, e.signal, e.timed_out, e.failure_code, e.failure_message, e.terminal_at
      FROM experiments e ORDER BY e.run_id, e.ordinal, e.experiment_id`).all()
    const columns = ['ordinal','kind','experiment_id','parent_commit','candidate_commit','state','metric','decision','exit_code','signal','timed_out','failure_code','failure_message','terminal_at']
    const body = [columns.join('\t'), ...rows.map((row) => columns.map((column) => tsvCell(row[column])).join('\t'))].join('\n') + '\n'
    const temporary = `${path}.tmp`
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
    const file = openSync(temporary, 'r'); try { fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  }

  private configure(): void { this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${TRACKER_BUSY_TIMEOUT_MS};`) }
  private migrate(): void {
    const hasMetadata = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get()
    let version = hasMetadata ? Number(this.database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get()?.['version']) : 0
    if (!Number.isSafeInteger(version) || version < 0) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema version is invalid')
    if (version > TRACKER_SCHEMA_VERSION) throw new TrackerBlockedError('tracker-schema-newer', `tracker schema ${version} is newer than supported ${TRACKER_SCHEMA_VERSION}`)
    while (version < TRACKER_SCHEMA_VERSION) {
      const next = version + 1
      this.transaction(() => { MIGRATIONS[next]! (this.database); this.database.prepare('UPDATE schema_metadata SET version = ? WHERE singleton = 1').run(next) })
      version = next
    }
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.database.exec('COMMIT'); return result } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }
  private requireRun(runId: string): Record<string, SQLOutputValue> { const row = this.getRun(runId); if (!row) throw new TrackerTransitionError(`unknown run ${runId}`); return row }
  private requireExperiment(experimentId: string): Record<string, SQLOutputValue> { const row = this.database.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId); if (!row) throw new TrackerTransitionError(`unknown experiment ${experimentId}`); return row }
  private insertArtifacts(artifacts: readonly ArtifactRecord[]): void {
    const statement = this.database.prepare(`INSERT INTO artifacts (artifact_id, run_id, experiment_id, attempt_id, kind, location, size_bytes, sha256, owner, retention, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const artifact of artifacts) statement.run(artifact.artifactId, artifact.runId, artifact.experimentId ?? null, artifact.attemptId ?? null, artifact.kind,
      artifact.location, artifact.sizeBytes, artifact.sha256, artifact.owner, artifact.retention, artifact.metadata === undefined ? null : canonicalJson(artifact.metadata), artifact.createdAt ?? new Date().toISOString())
  }
  private insertTransition(runId: string, experimentId: string | null, scope: 'run' | 'experiment', from: string | null, to: string, facts: TransitionFacts, at: string): number {
    const sequence = Number(this.database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM transitions WHERE run_id = ?').get(runId)!['next'])
    const transitionId = `${runId}:${sequence}`
    this.database.prepare(`INSERT INTO transitions (transition_id, run_id, experiment_id, sequence, scope, from_state, to_state, intent_json, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(transitionId, runId, experimentId, sequence, scope, from, to,
        facts.intent === undefined ? null : canonicalJson(facts.intent), facts.outcome === undefined ? null : canonicalJson(facts.outcome), at)
    const link = this.database.prepare('INSERT INTO transition_artifacts (transition_id, artifact_id) VALUES (?, ?)')
    for (const artifact of facts.artifacts ?? []) link.run(transitionId, artifact.artifactId)
    return sequence
  }
}

const MIGRATIONS: Record<number, (database: DatabaseSync) => void> = {
  1(database) { database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
    INSERT OR IGNORE INTO schema_metadata VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository TEXT NOT NULL, git_common_dir TEXT NOT NULL, caller_cwd TEXT NOT NULL,
      start_commit TEXT NOT NULL CHECK(length(start_commit)=40), run_tag TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
      agent_id TEXT, session_id TEXT, policy_json TEXT NOT NULL, policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
      provenance_json TEXT NOT NULL, provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256)=64),
      state TEXT NOT NULL CHECK(state IN ('initializing','baseline-running','ready','candidate-prepared','candidate-running','deciding','completed','baseline-blocked','blocked','round-failed','cancelled')),
      best_metric REAL, best_commit TEXT, best_experiment_id TEXT, terminal_reason TEXT, blocked_code TEXT, terminal_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(repository_id, run_id), UNIQUE(repository_id, branch), UNIQUE(repository_id, worktree)
    ) STRICT;
    CREATE TABLE experiments (
      experiment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      kind TEXT NOT NULL CHECK(kind IN ('baseline','candidate')), parent_commit TEXT NOT NULL CHECK(length(parent_commit)=40), candidate_commit TEXT,
      state TEXT NOT NULL CHECK(state IN ('baseline-pending','running','accepted','rejected','crashed','timed-out','policy-violation','cancelled')),
      command TEXT NOT NULL, args_json TEXT NOT NULL, cwd TEXT, exit_code INTEGER, signal TEXT, timed_out INTEGER CHECK(timed_out IN (0,1)),
      metric REAL, decision TEXT, failure_code TEXT, failure_message TEXT, terminal_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(run_id, ordinal), UNIQUE(run_id, experiment_id)
    ) STRICT;
    CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      experiment_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      provider_attempt_id TEXT, spawn_intent_json TEXT NOT NULL, provider_pid INTEGER CHECK(provider_pid > 0), provider_identity TEXT,
      spawned_at TEXT, exited_at TEXT, exit_code INTEGER, signal TEXT, timed_out INTEGER CHECK(timed_out IN (0,1)),
      process_tree_quiescent INTEGER CHECK(process_tree_quiescent IN (0,1)), failure_code TEXT, failure_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(experiment_id, ordinal), UNIQUE(run_id, attempt_id), FOREIGN KEY(run_id, experiment_id) REFERENCES experiments(run_id, experiment_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      experiment_id TEXT, attempt_id TEXT,
      kind TEXT NOT NULL, location TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      owner TEXT NOT NULL, retention TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, location),
      FOREIGN KEY(run_id, experiment_id) REFERENCES experiments(run_id, experiment_id) ON DELETE RESTRICT,
      FOREIGN KEY(run_id, attempt_id) REFERENCES attempts(run_id, attempt_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE transitions (
      transition_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
      experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE RESTRICT, sequence INTEGER NOT NULL CHECK(sequence >= 1),
      scope TEXT NOT NULL CHECK(scope IN ('run','experiment')), from_state TEXT, to_state TEXT NOT NULL, intent_json TEXT, outcome_json TEXT, created_at TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    ) STRICT;
    CREATE TABLE transition_artifacts (transition_id TEXT NOT NULL REFERENCES transitions(transition_id) ON DELETE RESTRICT, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT, PRIMARY KEY(transition_id, artifact_id)) STRICT;
    CREATE TABLE active_locks (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT, repository_id TEXT NOT NULL, run_tag TEXT NOT NULL,
      acquired_at TEXT NOT NULL, released_at TEXT
    ) STRICT;
    CREATE INDEX runs_recovery ON runs(repository_id, state, run_tag);
    CREATE INDEX experiments_recovery ON experiments(run_id, state, ordinal);
    CREATE INDEX attempts_recovery ON attempts(experiment_id, ordinal, process_tree_quiescent);
    CREATE INDEX artifacts_owner ON artifacts(run_id, experiment_id, attempt_id);
    CREATE INDEX transitions_scope ON transitions(run_id, experiment_id, sequence);
    CREATE UNIQUE INDEX active_locks_live ON active_locks(repository_id, run_tag) WHERE released_at IS NULL;
  `) },
  2(database) { database.exec(`
    ALTER TABLE runs ADD COLUMN terminal_quiescent INTEGER CHECK(terminal_quiescent IN (0,1));
    CREATE TRIGGER runs_immutable_identity BEFORE UPDATE OF repository_id, repository, git_common_dir, caller_cwd, start_commit, run_tag, branch, worktree, policy_json, policy_sha256, provenance_json, provenance_sha256 ON runs BEGIN SELECT RAISE(ABORT, 'immutable run identity/policy/provenance'); END;
    CREATE TRIGGER experiments_immutable_lineage BEFORE UPDATE OF run_id, ordinal, kind, parent_commit, candidate_commit, command, args_json, cwd ON experiments BEGIN SELECT RAISE(ABORT, 'immutable experiment lineage/evaluator'); END;
    CREATE TRIGGER attempts_immutable_intent BEFORE UPDATE OF run_id, experiment_id, ordinal, spawn_intent_json ON attempts BEGIN SELECT RAISE(ABORT, 'immutable attempt identity/intent'); END;
  `) },
}

function validateTransition(scope: 'run', from: RunDurableState, to: RunDurableState): void
function validateTransition(scope: 'experiment', from: ExperimentDurableState, to: ExperimentDurableState): void
function validateTransition(scope: 'run' | 'experiment', from: RunDurableState | ExperimentDurableState, to: RunDurableState | ExperimentDurableState): void {
  const allowed = scope === 'run' ? RUN_TRANSITIONS[from as RunDurableState] : EXPERIMENT_TRANSITIONS[from as ExperimentDurableState]
  if (!allowed?.includes(to as never)) throw new TrackerTransitionError(`invalid ${scope} transition ${from} -> ${to}`)
}
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]))
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('tracker JSON snapshots require finite numbers')
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('tracker snapshots must be JSON values')
  return value
}
function tsvCell(value: SQLOutputValue | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\r', '\\r').replaceAll('\n', '\\n')
}
