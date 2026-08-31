import { closeSync, chmodSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { StateLayout } from './state-layout.js'
import { redactConfiguredSecrets } from './evaluator-artifacts.js'
import { EVALUATOR_CONTRACT_GENERATION, normalizeEvaluatorRegistration, normalizeRegistrationManifest, registrationFingerprint, serializeRegistrationJson } from './types.js'
import type { DurableRegistrationIdentity, EvaluatorRegistration, ExperimentDurableState, RegistrationManifest, RunDurableState } from './types.js'

export const TRACKER_SCHEMA_VERSION = 9
export const TRACKER_BUSY_TIMEOUT_MS = 5_000
const TRACKER_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4))

const RUN_TERMINAL: Readonly<Record<RunDurableState, boolean>> = {
  initializing: false, 'baseline-running': false, ready: false, 'candidate-prepared': false, 'candidate-running': false, deciding: false,
  completed: true, 'baseline-blocked': true, blocked: true, 'round-failed': true, cancelled: true,
}
const EXPERIMENT_TERMINAL: Readonly<Record<ExperimentDurableState, boolean>> = {
  'baseline-pending': false, running: false, accepted: true, rejected: true, crashed: true, 'timed-out': true, 'policy-violation': true, cancelled: true,
}
const RESEARCH_FAILURE_CODES: Readonly<Record<string, true>> = { spawn: true, timeout: true, cancelled: true, exit: true, signal: true, 'output-limit': true, 'metric-protocol': true, 'provenance-mismatch': true, 'recovery-rerun-exhausted': true }
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
export interface RegisteredRunRecord extends InitialRunRecord {
  readonly registration: EvaluatorRegistration
  readonly manifest: RegistrationManifest
}

export interface ExperimentRecord {
  experimentId: string; runId: string; ordinal: number; kind: 'baseline' | 'candidate'; parentCommit: string
  candidateCommit?: string; command: string; args: readonly string[]; cwd?: string; createdAt?: string; annotation?: UntrustedResearchAnnotation; redactionSecrets?: readonly string[]
}
export interface UntrustedResearchAnnotation { readonly trust: 'untrusted-child-annotation'; readonly redaction?: 'exact-configured-secrets-only'; readonly hypothesis: string; readonly intendedEdits: readonly string[]; readonly implementationSummary: string }
export interface CandidateDiffStats { readonly files: number; readonly insertions: number; readonly deletions: number; readonly binaryFiles: number }
export interface HostFailureFacts { readonly code: string; readonly spawn?: 'provider-spawn-failed'; readonly exitCode?: number; readonly signal?: string; readonly timedOut?: true; readonly output?: 'stdout-limit-exceeded'; readonly metricProtocol?: 'rejected' }
export interface HostResearchFacts { readonly candidateCommit?: string; readonly changedPaths?: readonly string[]; readonly changedPathsStatus?: 'truncated' | 'unavailable'; readonly diffStats?: CandidateDiffStats; readonly failure?: HostFailureFacts }
export interface ResearchHistoryRecord { readonly ordinal: number; readonly experimentId: string; readonly state: ExperimentDurableState; readonly candidateCommit?: string; readonly metric?: number; readonly decision?: 'accept' | 'reject'; readonly failureCode?: string; readonly annotation: UntrustedResearchAnnotation | 'unavailable'; readonly hostFacts: HostResearchFacts; readonly artifacts: 'available' | 'pruned' | 'unavailable' }
export interface ResearchHistoryPage { readonly entries: readonly ResearchHistoryRecord[]; readonly olderEntriesTruncated: boolean }
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
export type AttemptEvaluationResult =
  | { readonly kind: 'measured'; readonly metric: number }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
export interface AttemptOutcomeCheckpoint {
  readonly facts: AttemptOutcome
  readonly artifacts: readonly ArtifactRecord[]
  readonly result: AttemptEvaluationResult
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
  private constructor(readonly path: string, database: DatabaseSync, layout: StateLayout, private readonly dispose?: () => void) { this.database = database; this.layout = layout }

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

  /** Inspect a transactionally consistent private snapshot. Source main/WAL bytes and sidecar existence remain unchanged; existing SHM coordination bytes may change. */
  static openReadOnly(path: string): DurableTracker {
    const layout = StateLayout.inspect(dirname(path))
    const safePath = layout.inspectContained(path)
    const snapshotRoot = mkdtempSync(join(tmpdir(), 'dsh-autoresearch-tracker-'))
    const snapshotPath = join(snapshotRoot, basename(safePath))
    let database: DatabaseSync | undefined
    try {
      snapshotSqliteDatabase(safePath, snapshotPath)
      const snapshotUrl = pathToFileURL(snapshotPath); snapshotUrl.searchParams.set('mode', 'ro'); snapshotUrl.searchParams.set('immutable', '1')
      database = new DatabaseSync(snapshotUrl.href, { readOnly: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false })
      const tracker = new DurableTracker(safePath, database, layout, () => rmSync(snapshotRoot, { recursive: true, force: true }))
      tracker.database.exec('PRAGMA foreign_keys = ON')
      tracker.validateSchema()
      return tracker
    } catch (error) {
      try { database?.close() } catch { /* preserve original failure */ }
      rmSync(snapshotRoot, { recursive: true, force: true })
      if (error instanceof TrackerBlockedError) throw error
      throw new TrackerBlockedError('tracker-schema-invalid', 'tracker is corrupt, malformed, or has an incompatible schema', error)
    }
  }

  close(): void { if (!this.closed) { try { this.database.close() } finally { this.closed = true; this.dispose?.() } } }
  schemaVersion(): number { return Number(this.database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get()!['version']) }
  foreignKeysEnabled(): boolean { return Number(this.database.prepare('PRAGMA foreign_keys').get()!['foreign_keys']) === 1 }
  journalMode(): string { return String(this.database.prepare('PRAGMA journal_mode').get()!['journal_mode']) }

  createRun(record: InitialRunRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => this.insertRun(record, at))
  }
  createRegisteredRun(record: RegisteredRunRecord): DurableRegistrationIdentity {
    const at = record.createdAt ?? new Date().toISOString()
    const registration = normalizeEvaluatorRegistration(record.registration)
    const manifest = normalizeRegistrationManifest(record.manifest)
    const fingerprint = registrationFingerprint(registration, manifest)
    const identity: DurableRegistrationIdentity = { contractGeneration: EVALUATOR_CONTRACT_GENERATION, evaluatorId: registration.evaluatorId, registration, manifest, registrationFingerprint: fingerprint }
    this.transaction(() => {
      this.insertRun(record, at, EVALUATOR_CONTRACT_GENERATION)
      this.database.prepare(`INSERT INTO run_registrations (run_id, contract_generation, evaluator_id, registration_json, manifest_json, registration_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.runId, identity.contractGeneration, identity.evaluatorId, serializeRegistrationJson(identity.registration), serializeRegistrationJson(identity.manifest), identity.registrationFingerprint, at)
    })
    return identity
  }
  rollbackRegisteredRunActivation(runId: string): void {
    this.transaction(() => {
      const run = this.requireRun(runId)
      if (run['state'] !== 'initializing') throw new TrackerTransitionError('registered run activation rollback requires an initializing run')
      if (this.database.prepare('SELECT 1 FROM experiments WHERE run_id = ? LIMIT 1').get(runId) || this.database.prepare('SELECT 1 FROM attempts WHERE run_id = ? LIMIT 1').get(runId) || this.database.prepare('SELECT 1 FROM artifacts WHERE run_id = ? LIMIT 1').get(runId)) throw new TrackerTransitionError('registered run activation rollback requires no execution state')
      this.database.prepare('DELETE FROM active_locks WHERE run_id = ?').run(runId)
      this.database.prepare('DELETE FROM transition_artifacts WHERE transition_id IN (SELECT transition_id FROM transitions WHERE run_id = ?)').run(runId)
      this.database.prepare('DELETE FROM transitions WHERE run_id = ?').run(runId)
      this.database.exec('DROP TRIGGER run_registrations_presence_monotonic')
      this.database.prepare('DELETE FROM run_registrations WHERE run_id = ?').run(runId)
      this.database.prepare('DELETE FROM runs WHERE run_id = ?').run(runId)
      this.database.exec(`CREATE TRIGGER run_registrations_presence_monotonic BEFORE DELETE ON run_registrations BEGIN SELECT RAISE(ABORT, 'evaluator registration presence is monotonic'); END;`)
    })
  }
  readRegistration(runId: string): DurableRegistrationIdentity | undefined {
    this.requireRun(runId)
    const row = this.database.prepare('SELECT * FROM run_registrations WHERE run_id = ?').get(runId)
    if (!row) return undefined
    try {
      if (row['contract_generation'] !== EVALUATOR_CONTRACT_GENERATION) throw new TrackerTransitionError('unsupported evaluator contract generation')
      const registrationJson = textJson(row['registration_json'], 'registration')
      const manifestJson = textJson(row['manifest_json'], 'registration manifest')
      const registrationValue = parseJson(registrationJson, 'registration')
      const manifestValue = parseJson(manifestJson, 'registration manifest')
      assertRegistrationShape(registrationValue)
      assertManifestShape(manifestValue)
      const registration = normalizeEvaluatorRegistration(registrationValue)
      const manifest = normalizeRegistrationManifest(manifestValue)
      if (registrationJson !== serializeRegistrationJson(registration) || manifestJson !== serializeRegistrationJson(manifest)) throw new TrackerTransitionError('durable evaluator registration JSON is not canonical')
      const evaluatorId = String(row['evaluator_id'])
      const fingerprint = registrationFingerprint(registration, manifest)
      if (registration.evaluatorId !== evaluatorId || row['registration_fingerprint'] !== fingerprint) throw new TrackerTransitionError('durable evaluator registration identity is inconsistent')
      return { contractGeneration: EVALUATOR_CONTRACT_GENERATION, evaluatorId, registration, manifest, registrationFingerprint: fingerprint }
    } catch (error) {
      if (error instanceof TrackerTransitionError) throw error
      throw new TrackerTransitionError(`durable evaluator registration is corrupt: ${(error as Error).message}`)
    }
  }
  acquireActiveLock(runId: string, repositoryId: string, runTag: string, acquiredAt = new Date().toISOString()): void {
    this.transaction(() => {
      const run = this.requireRun(runId)
      if (run['repository_id'] !== repositoryId || run['run_tag'] !== runTag) throw new TrackerTransitionError('active lock identity must match immutable run identity')
      const active = this.database.prepare('SELECT run_id, repository_id, run_tag FROM active_locks WHERE repository_id = ? AND run_tag = ? AND released_at IS NULL').get(repositoryId, runTag)
      if (active) {
        if (active['run_id'] === runId && active['repository_id'] === repositoryId && active['run_tag'] === runTag) return
        throw new TrackerTransitionError('active lock is owned by a different run')
      }
      this.database.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, runTag, runId, acquiredAt)
    })
  }
  releaseActiveLock(runId: string, releasedAt = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const run = this.requireRun(runId)
      if (!RUN_TERMINAL[String(run['state']) as RunDurableState] || run['terminal_quiescent'] !== 1) throw new TrackerTransitionError('active lock release requires terminal persistence and a durable run-level quiescence safe-to-release fact')
      return Number(this.database.prepare('UPDATE active_locks SET released_at = ? WHERE run_id = ? AND released_at IS NULL').run(releasedAt, runId).changes) === 1
    })
  }

  createExperiment(record: ExperimentRecord): void {
    const at = record.createdAt ?? new Date().toISOString()
    this.transaction(() => {
      this.requireRun(record.runId)
      if (record.annotation !== undefined && record.kind !== 'candidate') throw new TrackerTransitionError('research annotation belongs only to candidate experiments')
      if (this.database.prepare(`SELECT 1 FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running')`).get(record.runId)) throw new TrackerTransitionError('a run may not create a new experiment while another is unresolved')
      this.insertExperiment(record, at)
    })
  }
  prepareCandidate(record: ExperimentRecord, facts: TransitionFacts, at = new Date().toISOString()): void {
    this.transaction(() => {
      const run = this.requireRun(record.runId)
      const from = String(run['state']) as RunDurableState
      if (from !== 'ready') throw new TrackerTransitionError('candidate preparation requires a ready run')
      if (record.kind !== 'candidate' || record.annotation === undefined) throw new TrackerTransitionError('candidate preparation requires its validated untrusted annotation')
      if (this.database.prepare(`SELECT 1 FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running')`).get(record.runId)) throw new TrackerTransitionError('a run may not prepare a candidate while another is unresolved')
      this.insertExperiment(record, at)
      this.database.prepare('UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?').run('candidate-prepared', at, record.runId)
      this.insertTransition(record.runId, record.experimentId, 'run', from, 'candidate-prepared', redactExactSecrets(facts, record.redactionSecrets ?? []) as TransitionFacts, at)
    })
  }
  recordCandidateCommit(experimentId: string, candidateCommit: string, hostFacts: Omit<HostResearchFacts, 'candidateCommit'> = {}, redactionSecrets: readonly string[] = [], updatedAt = new Date().toISOString()): void {
    if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) throw new TrackerTransitionError('candidate commit must be a full lowercase SHA')
    this.transaction(() => {
      const experiment = this.requireExperiment(experimentId)
      if (experiment['kind'] !== 'candidate' || experiment['state'] !== 'baseline-pending') throw new TrackerTransitionError('candidate commit outcome requires a pending candidate experiment')
      const serialized = canonicalJson(normalizeHostResearchFacts({ ...hostFacts, candidateCommit }, redactionSecrets))
      if (experiment['candidate_commit'] !== null && experiment['candidate_commit'] !== candidateCommit) throw new TrackerTransitionError('candidate commit conflicts with durable lineage')
      if (experiment['host_facts_json'] !== null && experiment['host_facts_json'] !== serialized) throw new TrackerTransitionError('candidate Host facts conflict with durable research memory')
      if (experiment['candidate_commit'] === candidateCommit && experiment['host_facts_json'] === serialized) return
      this.database.prepare('UPDATE experiments SET candidate_commit = ?, host_facts_json = ?, updated_at = ? WHERE experiment_id = ?').run(candidateCommit, serialized, updatedAt, experimentId)
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
      if (attempt['outcome_json'] !== null) throw new TrackerTransitionError(`attempt ${attemptId} already has a durable outcome`)
      const facts = attemptOutcomeFacts(checkpoint)
      this.mergeAttemptObservation(attempt, facts, updatedAt)
      this.database.prepare('UPDATE attempts SET outcome_json = ?, updated_at = ? WHERE attempt_id = ?').run(canonicalJson(checkpoint.result), updatedAt, attemptId)
      const runId = String(attempt['run_id'])
      const experimentId = String(attempt['experiment_id'])
      this.validateAndInsertArtifacts(runId, experimentId, checkpoint.artifacts)
      const run = this.requireRun(runId)
      const state = String(run['state']) as RunDurableState
      if (RUN_TERMINAL[state]) throw new TrackerTransitionError('attempt outcome requires a nonterminal run')
      const outcome = checkpoint.outcome ?? { kind: 'evaluator-outcome', result: checkpoint.result }
      return this.insertTransition(runId, experimentId, 'run', state, state, { outcome, artifacts: checkpoint.artifacts }, updatedAt)
    })
  }


  transitionRun(runId: string, to: RunDurableState, facts: TransitionFacts = {}, at = new Date().toISOString()): number {
    return this.transaction(() => {
      const run = this.requireRun(runId); const from = String(run['state']) as RunDurableState; validateTransition('run', from, to)
      if (RUN_TERMINAL[to]) {
        const observedQuiescent = this.isRunQuiescent(runId)
        const terminalQuiescent = facts.quiescent ?? observedQuiescent
        const unresolved = this.database.prepare(`SELECT 1 FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running') LIMIT 1`).get(runId)
        if (terminalQuiescent && !observedQuiescent) throw new TrackerTransitionError('terminal run cannot claim quiescence while an attempt remains uncertain')
        if (!terminalQuiescent && (to !== 'blocked' || unresolved)) throw new TrackerTransitionError('terminal run transition requires durable whole-process-tree quiescence for every attempt')
        if (unresolved) throw new TrackerTransitionError('terminal run transition requires every experiment to be terminal')
      }
      this.validateAndInsertArtifacts(runId, null, facts.artifacts ?? [])
      const terminalQuiescent = RUN_TERMINAL[to] ? Number(facts.quiescent ?? this.isRunQuiescent(runId)) : null
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
  appendFailureResearchFacts(experimentId: string, failure: HostFailureFacts, updatedAt = new Date().toISOString()): void {
    this.transaction(() => {
      const experiment = this.requireExperiment(experimentId)
      const existing = experiment['host_facts_json'] === null ? {} : parseJson(textJson(experiment['host_facts_json'], 'host research facts'), 'host research facts') as HostResearchFacts
      if (existing.failure !== undefined && canonicalJson(existing.failure) !== canonicalJson(failure)) throw new TrackerTransitionError('failure Host facts conflict with durable research memory')
      const serialized = canonicalJson(normalizeHostResearchFacts({ ...existing, failure }))
      if (experiment['host_facts_json'] === serialized) return
      this.database.prepare('UPDATE experiments SET host_facts_json = ?, updated_at = ? WHERE experiment_id = ?').run(serialized, updatedAt, experimentId)
    })
  }

  researchHistoryPage(runId: string, limit = 20): ResearchHistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('research history limit must be between 1 and 100')
    this.requireRun(runId)
    const rows = this.database.prepare(`SELECT e.*, CASE WHEN COUNT(a.artifact_id)=0 THEN 'unavailable' WHEN SUM(CASE WHEN a.retention IN ('pruned','pruning') THEN 0 ELSE 1 END)=0 THEN 'pruned' ELSE 'available' END AS artifact_status FROM experiments e LEFT JOIN artifacts a ON a.experiment_id=e.experiment_id WHERE e.run_id=? AND e.kind='candidate' GROUP BY e.experiment_id ORDER BY e.ordinal DESC, e.experiment_id DESC LIMIT ?`).all(runId, limit + 1)
    const olderEntriesTruncated = rows.length > limit
    const entries = rows.slice(0, limit).map<ResearchHistoryRecord>(row => ({ ordinal: Number(row['ordinal']), experimentId: String(row['experiment_id']), state: String(row['state']) as ExperimentDurableState, ...(row['candidate_commit'] === null ? {} : { candidateCommit: String(row['candidate_commit']) }), ...(row['metric'] === null ? {} : { metric: Number(row['metric']) }), ...(row['decision'] === null ? {} : { decision: String(row['decision']) as 'accept' | 'reject' }), ...(row['failure_code'] === null || RESEARCH_FAILURE_CODES[String(row['failure_code'])] !== true ? {} : { failureCode: String(row['failure_code']) }), annotation: row['annotation_json'] === null ? 'unavailable' : normalizeUntrustedResearchAnnotation(parseJson(textJson(row['annotation_json'], 'research annotation'), 'research annotation') as UntrustedResearchAnnotation), hostFacts: row['host_facts_json'] === null ? {} : normalizeHostResearchFacts(parseJson(textJson(row['host_facts_json'], 'host research facts'), 'host research facts') as HostResearchFacts), artifacts: String(row['artifact_status']) as ResearchHistoryRecord['artifacts'] }))
    return { entries, olderEntriesTruncated }
  }
  researchHistory(runId: string, limit = 20): ResearchHistoryRecord[] { return [...this.researchHistoryPage(runId, limit).entries] }

  getRun(runId: string): Record<string, SQLOutputValue> | undefined { return this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) }
  listTransitions(runId: string): Record<string, SQLOutputValue>[] { return this.database.prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence').all(runId) }
  recoveryState(runId: string): RecoveryState {
    const run = this.requireRun(runId); const unresolvedExperiment = this.database.prepare(`SELECT * FROM experiments WHERE run_id = ? AND state IN ('baseline-pending','running') ORDER BY ordinal DESC LIMIT 1`).get(runId)
    const unresolvedAttempt = unresolvedExperiment ? this.database.prepare('SELECT * FROM attempts WHERE experiment_id = ? ORDER BY ordinal DESC LIMIT 1').get(unresolvedExperiment['experiment_id']!) : undefined
    const activeLock = this.database.prepare('SELECT * FROM active_locks WHERE run_id = ? AND released_at IS NULL').get(runId); const quiescent = this.isRunQuiescent(runId)
    const terminal = RUN_TERMINAL[String(run['state']) as RunDurableState]
    const safeToReleaseTerminalLock = Boolean(activeLock && terminal && run['terminal_quiescent'] === 1)
    const processDisposition = terminal ? run['terminal_quiescent'] === 1 ? 'quiescent' : 'uncertain' : !this.database.prepare('SELECT 1 FROM attempts WHERE run_id = ? LIMIT 1').get(runId) ? 'none' : quiescent ? 'quiescent' : 'uncertain'
    return { run, ...(unresolvedExperiment ? { unresolvedExperiment } : {}), ...(unresolvedAttempt ? { unresolvedAttempt } : {}), ...(activeLock ? { activeLock } : {}), safeToReleaseTerminalLock, processDisposition }
  }

  exportTsv(runId: string, path: string): void {
    this.requireRun(runId); const destination = this.layout.assertContained(path)
    const rows = this.database.prepare(`SELECT e.ordinal, e.kind, e.experiment_id, e.parent_commit, e.candidate_commit, e.state, e.metric, e.decision, e.exit_code, e.signal, e.timed_out, COALESCE(e.annotation_json, 'unavailable') AS annotation_json, COALESCE(e.host_facts_json, 'unavailable') AS host_facts_json, CASE WHEN COUNT(a.artifact_id)=0 THEN 'unavailable' WHEN SUM(CASE WHEN a.retention IN ('pruned','pruning') THEN 0 ELSE 1 END)=0 THEN 'pruned' ELSE 'available' END AS artifacts, e.terminal_at FROM experiments e LEFT JOIN artifacts a ON a.experiment_id=e.experiment_id WHERE e.run_id = ? GROUP BY e.experiment_id ORDER BY e.ordinal DESC, e.experiment_id DESC`).all(runId)
    const columns = ['ordinal','kind','experiment_id','parent_commit','candidate_commit','state','metric','decision','exit_code','signal','timed_out','annotation_json','host_facts_json','artifacts','terminal_at']
    const body = [columns.join('\t'), ...rows.map((row) => columns.map((column) => tsvCell(row[column])).join('\t'))].join('\n') + '\n'
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(descriptor, body, { encoding: 'utf8' }); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(temporary, destination); chmodSync(destination, 0o600)
      const directory = openSync(dirname(destination), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch (error) { try { unlinkSync(temporary) } catch { /* best effort for derived output */ }; throw error }
  }

  pruneArtifacts(runId: string, cutoffMs: number, retainFailedArtifacts: boolean): number {
    if (Number.isNaN(cutoffMs)) throw new TypeError('artifact retention cutoff must be a number')
    if (typeof retainFailedArtifacts !== 'boolean') throw new TypeError('retainFailedArtifacts must be boolean')
    if (!this.retentionSafe(runId)) return 0
    const selected = this.transaction(() => {
      const rows = this.database.prepare(`SELECT a.*, t.outcome_json FROM artifacts a LEFT JOIN attempts t ON t.run_id = a.run_id AND t.attempt_id = a.attempt_id WHERE a.run_id = ? AND a.retention <> 'pruned' ORDER BY a.created_at, a.artifact_id`).all(runId)
      const beginPruning = this.database.prepare("UPDATE artifacts SET retention = 'pruning' WHERE artifact_id = ? AND retention = 'retain'")
      const result: PrunableArtifact[] = []
      for (const row of rows) {
        const retention = String(row['retention'])
        if (retention !== 'retain' && retention !== 'pruning') throw new TrackerTransitionError(`artifact ${String(row['artifact_id'])} has unsupported retention ${retention}`)
        const expired = timestamp(row['created_at'], 'artifact created_at') < cutoffMs
        const failed = !retainFailedArtifacts && failedAttempt(row['outcome_json'])
        if (retention === 'retain' && !expired && !failed) continue
        const artifact = prunableArtifact(row, this.layout.root, runId)
        if (retention === 'retain' && beginPruning.run(artifact.artifactId).changes !== 1) throw new TrackerTransitionError(`artifact ${artifact.artifactId} retention changed concurrently`)
        result.push(artifact)
      }
      return result
    })
    for (const artifact of selected) {
      secureDeleteArtifact(artifact, this.layout.root)
      this.transaction(() => {
        const changed = this.database.prepare("UPDATE artifacts SET retention = 'pruned' WHERE artifact_id = ? AND retention = 'pruning'").run(artifact.artifactId).changes
        if (changed !== 1 && this.database.prepare('SELECT retention FROM artifacts WHERE artifact_id = ?').get(artifact.artifactId)?.['retention'] !== 'pruned') throw new TrackerTransitionError(`artifact pruning outcome could not be finalized: ${artifact.path}`)
      })
    }
    return selected.length
  }

  pruneTsv(runId: string, cutoffMs: number): boolean {
    if (Number.isNaN(cutoffMs)) throw new TypeError('TSV retention cutoff must be a number')
    if (!this.retentionSafe(runId)) return false
    const path = join(this.layout.root, 'exports', `${safeStateComponent(runId, 'run id')}.tsv`)
    const info = optionalLstat(path)
    if (!info || info.mtimeMs >= cutoffMs) return false
    secureDeleteFile(path, info)
    removeEmptyParents(dirname(path), this.layout.root)
    return true
  }

  private retentionSafe(runId: string): boolean {
    const recovery = this.recoveryState(runId)
    const state = String(recovery.run['state']) as RunDurableState
    return RUN_TERMINAL[state] && recovery.run['terminal_quiescent'] === 1 && recovery.processDisposition === 'quiescent' && recovery.activeLock === undefined
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
    const integrity = String(this.database.prepare('PRAGMA integrity_check').get()?.['integrity_check'])
    if (integrity !== 'ok') throw new TrackerBlockedError('tracker-schema-invalid', `tracker integrity check failed: ${integrity}`)
    const rows = this.database.prepare('SELECT singleton, version FROM schema_metadata').all()
    if (rows.length !== 1 || rows[0]?.['singleton'] !== 1) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema metadata must contain exactly singleton row 1')
    const version = Number(rows[0]['version'])
    if (!Number.isSafeInteger(version) || version < 1) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema version is invalid')
    if (version > TRACKER_SCHEMA_VERSION) throw new TrackerBlockedError('tracker-schema-newer', `tracker schema ${version} is newer than supported ${TRACKER_SCHEMA_VERSION}`)
    if (schemaFingerprint(this.database) !== canonicalSchemaFingerprint(version)) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker schema does not match the canonical schema definition')
    if (!this.foreignKeysEnabled()) throw new TrackerBlockedError('tracker-schema-invalid', 'tracker foreign keys are disabled')
  }
  private secureSidecars(): void { for (const suffix of ['', '-wal', '-shm']) { try { this.layout.secureFile(`${this.path}${suffix}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } } }
  private insertRun(record: InitialRunRecord, at: string, contractGeneration?: typeof EVALUATOR_CONTRACT_GENERATION): void {
    this.database.prepare(`INSERT INTO runs (run_id, repository_id, repository, git_common_dir, caller_cwd, start_commit, run_tag, branch, worktree,
      agent_id, session_id, policy_json, policy_sha256, provenance_json, provenance_sha256, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`).run(
      record.runId, record.repositoryId, record.repository, record.gitCommonDir, record.callerCwd, record.startCommit, record.runTag, record.branch, record.worktree,
      record.agentId ?? null, record.sessionId ?? null, serializeDurablePolicy(record.policy), record.policySha256,
      canonicalJson(redactEnvironment(record.provenance)), record.provenanceSha256, at, at)
    this.insertTransition(record.runId, null, 'run', null, 'initializing', { intent: contractGeneration === undefined ? { kind: 'create-run' } : { kind: 'create-run', contractGeneration } }, at)
  }
  private insertExperiment(record: ExperimentRecord, at: string): void {
    const annotation = record.annotation === undefined ? null : canonicalJson(normalizeUntrustedResearchAnnotation(record.annotation, record.redactionSecrets ?? []))
    this.database.prepare(`INSERT INTO experiments (experiment_id, run_id, ordinal, kind, parent_commit, candidate_commit, state, command, args_json, cwd, annotation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'baseline-pending', ?, ?, ?, ?, ?, ?)`).run(record.experimentId, record.runId, record.ordinal, record.kind, record.parentCommit, record.candidateCommit ?? null, record.command, canonicalJson(record.args), record.cwd ?? null, annotation, at, at)
    this.insertTransition(record.runId, record.experimentId, 'experiment', null, 'baseline-pending', { intent: { kind: 'create-experiment' } }, at)
  }
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
  5(database) { database.exec(`CREATE TABLE schema_metadata_canonical (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT; INSERT INTO schema_metadata_canonical SELECT singleton, version, created_at FROM schema_metadata; DROP TABLE schema_metadata; ALTER TABLE schema_metadata_canonical RENAME TO schema_metadata;`) },
  6(database) { database.exec(`ALTER TABLE attempts ADD COLUMN outcome_json TEXT; CREATE TRIGGER attempts_immutable_outcome BEFORE UPDATE OF outcome_json ON attempts WHEN OLD.outcome_json IS NOT NULL OR NEW.outcome_json IS NULL BEGIN SELECT RAISE(ABORT, 'immutable attempt outcome'); END;`) },
  7(database) { database.exec(`CREATE TABLE run_registrations (run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT, contract_generation TEXT NOT NULL CHECK(contract_generation = 'host-registration-v1'), evaluator_id TEXT NOT NULL, registration_json TEXT NOT NULL, manifest_json TEXT NOT NULL, registration_fingerprint TEXT NOT NULL CHECK(length(registration_fingerprint)=64), created_at TEXT NOT NULL) STRICT; CREATE TRIGGER run_registrations_immutable BEFORE UPDATE ON run_registrations BEGIN SELECT RAISE(ABORT, 'immutable evaluator registration identity'); END;`) },
  8(database) { database.exec(`CREATE TRIGGER run_registrations_presence_monotonic BEFORE DELETE ON run_registrations BEGIN SELECT RAISE(ABORT, 'evaluator registration presence is monotonic'); END;`) },
  9(database) { database.exec(`ALTER TABLE experiments ADD COLUMN annotation_json TEXT; ALTER TABLE experiments ADD COLUMN host_facts_json TEXT; CREATE TRIGGER experiments_annotation_immutable BEFORE UPDATE OF annotation_json ON experiments WHEN OLD.annotation_json IS NOT NEW.annotation_json BEGIN SELECT RAISE(ABORT, 'immutable untrusted research annotation'); END;`) },
}

const expectedSchemaFingerprints = new Map<number, string>()
function canonicalSchemaFingerprint(version: number): string {
  const cached = expectedSchemaFingerprints.get(version)
  if (cached !== undefined) return cached
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false })
  try {
    for (let current = 1; current <= version; current += 1) {
      MIGRATIONS[current]!(database)
      database.prepare('UPDATE schema_metadata SET version = ? WHERE singleton = 1').run(current)
    }
    const fingerprint = schemaFingerprint(database)
    expectedSchemaFingerprints.set(version, fingerprint)
    return fingerprint
  } finally { database.close() }
}

function schemaFingerprint(database: DatabaseSync): string {
  const objects = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`).all()
  const tables = objects.filter((object) => object['type'] === 'table').map((object) => String(object['name']))
  const tableDetails = tables.map((table) => ({
    table,
    columns: database.prepare('SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table),
    foreignKeys: database.prepare('SELECT id, seq, "table", "from", "to", on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table),
    indexes: database.prepare('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY seq').all(table).map((index) => ({
      ...index,
      columns: database.prepare('SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno').all(String(index['name'])),
    })),
  }))
  return createHash('sha256').update(canonicalJson({ objects, tableDetails })).digest('hex')
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
function attemptOutcomeFacts(checkpoint: AttemptOutcomeCheckpoint): AttemptOutcome {
  const { facts, result } = checkpoint
  if (result.kind === 'measured') {
    if (!Number.isFinite(result.metric)) throw new TrackerTransitionError('attempt metric must be finite')
    if (hasOwn(facts, 'failureCode') || hasOwn(facts, 'failureMessage')) throw new TrackerTransitionError('measured attempt cannot carry failure facts')
    return facts
  }
  if (!result.code.trim() || !result.message.trim()) throw new TrackerTransitionError('failed attempt requires a non-empty code and message')
  if (facts.failureCode !== undefined && facts.failureCode !== result.code) throw new TrackerTransitionError('attempt failure code conflicts with its authoritative result')
  if (facts.failureMessage !== undefined && facts.failureMessage !== result.message) throw new TrackerTransitionError('attempt failure message conflicts with its authoritative result')
  return { ...facts, failureCode: result.code, failureMessage: result.message }
}
function normalizeUntrustedResearchAnnotation(value: UntrustedResearchAnnotation, secrets: readonly string[] = []): UntrustedResearchAnnotation {
  const text = (item: string, label: string, max: number): string => { if (typeof item !== 'string' || item !== item.trim() || item.length === 0 || item.length > max || /[\0\r]/u.test(item)) throw new TrackerTransitionError(`${label} is not bounded normalized text`); return redactConfiguredSecrets(item, secrets) }
  if (value.trust !== 'untrusted-child-annotation') throw new TrackerTransitionError('research annotation must be explicitly untrusted')
  if (value.redaction !== undefined && value.redaction !== 'exact-configured-secrets-only') throw new TrackerTransitionError('research annotation redaction semantics are invalid')
  if (!Array.isArray(value.intendedEdits) || value.intendedEdits.length > 64) throw new TrackerTransitionError('intended edits exceed the bounded annotation limit')
  return { trust: value.trust, redaction: 'exact-configured-secrets-only', hypothesis: text(value.hypothesis, 'hypothesis', 4096), intendedEdits: value.intendedEdits.map((item, index) => text(item, `intendedEdits[${index}]`, 512)), implementationSummary: text(value.implementationSummary, 'implementationSummary', 4096) }
}
function redactExactSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactConfiguredSecrets(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactExactSecrets(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExactSecrets(item, secrets)]))
  return value
}
function normalizeHostResearchFacts(value: HostResearchFacts, secrets: readonly string[] = []): HostResearchFacts {
  const uniquePaths = value.changedPaths === undefined ? undefined : [...new Set(value.changedPaths.map(path => redactConfiguredSecrets(path, secrets)))].sort()
  let pathBytes = 0
  const changedPaths = uniquePaths?.filter(path => { const bytes = Buffer.byteLength(path); if (pathBytes + bytes > 4096) return false; pathBytes += bytes; return pathBytes <= 4096 }).slice(0, 32)
  const pathsTruncated = uniquePaths !== undefined && changedPaths !== undefined && changedPaths.length < uniquePaths.length
  const result: HostResearchFacts = { ...(value.candidateCommit === undefined ? {} : { candidateCommit: value.candidateCommit }), ...(changedPaths === undefined ? {} : { changedPaths }), ...(pathsTruncated ? { changedPathsStatus: 'truncated' as const } : value.changedPathsStatus === undefined ? {} : { changedPathsStatus: value.changedPathsStatus }), ...(value.diffStats === undefined ? {} : { diffStats: value.diffStats }), ...(value.failure === undefined ? {} : { failure: value.failure }) }
  if (result.candidateCommit !== undefined && !/^[0-9a-f]{40}$/u.test(result.candidateCommit)) throw new TrackerTransitionError('Host candidate commit is invalid')
  if (result.changedPaths?.some(path => typeof path !== 'string' || path.length === 0 || path.length > 1024 || /[\0\r\n]/u.test(path))) throw new TrackerTransitionError('Host changed paths are invalid')
  if (result.diffStats && Object.values(result.diffStats).some(item => !Number.isSafeInteger(item) || item < 0)) throw new TrackerTransitionError('Host diff statistics are invalid')
  if (result.failure) validateHostFailureFacts(result.failure)
  return result
}
function validateHostFailureFacts(failure: HostFailureFacts): void {
  if (RESEARCH_FAILURE_CODES[failure.code] !== true) throw new TrackerTransitionError('Host failure code is invalid')
  const expected = failure.code === 'spawn' ? ['code', 'spawn'] : failure.code === 'exit' ? ['code', 'exitCode'] : failure.code === 'signal' ? ['code', 'signal'] : failure.code === 'timeout' ? ['code', 'timedOut'] : failure.code === 'output-limit' ? ['code', 'output'] : failure.code === 'metric-protocol' ? ['code', 'metricProtocol'] : ['code']
  if (Object.keys(failure).sort().join(',') !== expected.sort().join(',')) throw new TrackerTransitionError('Host failure facts do not match the failure code')
  if (failure.spawn !== undefined && failure.spawn !== 'provider-spawn-failed') throw new TrackerTransitionError('Host spawn fact is invalid')
  if (failure.exitCode !== undefined && !Number.isSafeInteger(failure.exitCode)) throw new TrackerTransitionError('Host exit code is invalid')
  if (failure.signal !== undefined && !/^[A-Z][A-Z0-9]{0,31}$/u.test(failure.signal)) throw new TrackerTransitionError('Host signal is invalid')
  if (failure.timedOut !== undefined && failure.timedOut !== true) throw new TrackerTransitionError('Host timeout fact is invalid')
  if (failure.output !== undefined && failure.output !== 'stdout-limit-exceeded') throw new TrackerTransitionError('Host output fact is invalid')
  if (failure.metricProtocol !== undefined && failure.metricProtocol !== 'rejected') throw new TrackerTransitionError('Host metric protocol fact is invalid')
}
interface PrunableArtifact { readonly artifactId: string; readonly path: string; readonly sizeBytes: number; readonly sha256: string }

function prunableArtifact(row: Record<string, SQLOutputValue>, root: string, runId: string): PrunableArtifact {
  const artifactId = String(row['artifact_id'])
  const experimentId = safeStateComponent(String(row['experiment_id'] ?? ''), 'artifact experiment id')
  const attemptId = safeStateComponent(String(row['attempt_id'] ?? ''), 'artifact attempt id')
  const kind = String(row['kind'])
  if (kind !== 'stdout' && kind !== 'stderr') throw new TrackerTransitionError(`artifact ${artifactId} has unsupported kind ${kind}`)
  if (String(row['run_id']) !== runId || artifactId !== `${attemptId}-${kind}` || String(row['owner']) !== 'evaluator') throw new TrackerTransitionError(`artifact ${artifactId} has noncanonical ownership`)
  const path = join(root, 'artifacts', safeStateComponent(runId, 'run id'), experimentId, attemptId, `${kind}.log`)
  const sizeBytes = integer(row['size_bytes'], 'artifact size')
  const sha256 = String(row['sha256'])
  const location = `artifact:sha256:${createHash('sha256').update(path).digest('hex')}`
  if (sizeBytes < 0 || !/^[0-9a-f]{64}$/u.test(sha256) || String(row['location']) !== location) throw new TrackerTransitionError(`artifact ${artifactId} has noncanonical location, size, or hash`)
  const metadata = parseJson(row['metadata_json'], 'artifact metadata')
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== 1 || typeof (metadata as Record<string, unknown>).truncated !== 'boolean') throw new TrackerTransitionError(`artifact ${artifactId} has noncanonical metadata`)
  return { artifactId, path, sizeBytes, sha256 }
}

function failedAttempt(value: unknown): boolean {
  if (value === null || value === undefined) return false
  const outcome = parseJson(value, 'attempt outcome')
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new TrackerTransitionError('attempt outcome is malformed during retention')
  const kind = (outcome as Record<string, unknown>).kind
  if (kind === 'failed') return true
  if (kind === 'measured') return false
  throw new TrackerTransitionError('attempt outcome kind is invalid during retention')
}

function secureDeleteArtifact(artifact: PrunableArtifact, root: string): void {
  const info = optionalLstat(artifact.path)
  if (!info) return
  validateOwnerFile(artifact.path, info)
  const fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new TrackerTransitionError(`artifact identity changed before retention pruning: ${artifact.path}`)
    bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new TrackerTransitionError(`artifact identity changed during retention pruning: ${artifact.path}`)
  } finally { closeSync(fd) }
  if (bytes.length !== artifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new TrackerTransitionError(`artifact content does not match durable retention evidence: ${artifact.path}`)
  const beforeDelete = lstatSync(artifact.path)
  if (beforeDelete.dev !== info.dev || beforeDelete.ino !== info.ino) throw new TrackerTransitionError(`artifact identity changed before deletion: ${artifact.path}`)
  unlinkSync(artifact.path)
  fsyncDirectory(dirname(artifact.path))
  removeEmptyParents(dirname(artifact.path), join(root, 'artifacts'))
}

function secureDeleteFile(path: string, info: Stats): void {
  validateOwnerFile(path, info)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new TrackerTransitionError(`retained file identity changed before deletion: ${path}`)
  } finally { closeSync(fd) }
  const beforeDelete = lstatSync(path)
  if (beforeDelete.dev !== info.dev || beforeDelete.ino !== info.ino) throw new TrackerTransitionError(`retained file identity changed before deletion: ${path}`)
  unlinkSync(path)
  fsyncDirectory(dirname(path))
}

function validateOwnerFile(path: string, info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new TrackerTransitionError(`retained path is not a regular file: ${path}`)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new TrackerTransitionError(`retained file is not owner-controlled: ${path}`)
  if ((info.mode & 0o077) !== 0) throw new TrackerTransitionError(`retained file is not owner-only: ${path}`)
  if (realpathSync(path) !== path) throw new TrackerTransitionError(`retained file traverses a symlink: ${path}`)
}

function removeEmptyParents(start: string, stop: string): void {
  let current = start
  while (current !== stop) {
    try {
      const info = lstatSync(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TrackerTransitionError(`retention parent is not a real directory: ${current}`)
      rmdirSync(current)
      fsyncDirectory(dirname(current))
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return
      throw error
    }
    current = dirname(current)
  }
}

function fsyncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function optionalLstat(path: string): Stats | undefined { try { return lstatSync(path) } catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error } }
function safeStateComponent(value: string, label: string): string { if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') throw new TrackerTransitionError(`${label} contains unsafe characters`); return value }
function integer(value: unknown, label: string): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new TrackerTransitionError(`${label} must be an integer`); return result }
function timestamp(value: unknown, label: string): number { const result = typeof value === 'string' ? Date.parse(value) : Number.NaN; if (!Number.isFinite(result)) throw new TrackerTransitionError(`${label} must be an ISO timestamp`); return result }
function parseJson(value: unknown, label: string): unknown { if (typeof value !== 'string') throw new TrackerTransitionError(`${label} must be JSON text`); try { return JSON.parse(value) } catch { throw new TrackerTransitionError(`${label} is malformed`) } }
function textJson(value: unknown, label: string): string { if (typeof value !== 'string') throw new TrackerTransitionError(`${label} must be JSON text`); return value }
function assertRegistrationShape(value: unknown): asserts value is EvaluatorRegistration {
  assertObjectKeys(value, 'registration', ['evaluatorId', 'command', 'args', 'environment', 'metricName', 'metricDirection', 'evaluatorFiles', 'dataset'], ['cwd'])
  assertString(value.evaluatorId, 'registration.evaluatorId')
  assertString(value.command, 'registration.command')
  assertStringArray(value.args, 'registration.args')
  if (value.cwd !== undefined) assertString(value.cwd, 'registration.cwd')
  assertStringRecord(value.environment, 'registration.environment')
  assertString(value.metricName, 'registration.metricName')
  assertString(value.metricDirection, 'registration.metricDirection')
  assertStringArray(value.evaluatorFiles, 'registration.evaluatorFiles')
  assertDatasetShape(value.dataset)
}
function assertDatasetShape(value: unknown): asserts value is EvaluatorRegistration['dataset'] {
  if (!isJsonObject(value) || typeof value.kind !== 'string') throw new TrackerTransitionError('registration.dataset must be an object with a string kind')
  if (value.kind === 'none') assertObjectKeys(value, 'registration.dataset', ['kind'])
  else if (value.kind === 'local') { assertObjectKeys(value, 'registration.dataset', ['kind', 'files'], ['identity']); assertStringArray(value.files, 'registration.dataset.files'); if (value.identity !== undefined) assertString(value.identity, 'registration.dataset.identity') }
  else if (value.kind === 'external') { assertObjectKeys(value, 'registration.dataset', ['kind', 'digest'], ['identity']); assertString(value.digest, 'registration.dataset.digest'); if (value.identity !== undefined) assertString(value.identity, 'registration.dataset.identity') }
  else throw new TrackerTransitionError('registration.dataset has an unknown kind')
}
function assertManifestShape(value: unknown): asserts value is RegistrationManifest { assertStringRecord(value, 'registration manifest') }
function assertObjectKeys(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isJsonObject(value)) throw new TrackerTransitionError(`${label} must be an object`)
  const allowed = [...required, ...optional]
  if (required.some(key => !hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) throw new TrackerTransitionError(`${label} has an invalid shape`)
}
function assertString(value: unknown, label: string): asserts value is string { if (typeof value !== 'string') throw new TrackerTransitionError(`${label} must be a string`) }
function assertStringArray(value: unknown, label: string): asserts value is string[] { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TrackerTransitionError(`${label} must be an array of strings`) }
function assertStringRecord(value: unknown, label: string): asserts value is Record<string, string> { if (!isJsonObject(value) || Object.values(value).some(item => typeof item !== 'string')) throw new TrackerTransitionError(`${label} must be an object of strings`) }
function isJsonObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function hasOwn(value: object, property: PropertyKey): boolean { return Object.prototype.hasOwnProperty.call(value, property) }
function errorRecord(error: unknown): Record<string, unknown> | undefined { return error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined }
function errorCode(error: unknown): unknown { return errorRecord(error)?.['code'] }
function isSqliteBusyOrLocked(error: unknown): boolean {
  const record = errorRecord(error)
  if (!record) return false
  const code = record['code']
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true
  const errcode = record['errcode']
  const numericCode = typeof errcode === 'number' ? errcode : typeof code === 'number' ? code : undefined
  return numericCode !== undefined && ((numericCode & 0xff) === 5 || (numericCode & 0xff) === 6)
}
function sleep(milliseconds: number): void { Atomics.wait(TRACKER_RETRY_WAIT, 0, 0, milliseconds) }
export function serializeDurablePolicy(policy: unknown): string { return serializeRedactedDurablePolicy(redactEnvironment(policy)) }
export function serializeRedactedDurablePolicy(policy: unknown): string { return canonicalJson(policy) }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)])); if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('tracker JSON snapshots require finite numbers'); if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('tracker snapshots must be JSON values'); return value }
function redactEnvironment(value: unknown): unknown { if (Array.isArray(value)) return value.map(redactEnvironment); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key.toLowerCase() === 'environment' && item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).map(([name, secret]) => [name, { sha256: createHash('sha256').update(String(secret)).digest('hex') }])) : redactEnvironment(item)])) }
function identity(value: unknown): unknown { return value }

function snapshotSqliteDatabase(path: string, snapshotPath: string): void {
  const deadline = Date.now() + TRACKER_BUSY_TIMEOUT_MS
  let retryDelayMs = 1
  while (true) {
    if (fileExists(`${path}-wal`)) { backupSqliteSnapshot(path, snapshotPath); return }
    if (!fileExists(`${path}-journal`) && copyStableMainDatabase(path, snapshotPath) && !fileExists(`${path}-wal`) && !fileExists(`${path}-journal`)) return
    rmSync(snapshotPath, { force: true })
    if (fileExists(`${path}-wal`)) { backupSqliteSnapshot(path, snapshotPath); return }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new TrackerBlockedError('tracker-busy', 'tracker snapshot is busy after the configured timeout')
    sleep(Math.min(retryDelayMs, remainingMs))
    retryDelayMs = Math.min(retryDelayMs * 2, 50)
  }
}

function copyStableMainDatabase(path: string, snapshotPath: string): boolean {
  const source = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let before: Stats
  let bytes: Buffer
  try {
    before = fstatSync(source)
    if (!before.isFile()) throw new TrackerTransitionError('tracker path is not a regular file')
    bytes = readFileSync(source)
    const after = fstatSync(source)
    if (!sameFileIdentity(before, after) || after.size !== bytes.length) return false
  } finally { closeSync(source) }
  writeFileSync(snapshotPath, bytes, { mode: 0o400, flag: 'wx' })
  const verification = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = fstatSync(verification)
    if (!sameFileIdentity(before, current) || current.size !== bytes.length) return false
    return readFileSync(verification).equals(bytes)
  } finally { closeSync(verification) }
}

function sameFileIdentity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino }

const SQLITE_BACKUP_PROGRAM = String.raw`
const { DatabaseSync, backup } = require('node:sqlite');
const [sourcePath, snapshotPath, timeout] = process.argv.slice(1);
let source;
(async () => {
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, enableDoubleQuotedStringLiterals: false, timeout: Number(timeout) });
    source.exec('PRAGMA query_only = ON');
    await backup(source, snapshotPath, { rate: 256 });
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error?.code, errcode: error?.errcode, message: error?.message }));
    process.exitCode = 1;
  } finally {
    try { source?.close(); } catch {}
  }
})();`

function backupSqliteSnapshot(path: string, snapshotPath: string): void {
  const result = spawnSync(process.execPath, ['-e', SQLITE_BACKUP_PROGRAM, path, snapshotPath, String(TRACKER_BUSY_TIMEOUT_MS)], {
    encoding: 'utf8', timeout: TRACKER_BUSY_TIMEOUT_MS, windowsHide: true,
  })
  if (result.status === 0 && !result.error) return
  const details = parseBackupFailure(result.stderr)
  const processMessage = errorRecord(result.error)?.['message']
  const cause = Object.assign(new Error(typeof details['message'] === 'string' ? details['message'] : typeof processMessage === 'string' ? processMessage : 'SQLite backup failed'), details)
  if (errorCode(result.error) === 'ETIMEDOUT' || isSqliteBusyOrLocked(details)) throw new TrackerBlockedError('tracker-busy', 'tracker snapshot is busy after the configured timeout', cause)
  throw cause
}

function parseBackupFailure(stderr: string): Record<string, unknown> {
  try { return errorRecord(JSON.parse(stderr || '{}')) ?? {} } catch { return {} }
}


function booleanInteger(value: unknown): number { return Number(value) }
function tsvCell(value: SQLOutputValue | undefined): string { if (value === null || value === undefined) return ''; return String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\r', '\\r').replaceAll('\n', '\\n') }

function fileExists(path: string): boolean { try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
