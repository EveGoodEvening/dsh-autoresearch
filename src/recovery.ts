import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { DurableRegistrationIdentity } from './types.js'
import { GitBoundaryError, inspectRunGitState, validateCandidate, validateFrozenCandidatePaths, verifyCandidateTree, type CandidateSnapshot, type GitCommandOptions, type RepositoryDiscovery, type RunGitIdentity, type RunGitInspection } from './git.js'
import type { EvaluatorAttemptFacts, EvaluatorFailureCode } from './evaluator.js'
import { DurableTracker, type ArtifactRecord, type RecoveryState } from './tracker.js'
import type { AttemptId, BestResult, BlockerEvidence, DurableRunPolicy, ExperimentId, FullCommitSha, RegistrationBlockEvidence, RunDurableState, RunId } from './types.js'
import type { SQLOutputValue } from 'node:sqlite'

export type RecoveryBlockCode = 'run-missing' | 'repository-mismatch' | 'start-commit-mismatch' | 'policy-mismatch' | 'provenance-mismatch' | 'lock-mismatch' | 'state-ambiguous' | 'commit-missing' | 'git-external-mutation' | 'protected-change' | 'artifact-incomplete' | 'attempt-uncertain' | 'decision-mismatch' | 'reconciliation-unauthorized' | 'recovery-rerun-exhausted'
export interface RecoveredExperiment { readonly experimentId: ExperimentId; readonly ordinal: number; readonly kind: 'baseline' | 'candidate'; readonly parentCommit: FullCommitSha; readonly candidateCommit?: FullCommitSha }
export type RecoveredEvaluation = ({ readonly kind: 'measured'; readonly attemptId: AttemptId; readonly metric: number; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly ArtifactRecord[] } | { readonly kind: 'failed'; readonly attemptId: AttemptId; readonly code: EvaluatorFailureCode; readonly message: string; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly ArtifactRecord[] }) & { readonly policyViolation?: { readonly code: 'provenance-mismatch'; readonly message: string } }
export interface RecoveryRequest { readonly tracker: DurableTracker; readonly runId: RunId; readonly discovery: RepositoryDiscovery; readonly identity: RunGitIdentity; readonly policy: DurableRunPolicy; readonly policySha256: string; readonly provenanceSha256: string; readonly registration?: DurableRegistrationIdentity; readonly gitExecutable: string; readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>; readonly signal: AbortSignal }
export type RecoveryDirective =
  | { readonly kind: 'initialize'; readonly runId: RunId; readonly startCommit: FullCommitSha; readonly reuseLock: boolean }
  | { readonly kind: 'settle-baseline'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly outcome: ({ readonly kind: 'accept'; readonly metric: number } | { readonly kind: 'fail'; readonly state: 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled'; readonly code: string; readonly message: string; readonly quiescent: boolean }) }
  | { readonly kind: 'ready'; readonly runId: RunId; readonly best: BestResult; readonly nextOrdinal: number; readonly restoreCommit: FullCommitSha }
  | { readonly kind: 'commit-candidate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly snapshot: CandidateSnapshot; readonly validatedPaths: readonly string[] }
  | { readonly kind: 'evaluate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly commit: FullCommitSha; readonly createExperiment: boolean; readonly attemptOrdinal: number; readonly rerun: boolean }
  | { readonly kind: 'finalize-evaluation'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly evaluation: RecoveredEvaluation }
  | { readonly kind: 'reconcile-candidate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly candidateCommit: FullCommitSha; readonly expectedAcceptedCommit: FullCommitSha; readonly outcome: ({ readonly kind: 'accept' | 'reject'; readonly metric: number } | { readonly kind: 'continue-failure'; readonly terminalExperimentState: 'crashed' | 'timed-out'; readonly code: 'spawn' | 'exit' | 'signal' | 'timeout' | 'output-limit' | 'metric-protocol' } | { readonly kind: 'terminal-block'; readonly code: 'provenance-mismatch' | 'recovery-rerun-exhausted'; readonly message: string } | { readonly kind: 'cancel'; readonly terminalExperimentState: 'cancelled' }) }
  | { readonly kind: 'blocked'; readonly runId: RunId; readonly code: RecoveryBlockCode; readonly evidence: readonly BlockerEvidence[]; readonly lock: 'retain' | 'release-after-persist' }
  | { readonly kind: 'terminal'; readonly runId: RunId; readonly state: 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed'; readonly lock: 'release' | 'retain' | 'already-released'; readonly artifacts: readonly ArtifactRecord[] }
  | { readonly kind: 'terminal'; readonly runId: RunId; readonly state: 'cancelled'; readonly lastState: Exclude<RunDurableState, 'cancelled'>; readonly lock: 'release' | 'retain' | 'already-released'; readonly artifacts: readonly ArtifactRecord[] }

const SHA = /^[0-9a-f]{40}$/u
const HASH = /^[0-9a-f]{64}$/u
const TERMINAL: Readonly<Record<RunDurableState, boolean>> = { initializing: false, 'baseline-running': false, ready: false, 'candidate-prepared': false, 'candidate-running': false, deciding: false, completed: true, 'baseline-blocked': true, blocked: true, 'round-failed': true, cancelled: true }
const FAILURE_CODES: Readonly<Record<EvaluatorFailureCode, true>> = { spawn: true, timeout: true, cancelled: true, exit: true, signal: true, 'output-limit': true, 'metric-protocol': true }
const CONTINUABLE_FAILURE_CODES: Readonly<Record<Exclude<EvaluatorFailureCode, 'cancelled' | 'spawn'>, true>> = { timeout: true, exit: true, signal: true, 'output-limit': true, 'metric-protocol': true }

type Row = Record<string, SQLOutputValue>
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
type RecoveredAttemptResult = { readonly kind: 'measured'; readonly metric: number } | { readonly kind: 'failed'; readonly code: EvaluatorFailureCode; readonly message: string }
class RecoveryEvidenceError extends Error {
  constructor(readonly code: RecoveryBlockCode, message: string) { super(message); this.name = 'RecoveryEvidenceError' }
}
export type DurableRegistrationClassification =
  | { readonly kind: 'legacy'; readonly evidence: RegistrationBlockEvidence }
  | { readonly kind: 'registered'; readonly identity: DurableRegistrationIdentity }
  | { readonly kind: 'blocked'; readonly evidence: RegistrationBlockEvidence }

/** Classify durable evaluator authority before resume ownership or mutation. */
export function classifyDurableRegistration(tracker: DurableTracker, runId: RunId): DurableRegistrationClassification {
  try {
    const creation = tracker.database.prepare("SELECT intent_json FROM transitions WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing' ORDER BY sequence LIMIT 1").get(runId)
    const intent = creation?.['intent_json'] === null || creation?.['intent_json'] === undefined ? undefined : JSON.parse(String(creation['intent_json'])) as unknown
    const currentContract = isRecord(intent) && intent['kind'] === 'create-run' && intent['contractGeneration'] === 'host-registration-v1'
    if (!currentContract) return { kind: 'legacy', evidence: { kind: 'legacy-run', code: 'legacy-contract', message: 'run contains only legacy raw policy/provenance evidence' } }
    try {
      const identity = tracker.readRegistration(runId)
      if (identity) return { kind: 'registered', identity }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('no such table: run_registrations')) throw error
    }
    return { kind: 'blocked', evidence: { kind: 'registration-blocked', code: 'registration-corrupt', message: 'current evaluator-contract run is missing its durable registration' } }
  } catch (error) {
    return { kind: 'blocked', evidence: { kind: 'registration-blocked', code: 'registration-corrupt', message: error instanceof Error ? error.message : 'durable evaluator registration is corrupt' } }
  }
}

export async function reconcileRecovery(ctx: Context, request: RecoveryRequest): Promise<RecoveryDirective> {
  if (request.signal.aborted) throw request.signal.reason
  const run = request.tracker.getRun(request.runId)
  if (!run) return blocked(request, 'run-missing', 'durable run row is absent', 'retain')
  const identityFailure = validateIdentity(run, request)
  if (identityFailure) return identityFailure

  const state = exactState(run['state'])
  const recovery = request.tracker.recoveryState(request.runId)
  if (recovery.activeLock && (text(recovery.activeLock['repository_id']) !== request.discovery.repositoryId || text(recovery.activeLock['run_tag']) !== text(run['run_tag']) || text(recovery.activeLock['run_id']) !== request.runId)) return blocked(request, 'lock-mismatch', 'active lock identity differs from durable run identity', 'retain')
  if (TERMINAL[state]) return terminalDirective(request, state, recovery)
  if (state !== 'initializing' && !recovery.activeLock) return blocked(request, 'lock-mismatch', 'non-initial run has no active run lock', 'retain')
  if (state === 'initializing') return { kind: 'initialize', runId: request.runId, startCommit: request.discovery.startCommit, reuseLock: Boolean(recovery.activeLock) }

  const inspection = await inspectRunGitState(ctx, request.gitExecutable, request.discovery, request.identity, { ...request.gitOptions, signal: request.signal })
  const gitFailure = validateGitInspection(request, state, inspection)
  if (gitFailure) return gitFailure

  const experiments = request.tracker.database.prepare('SELECT * FROM experiments WHERE run_id = ? ORDER BY ordinal').all(request.runId) as Row[]
  const attempts = request.tracker.database.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY experiment_id, ordinal').all(request.runId) as Row[]
  if (experiments.filter(row => !isExperimentTerminal(text(row['state']))).length > 1) return blocked(request, 'state-ambiguous', 'multiple unresolved experiments exist', 'retain')

  if (state === 'ready') return readyDirective(request, run, experiments)

  const row = recovery.unresolvedExperiment ?? experiments.at(-1)
  if (!row) {
    if (state === 'baseline-running') return evaluateNewBaseline(request)
    return blocked(request, 'state-ambiguous', `${state} has no experiment`, 'retain')
  }
  const experiment = decodeExperiment(row)

  if (state === 'candidate-prepared') {
    const intent = findCandidateIntent(request.tracker.listTransitions(request.runId), experiment.experimentId)
    if (!experiment.candidateCommit) {
      if (!intent) return blocked(request, 'state-ambiguous', 'candidate preparation has no durable snapshot intent', 'retain')
      try {
        if (request.registration) validateFrozenCandidatePaths(intent, { evaluatorFiles: request.registration.registration.evaluatorFiles, datasetFiles: request.registration.registration.dataset.kind === 'local' ? request.registration.registration.dataset.files : [] })
        const validatedPaths = validateCandidate(intent, request.policy)
        return { kind: 'commit-candidate', runId: request.runId, experiment, snapshot: intent, validatedPaths }
      } catch (error) { return gitBlocked(request, error) }
    }
    if (!inspection.auditCommits.includes(experiment.candidateCommit)) return blocked(request, 'commit-missing', 'candidate audit ref is absent', 'retain')
    if (intent) {
      try { await verifyCandidateTree(ctx, request.gitExecutable, request.identity.worktree, experiment.experimentId, intent, { parentCommit: experiment.parentCommit, candidateCommit: experiment.candidateCommit, auditRef: `${request.identity.candidateRefPrefix}${experiment.experimentId}`, changedPaths: validateCandidate(intent, request.policy) }, { ...request.gitOptions, signal: request.signal }) }
      catch (error) { return gitBlocked(request, error) }
    }
    return evaluationDirective(request, experiment, row, attempts)
  }

  if (state === 'baseline-running' && isExperimentTerminal(text(row['state']))) return baselineSettlement(request, experiment, row)
  if ((state === 'candidate-running' || state === 'deciding') && isExperimentTerminal(text(row['state']))) return decidingDirective(request, run, experiment, row, attempts)
  if (state === 'baseline-running' || state === 'candidate-running') return evaluationDirective(request, experiment, row, attempts)
  if (state === 'deciding') return decidingDirective(request, run, experiment, row, attempts)
  return blocked(request, 'state-ambiguous', `unsupported nonterminal state ${state}`, 'retain')
}

function validateIdentity(run: Row, request: RecoveryRequest): RecoveryDirective | undefined {
  if (text(run['repository_id']) !== request.discovery.repositoryId) return blocked(request, 'repository-mismatch', 'canonical repository identity differs from immutable run identity', 'retain')
  if (text(run['start_commit']) !== request.discovery.startCommit) return blocked(request, 'start-commit-mismatch', 'start commit differs from immutable run identity', 'retain')
  if (text(run['policy_sha256']) !== request.policySha256) return blocked(request, 'policy-mismatch', 'normalized policy hash differs from durable policy', 'retain')
  if (text(run['provenance_sha256']) !== request.provenanceSha256) return blocked(request, 'provenance-mismatch', 'evaluator provenance hash differs from durable provenance', 'retain')
  if (request.identity.runId !== request.runId || request.identity.branch !== text(run['branch']) || request.identity.worktree !== text(run['worktree'])) return blocked(request, 'repository-mismatch', 'run Git identity differs from immutable durable identity', 'retain')
  if (!SHA.test(request.discovery.startCommit) || !HASH.test(request.policySha256) || !HASH.test(request.provenanceSha256) || !request.gitExecutable) return blocked(request, 'provenance-mismatch', 'recovery inputs are not full validated identities', 'retain')
}

function validateGitInspection(request: RecoveryRequest, state: RunDurableState, inspection: RunGitInspection): RecoveryDirective | undefined {
  if (!inspection.worktreeRegistered || inspection.registeredBranch !== `refs/heads/${request.identity.branch}`) return blocked(request, 'git-external-mutation', 'run worktree registration or branch attachment differs', 'retain')
  if (!inspection.headCommit || !SHA.test(inspection.headCommit)) return blocked(request, 'commit-missing', 'run worktree HEAD is absent', 'retain')
  if (!inspection.branchCommit || !SHA.test(inspection.branchCommit)) return blocked(request, 'commit-missing', 'run branch commit is absent', 'retain')
  if (inspection.headCommit !== inspection.branchCommit) return blocked(request, 'git-external-mutation', 'run worktree HEAD and branch diverged', 'retain')
  if (state !== 'baseline-running' && !inspection.acceptedCommit) return blocked(request, 'commit-missing', 'accepted ref is absent', 'retain')
}

function readyDirective(request: RecoveryRequest, run: Row, experiments: Row[]): RecoveryDirective {
  const best = decodeBest(run)
  if (!best) return blocked(request, 'state-ambiguous', 'ready run has no complete best result', 'retain')
  const nextOrdinal = Math.max(0, ...experiments.filter(row => text(row['kind']) === 'candidate').map(row => integer(row['ordinal']))) + 1
  return { kind: 'ready', runId: request.runId, best, nextOrdinal, restoreCommit: best.commit }
}

function evaluateNewBaseline(request: RecoveryRequest): RecoveryDirective {
  const experiment: RecoveredExperiment = { experimentId: `${request.runId}-baseline`, ordinal: 0, kind: 'baseline', parentCommit: request.discovery.startCommit }
  return { kind: 'evaluate', runId: request.runId, experiment, commit: request.discovery.startCommit, createExperiment: true, attemptOrdinal: 1, rerun: false }
}

function evaluationDirective(request: RecoveryRequest, experiment: RecoveredExperiment, experimentRow: Row, allAttempts: Row[]): RecoveryDirective {
  const own = allAttempts.filter(row => text(row['experiment_id']) === experiment.experimentId).sort((a, b) => integer(a['ordinal']) - integer(b['ordinal']))
  const latest = own.at(-1)
  const commit = experiment.candidateCommit ?? experiment.parentCommit
  if (text(experimentRow['state']) === 'baseline-pending') return { kind: 'evaluate', runId: request.runId, experiment, commit, createExperiment: false, attemptOrdinal: 1, rerun: false }
  if (!latest) return { kind: 'evaluate', runId: request.runId, experiment, commit, createExperiment: false, attemptOrdinal: 1, rerun: false }
  const attemptId = text(latest['attempt_id'])
  if (spawnProvenance(latest) !== request.provenanceSha256) return blocked(request, 'provenance-mismatch', `attempt ${attemptId} spawn provenance differs from the durable run provenance`, 'retain')
  if (latest['process_tree_quiescent'] !== 1) {
    const evidence = [`attempt ${attemptId} lacks durable whole-process-tree quiescence`]
    request.tracker.checkpointRecoverableBlocked(request.runId, { code: 'attempt-uncertain', evidence })
    return blocked(request, 'attempt-uncertain', evidence[0]!, 'retain')
  }
  try {
    const reconstructed = reconstructEvaluation(request, experiment, latest)
    if (reconstructed) return { kind: 'finalize-evaluation', runId: request.runId, experiment, evaluation: reconstructed }
  } catch (error) {
    const evidence = error instanceof RecoveryEvidenceError ? error : new RecoveryEvidenceError('artifact-incomplete', `durable evaluator evidence could not be decoded: ${error instanceof Error ? error.message : String(error)}`)
    return blocked(request, evidence.code, evidence.message, 'retain')
  }
  const artifacts = request.tracker.database.prepare('SELECT 1 FROM artifacts WHERE attempt_id = ? LIMIT 1').get(attemptId)
  if (artifacts) return blocked(request, 'artifact-incomplete', `attempt ${attemptId} has artifacts without a durable outcome`, 'retain')
  return { kind: 'evaluate', runId: request.runId, experiment, commit, createExperiment: false, attemptOrdinal: integer(latest['ordinal']) + 1, rerun: true }
}

function reconstructEvaluation(request: RecoveryRequest, experiment: RecoveredExperiment, attempt: Row, allowPruned = false): RecoveredEvaluation | undefined {
  if (!attempt['exited_at']) return undefined
  const attemptId = text(attempt['attempt_id'])
  const exit = decodeExit(attempt)
  const provenanceSha256 = spawnProvenance(attempt)
  if (provenanceSha256 !== request.provenanceSha256) throw new RecoveryEvidenceError('provenance-mismatch', 'attempt spawn provenance differs from the durable run provenance')
  const result = decodeAttemptResult(attempt, attemptId)
  if (experiment.kind === 'candidate' && result.kind === 'failed' && result.code === 'spawn' && exit.providerPid === undefined && exit.spawnedAt === undefined && exit.processTreeQuiescent) {
    const remaining = request.tracker.database.prepare('SELECT 1 FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ? LIMIT 1').get(request.runId, experiment.experimentId, attemptId)
    if (remaining && allowPruned) {
      request.tracker.validateProvenNoProcessCandidateArtifactDiscard(attemptId)
      return { ...result, attemptId, provenanceSha256, exit, artifacts: [] }
    }
    if (remaining) request.tracker.discardProvenNoProcessCandidateArtifacts(attemptId)
    const retained = request.tracker.database.prepare('SELECT 1 FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ? LIMIT 1').get(request.runId, experiment.experimentId, attemptId)
    if (retained) throw new RecoveryEvidenceError('artifact-incomplete', 'proven-no-process candidate spawn failure retained evaluator artifacts')
    return { ...result, attemptId, provenanceSha256, exit, artifacts: [] }
  }
  const artifacts = request.tracker.database.prepare('SELECT * FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ? ORDER BY kind').all(request.runId, experiment.experimentId, attemptId) as Row[]
  if (artifacts.length === 0) throw new RecoveryEvidenceError('artifact-incomplete', 'completed evaluator attempt has no durable artifacts')
  if (artifacts.length !== 2 || artifacts.map(row => text(row['kind'])).sort().join(',') !== 'stderr,stdout') throw new RecoveryEvidenceError('artifact-incomplete', 'durable attempt artifacts must contain exactly one stdout and one stderr artifact')
  const decoded: ArtifactRecord[] = []
  for (const row of artifacts) {
    const kind = text(row['kind'])
    if (text(row['artifact_id']) !== `${attemptId}-${kind}` || text(row['run_id']) !== request.runId || text(row['experiment_id']) !== experiment.experimentId || text(row['attempt_id']) !== attemptId) throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} has noncanonical attempt-scoped identity`)
    const retention = text(row['retention'])
    if (text(row['owner']) !== 'evaluator' || retention !== 'retain' && (!allowPruned || retention !== 'pruned' && retention !== 'pruning')) throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} has noncanonical owner or retention`)
    const path = join(request.tracker.layout.root, 'artifacts', request.runId, experiment.experimentId, attemptId, `${kind}.log`)
    const location = `artifact:sha256:${createHash('sha256').update(path).digest('hex')}`
    const sizeBytes = integer(row['size_bytes'])
    const sha256 = text(row['sha256'])
    if (text(row['location']) !== location || sizeBytes < 0 || !HASH.test(sha256)) throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} failed canonical location, size, or hash validation`)
    if (retention === 'retain') {
      const bytes = readSecure(path)
      if (sizeBytes !== bytes.length || sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} failed canonical size or hash verification`)
    }
    const metadata = json(row['metadata_json'])
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== 1 || typeof (metadata as Record<string, unknown>).truncated !== 'boolean') throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} has noncanonical truncation metadata`)
    decoded.push({ artifactId: `${attemptId}-${kind}`, runId: request.runId, experimentId: experiment.experimentId, attemptId, kind, location, sizeBytes, sha256, owner: 'evaluator', retention, metadata })
  }
  const policyViolation = frozenMismatchAuthority(request.tracker, experiment.experimentId, attemptId, attempt)
  if (result.kind === 'failed') return { ...result, attemptId, provenanceSha256, exit, artifacts: decoded, ...(policyViolation ? { policyViolation } : {}) }
  const stdout = decoded.find(item => item.kind === 'stdout')!
  if (Boolean((stdout.metadata as Record<string, unknown>).truncated)) throw new RecoveryEvidenceError('state-ambiguous', `measured attempt ${attemptId} has truncated authoritative stdout`)
  if (!exit.processTreeQuiescent || exit.timedOut || exit.cancelled || exit.signal !== null || exit.exitCode !== 0) throw new RecoveryEvidenceError('state-ambiguous', `measured attempt ${attemptId} conflicts with its durable exit facts`)
  return { ...result, attemptId, provenanceSha256, exit, artifacts: decoded, ...(policyViolation ? { policyViolation } : {}) }
}

function baselineSettlement(request: RecoveryRequest, experiment: RecoveredExperiment, row: Row): RecoveryDirective {
  const evaluation = terminalEvaluation(request, experiment, row)
  if (evaluation instanceof RecoveryEvidenceError) return blocked(request, evaluation.code, evaluation.message, 'retain')
  const state = text(row['state'])
  const metric = number(row['metric'])
  if (state === 'accepted' && metric !== undefined && evaluation.kind === 'measured' && evaluation.metric === metric) return { kind: 'settle-baseline', runId: request.runId, experiment, outcome: { kind: 'accept', metric } }
  if (state === 'policy-violation' && text(row['failure_code']) === 'provenance-mismatch' && evaluation.policyViolation?.code === 'provenance-mismatch') return { kind: 'settle-baseline', runId: request.runId, experiment, outcome: { kind: 'fail', state, code: 'provenance-mismatch', message: text(row['failure_message']) || evaluation.policyViolation.message, quiescent: evaluation.exit.processTreeQuiescent } }
  const terminal = terminalExperimentState(row)
  if (!terminal || evaluation.kind !== 'failed') return blocked(request, 'state-ambiguous', 'terminal baseline does not match its durable evaluator outcome', 'retain')
  return { kind: 'settle-baseline', runId: request.runId, experiment, outcome: { kind: 'fail', state: terminal, code: evaluation.code, message: evaluation.message, quiescent: evaluation.exit.processTreeQuiescent } }
}

function terminalEvaluation(request: RecoveryRequest, experiment: RecoveredExperiment, row: Row): RecoveredEvaluation | RecoveryEvidenceError {
  const attempts = request.tracker.database.prepare('SELECT * FROM attempts WHERE run_id = ? AND experiment_id = ? ORDER BY ordinal').all(request.runId, experiment.experimentId) as Row[]
  const latest = attempts.at(-1)
  if (!latest) return new RecoveryEvidenceError('attempt-uncertain', `terminal experiment ${experiment.experimentId} has no durable evaluator attempt`)
  if (latest['process_tree_quiescent'] !== 1) return new RecoveryEvidenceError('attempt-uncertain', `attempt ${text(latest['attempt_id'])} lacks durable whole-process-tree quiescence`)
  try { return reconstructEvaluation(request, experiment, latest) ?? new RecoveryEvidenceError('attempt-uncertain', `attempt ${text(latest['attempt_id'])} has no durable outcome`) }
  catch (error) { return error instanceof RecoveryEvidenceError ? error : new RecoveryEvidenceError('artifact-incomplete', `durable evaluator evidence could not be decoded: ${error instanceof Error ? error.message : String(error)}`) }
}

function decidingDirective(request: RecoveryRequest, run: Row, experiment: RecoveredExperiment, row: Row, attempts: Row[]): RecoveryDirective {
  const latest = attempts.filter(item => text(item['experiment_id']) === experiment.experimentId).sort((a, b) => integer(a['ordinal']) - integer(b['ordinal'])).at(-1)
  if (latest && latest['process_tree_quiescent'] !== 1) {
    const message = `attempt ${text(latest['attempt_id'])} lacks durable whole-process-tree quiescence`
    request.tracker.checkpointRecoverableBlocked(request.runId, { code: 'attempt-uncertain', evidence: [message] })
    return blocked(request, 'attempt-uncertain', message, 'retain')
  }
  const durableMetric = number(row['metric'])
  const failureCode = row['failure_code'] === null ? undefined : text(row['failure_code'])
  if (isExperimentTerminal(text(row['state'])) || durableMetric !== undefined) {
    if (failureCode === 'recovery-rerun-exhausted') {
      if (!experiment.candidateCommit) return blocked(request, 'commit-missing', 'deciding candidate has no candidate commit', 'retain')
      const best = decodeBest(run)
      if (!best) return blocked(request, 'state-ambiguous', 'deciding run has no prior best', 'retain')
      return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: 'terminal-block', code: failureCode, message: 'canonical evaluator measurement recovery reruns are exhausted' } }
    }
    const evaluation = terminalEvaluation(request, experiment, row)
    if (evaluation instanceof RecoveryEvidenceError) return blocked(request, evaluation.code, evaluation.message, 'retain')
    if (failureCode === 'provenance-mismatch') {
      if (evaluation.policyViolation?.code !== 'provenance-mismatch') return blocked(request, 'state-ambiguous', 'candidate provenance mismatch lacks durable post-outcome policy authority', 'retain')
      if (!experiment.candidateCommit) return blocked(request, 'commit-missing', 'deciding candidate has no candidate commit', 'retain')
      const best = decodeBest(run)
      if (!best) return blocked(request, 'state-ambiguous', 'deciding run has no prior best', 'retain')
      return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: 'terminal-block', code: failureCode, message: text(row['failure_message']) || evaluation.policyViolation.message } }
    }
    if (durableMetric !== undefined && (evaluation.kind !== 'measured' || evaluation.metric !== durableMetric)) return blocked(request, 'state-ambiguous', 'candidate metric does not match its durable evaluator outcome', 'retain')
    if (durableMetric === undefined && evaluation.kind !== 'failed') return blocked(request, 'state-ambiguous', 'terminal candidate failure does not match its durable evaluator outcome', 'retain')
    if (evaluation.kind === 'failed') {
      if (!experiment.candidateCommit) return blocked(request, 'commit-missing', 'deciding candidate has no candidate commit', 'retain')
      const best = decodeBest(run)
      if (!best) return blocked(request, 'state-ambiguous', 'deciding run has no prior best', 'retain')
      const terminal = terminalExperimentState(row)
      if (!terminal) return blocked(request, 'state-ambiguous', 'failed candidate is not durably terminal', 'retain')
      if (evaluation.code === 'cancelled' && terminal === 'cancelled') return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: 'cancel', terminalExperimentState: terminal } }
      if (!isContinuableCandidateFailure(evaluation)) return blocked(request, 'attempt-uncertain', evaluation.code === 'spawn' ? 'spawn failure does not prove that no evaluator process was created' : `candidate failure ${evaluation.code} is not safely continuable`, 'retain')
      if (terminal !== 'crashed' && terminal !== 'timed-out') return blocked(request, 'state-ambiguous', 'continuable candidate failure has an incompatible terminal state', 'retain')
      return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: 'continue-failure', terminalExperimentState: terminal, code: evaluation.code } }
    }
  }
  if (!experiment.candidateCommit) return blocked(request, 'commit-missing', 'deciding candidate has no candidate commit', 'retain')
  const best = decodeBest(run)
  if (!best) return blocked(request, 'state-ambiguous', 'deciding run has no prior best', 'retain')
  const metric = number(row['metric'])
  if (metric === undefined) return blocked(request, 'state-ambiguous', 'deciding experiment lacks metric or terminal failure', 'retain')
  const expected = request.policy.metricDirection === 'minimize' ? metric < best.metric : metric > best.metric
  const durable = row['decision'] === null ? undefined : text(row['decision'])
  if (durable && durable !== (expected ? 'accept' : 'reject')) return blocked(request, 'decision-mismatch', 'durable decision differs from strict host recomputation', 'retain')
  return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: expected ? 'accept' : 'reject', metric } }
}

function isContinuableCandidateFailure(evaluation: Extract<RecoveredEvaluation, { kind: 'failed' }>): evaluation is Extract<RecoveredEvaluation, { kind: 'failed' }> & { readonly code: 'spawn' | 'exit' | 'signal' | 'timeout' | 'output-limit' | 'metric-protocol' } {
  switch (evaluation.code) {
    case 'spawn': return evaluation.exit.providerPid === undefined && evaluation.exit.spawnedAt === undefined
    case 'exit': case 'signal': case 'timeout': case 'output-limit': case 'metric-protocol': return CONTINUABLE_FAILURE_CODES[evaluation.code]
    case 'cancelled': return false
  }
}

function terminalDirective(request: RecoveryRequest, state: RunDurableState, recovery: RecoveryState): RecoveryDirective {
  const terminal = state as 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed' | 'cancelled'
  const evidence = validateTerminalEvidence(request, terminal)
  if (evidence instanceof RecoveryEvidenceError) return blocked(request, evidence.code, evidence.message, 'retain')
  let lastState: Exclude<RunDurableState, 'cancelled'> | undefined
  if (terminal === 'cancelled') {
    try { lastState = request.tracker.cancellationOrigin(request.runId) }
    catch (error) { return blocked(request, 'state-ambiguous', error instanceof Error ? error.message : 'cancelled run transition evidence is invalid', 'retain') }
  }
  const releasable = recovery.run['terminal_quiescent'] === 1 && recovery.processDisposition === 'quiescent'
  const lock = !releasable ? 'retain' : recovery.activeLock ? 'release' : 'already-released'
  return terminal === 'cancelled'
    ? { kind: 'terminal', runId: request.runId, state: terminal, lastState: lastState!, lock, artifacts: evidence }
    : { kind: 'terminal', runId: request.runId, state: terminal, lock, artifacts: evidence }
}

function validateTerminalEvidence(request: RecoveryRequest, state: 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed' | 'cancelled'): readonly ArtifactRecord[] | RecoveryEvidenceError {
  const experiments = request.tracker.database.prepare('SELECT * FROM experiments WHERE run_id = ? ORDER BY ordinal').all(request.runId) as Row[]
  const discardingAttemptIds = new Set<string>()
  const attempts = request.tracker.database.prepare('SELECT a.* FROM attempts a JOIN experiments e ON e.run_id = a.run_id AND e.experiment_id = a.experiment_id WHERE a.run_id = ? ORDER BY e.ordinal, a.ordinal, a.attempt_id').all(request.runId) as Row[]
  const decoded: ArtifactRecord[] = []
  const validatedAttemptIds = new Set<string>()
  try {
    for (const attempt of attempts) {
      const attemptId = text(attempt['attempt_id'])
      if (spawnProvenance(attempt) !== request.provenanceSha256) throw new RecoveryEvidenceError('provenance-mismatch', `attempt ${attemptId} spawn provenance differs from the durable run provenance`)
      if (attempt['process_tree_quiescent'] !== 1) throw new RecoveryEvidenceError('attempt-uncertain', `attempt ${attemptId} lacks durable whole-process-tree quiescence`)
      if (!attempt['exited_at']) {
        const stray = request.tracker.database.prepare('SELECT 1 FROM artifacts WHERE attempt_id = ? LIMIT 1').get(attemptId)
        if (stray) throw new RecoveryEvidenceError('artifact-incomplete', `attempt ${attemptId} has artifacts without a durable outcome`)
        continue
      }
      const experimentRow = experiments.find(row => text(row['experiment_id']) === text(attempt['experiment_id']))
      if (!experimentRow) throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} has no durable experiment`)
      const evaluation = reconstructEvaluation(request, decodeExperiment(experimentRow), attempt, true)
      if (!evaluation) throw new RecoveryEvidenceError('attempt-uncertain', `attempt ${attemptId} has no durable outcome`)
      decoded.push(...evaluation.artifacts)
      validatedAttemptIds.add(attemptId)
      if (evaluation.artifacts.length === 0 && request.tracker.database.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND attempt_id = ? AND retention = 'discarding' LIMIT 1").get(request.runId, attemptId)) discardingAttemptIds.add(attemptId)
    }
    const allArtifacts = request.tracker.database.prepare('SELECT attempt_id FROM artifacts WHERE run_id = ?').all(request.runId) as Row[]
    const retainedArtifacts = allArtifacts.filter(row => !discardingAttemptIds.has(text(row['attempt_id'])))
    if (retainedArtifacts.length !== decoded.length || allArtifacts.some(row => !validatedAttemptIds.has(text(row['attempt_id'])))) throw new RecoveryEvidenceError('artifact-incomplete', 'terminal run contains unexpected or non-evaluator artifact rows')
    const evaluatedExperiments = new Set((request.tracker.database.prepare("SELECT DISTINCT experiment_id FROM transitions WHERE run_id = ? AND scope = 'experiment' AND from_state = 'running' AND to_state NOT IN ('running','baseline-pending')").all(request.runId) as Row[]).map(row => text(row['experiment_id'])))
    for (const experimentId of evaluatedExperiments) {
      const latest = attempts.filter(row => text(row['experiment_id']) === experimentId).at(-1)
      const experiment = experiments.find(row => text(row['experiment_id']) === experimentId)
      if (!latest || !latest['exited_at'] && text(experiment?.['failure_code']) !== 'recovery-rerun-exhausted') throw new RecoveryEvidenceError('attempt-uncertain', `terminal evaluated experiment ${experimentId} lacks a completed evaluator attempt`)
      if (latest['exited_at'] && text(experiment?.['failure_code']) === 'provenance-mismatch') {
        const evaluation = reconstructEvaluation(request, decodeExperiment(experiment!), latest, true)
        if (evaluation?.policyViolation?.code !== 'provenance-mismatch') throw new RecoveryEvidenceError('state-ambiguous', `terminal provenance mismatch experiment ${experimentId} lacks durable post-outcome policy authority`)
      }
    }
    if (state === 'baseline-blocked') {
      const baseline = experiments.find(row => text(row['kind']) === 'baseline')
      if (!baseline || !isExperimentTerminal(text(baseline['state']))) throw new RecoveryEvidenceError('state-ambiguous', 'baseline-blocked run lacks a terminal baseline experiment')
      const own = attempts.filter(row => text(row['experiment_id']) === text(baseline['experiment_id']))
      const exhausted = text(baseline['failure_code']) === 'recovery-rerun-exhausted'
      const latest = own.at(-1)
      if (!latest || !latest['exited_at']) {
        if (!exhausted || !latest || latest['process_tree_quiescent'] !== 1) throw new RecoveryEvidenceError('attempt-uncertain', 'baseline-blocked run lacks a completed baseline evaluator attempt')
      } else {
        const outcome = reconstructEvaluation(request, decodeExperiment(baseline), latest, true)
        const mismatch = text(baseline['failure_code']) === 'provenance-mismatch'
        if (!outcome || (mismatch ? outcome.policyViolation?.code !== 'provenance-mismatch' : outcome.kind !== 'failed')) throw new RecoveryEvidenceError('state-ambiguous', 'baseline-blocked run does not match its evaluator outcome and terminal policy authority')
      }
    }
    if (state === 'completed') {
      const run = request.tracker.getRun(request.runId)!
      const best = decodeBest(run)
      const experiment = best && experiments.find(row => text(row['experiment_id']) === best.experimentId)
      if (!best || !experiment || text(experiment['state']) !== 'accepted' || number(experiment['metric']) !== best.metric) throw new RecoveryEvidenceError('state-ambiguous', 'completed run lacks a canonical accepted best experiment')
      const latest = attempts.filter(row => text(row['experiment_id']) === best.experimentId).at(-1)
      if (!latest || !latest['exited_at']) throw new RecoveryEvidenceError('attempt-uncertain', 'completed run lacks durable evaluator evidence for its best experiment')
      const outcome = reconstructEvaluation(request, decodeExperiment(experiment), latest, true)
      if (!outcome || outcome.kind !== 'measured' || outcome.metric !== best.metric) throw new RecoveryEvidenceError('state-ambiguous', 'completed best result does not match its evaluator outcome')
    }
    return decoded
  } catch (error) {
    return error instanceof RecoveryEvidenceError ? error : new RecoveryEvidenceError('artifact-incomplete', `terminal evaluator evidence could not be decoded: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function decodeExperiment(row: Row): RecoveredExperiment {
  const candidate = row['candidate_commit'] === null ? undefined : text(row['candidate_commit'])
  return { experimentId: text(row['experiment_id']), ordinal: integer(row['ordinal']), kind: text(row['kind']) as 'baseline' | 'candidate', parentCommit: text(row['parent_commit']), ...(candidate ? { candidateCommit: candidate } : {}) }
}
function decodeBest(run: Row): BestResult | undefined { const metric = number(run['best_metric']); const commit = run['best_commit'] === null ? '' : text(run['best_commit']); const experimentId = run['best_experiment_id'] === null ? '' : text(run['best_experiment_id']); return metric !== undefined && SHA.test(commit) && experimentId ? { metric, commit, experimentId } : undefined }
function decodeAttemptResult(row: Row, attemptId: string): RecoveredAttemptResult {
  let value: unknown
  try { value = json(row['outcome_json']) }
  catch { throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} has malformed authoritative outcome JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} lacks an authoritative durable outcome`)
  const result = value as Record<string, unknown>
  const keys = Object.keys(result).sort().join(',')
  if (result.kind === 'measured') {
    if (keys !== 'kind,metric' || typeof result.metric !== 'number' || !Number.isFinite(result.metric)) throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} has a malformed measured outcome`)
    if (row['failure_code'] !== null || row['failure_message'] !== null) throw new RecoveryEvidenceError('state-ambiguous', `measured attempt ${attemptId} carries failure facts`)
    return { kind: 'measured', metric: result.metric }
  }
  if (result.kind === 'failed') {
    if (keys !== 'code,kind,message' || typeof result.code !== 'string' || !Object.hasOwn(FAILURE_CODES, result.code) || typeof result.message !== 'string' || !result.message.trim()) throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} has a malformed failed outcome`)
    if (text(row['failure_code']) !== result.code || text(row['failure_message']) !== result.message) throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} failure facts differ from its authoritative outcome`)
    return { kind: 'failed', code: result.code as EvaluatorFailureCode, message: result.message }
  }
  throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} has an unknown authoritative outcome kind`)
}
function frozenMismatchAuthority(tracker: DurableTracker, experimentId: string, attemptId: string, attempt: Row): { code: 'provenance-mismatch'; message: string } | undefined {
  const rawOutcome = attempt['outcome_json']
  if (typeof rawOutcome !== 'string') throw new RecoveryEvidenceError('state-ambiguous', `attempt ${attemptId} lacks its raw authoritative outcome representation`)
  const rows = tracker.database.prepare("SELECT transition_id, outcome_json FROM transitions WHERE experiment_id = ? AND outcome_json IS NOT NULL ORDER BY sequence DESC").all(experimentId) as Row[]
  for (const row of rows) {
    const outcome = json(row['outcome_json'])
    if (!isRecord(outcome) || outcome['kind'] !== 'frozen-file-policy-mismatch' || outcome['code'] !== 'provenance-mismatch' || typeof outcome['message'] !== 'string' || !outcome['message'].trim()) continue
    if (JSON.stringify(outcome['evaluatorResult']) !== rawOutcome) throw new RecoveryEvidenceError('state-ambiguous', `frozen mismatch authority for attempt ${attemptId} conflicts with its raw evaluator outcome`)
    const transitionId = row['transition_id']
    if (typeof transitionId !== 'string' || !transitionId.trim()) throw new RecoveryEvidenceError('state-ambiguous', `frozen mismatch authority for attempt ${attemptId} has a missing or corrupt durable transition identifier`)
    const artifacts = tracker.database.prepare('SELECT COUNT(*) AS count FROM transition_artifacts ta JOIN artifacts a ON a.artifact_id = ta.artifact_id WHERE ta.transition_id = ? AND a.attempt_id = ?').get(transitionId, attemptId)
    if (Number(artifacts?.['count'] ?? 0) !== 2) throw new RecoveryEvidenceError('artifact-incomplete', `frozen mismatch authority for attempt ${attemptId} lacks its canonical artifact pair`)
    return { code: 'provenance-mismatch', message: outcome['message'] }
  }
  return undefined
}
function decodeExit(row: Row): EvaluatorAttemptFacts { return { ...(row['provider_pid'] === null ? {} : { providerPid: integer(row['provider_pid']) }), ...(row['spawned_at'] === null ? {} : { spawnedAt: text(row['spawned_at']) }), exitedAt: text(row['exited_at']), exitCode: row['exit_code'] === null ? null : integer(row['exit_code']), signal: row['signal'] === null ? null : text(row['signal']), timedOut: row['timed_out'] === 1, cancelled: text(row['failure_code']) === 'cancelled', processTreeQuiescent: row['process_tree_quiescent'] === 1, ...(row['failure_code'] === null ? {} : { failureCode: text(row['failure_code']) }), ...(row['failure_message'] === null ? {} : { failureMessage: text(row['failure_message']) }) } }
function spawnProvenance(row: Row): string { const intent = json(row['spawn_intent_json']); return intent && typeof intent === 'object' ? String((intent as Record<string, unknown>).provenanceSha256 ?? (intent as Record<string, unknown>).provenance_sha256 ?? '') : '' }
function findCandidateIntent(transitions: Row[], experimentId: string): CandidateSnapshot | undefined { for (const row of [...transitions].reverse()) { if (row['experiment_id'] !== null && row['experiment_id'] !== experimentId) continue; const intent = json(row['intent_json']); if (!intent || typeof intent !== 'object') continue; const object = intent as Record<string, unknown>; const snapshot = (object.snapshot ?? (object.kind === 'candidate-snapshot' ? object : undefined)) as CandidateSnapshot | undefined; if (snapshot?.parentCommit && Array.isArray(snapshot.changed) && Array.isArray(snapshot.ignoredUntracked) && snapshot.gitConfig) return { ...snapshot, gitConfig: { files: snapshot.gitConfig.files.map(file => ({ logicalPath: file.logicalPath, path: file.path, exists: file.exists, ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }) })), allowedPaths: [...snapshot.gitConfig.allowedPaths] } } } }
function terminalExperimentState(row: Row): 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled' | undefined { const value = text(row['state']); return ['crashed', 'timed-out', 'policy-violation', 'cancelled'].includes(value) ? value as 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled' : undefined }
function isExperimentTerminal(state: string): boolean { return !['baseline-pending', 'running'].includes(state) }
function exactState(value: unknown): RunDurableState { const state = text(value) as RunDurableState; if (!['initializing', 'baseline-running', 'ready', 'candidate-prepared', 'candidate-running', 'deciding', 'completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(state)) throw new TypeError(`unknown durable run state ${state}`); return state }
function blocked(request: RecoveryRequest, code: RecoveryBlockCode, message: string, lock: 'retain' | 'release-after-persist'): RecoveryDirective { return { kind: 'blocked', runId: request.runId, code, evidence: [{ code, message, artifacts: [] }], lock } }
function gitBlocked(request: RecoveryRequest, error: unknown): RecoveryDirective { if (error instanceof GitBoundaryError) { const code: RecoveryBlockCode = error.code.includes('protected') || error.code.includes('policy') ? 'protected-change' : error.code.includes('missing') || error.code.includes('sha') ? 'commit-missing' : 'git-external-mutation'; return { kind: 'blocked', runId: request.runId, code, evidence: [{ code: error.code, message: error.message, artifacts: [] }, ...error.evidence.map(message => ({ code: error.code, message, artifacts: [] }))], lock: 'retain' } } throw error }
function readSecure(path: string): Buffer {
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('artifact is not a regular owner-controlled file')
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) throw new Error('artifact file is not owner-controlled')
    if ((before.mode & 0o077) !== 0) throw new Error('artifact file is not owner-only')
    const canonical = realpathSync(path)
    if (canonical !== path) throw new Error('artifact path traverses a symlink')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('artifact identity changed'); return readFileSync(fd) }
    finally { closeSync(fd) }
  } catch (error) { throw new RecoveryEvidenceError('artifact-incomplete', `artifact could not be securely recovered: ${error instanceof Error ? error.message : String(error)}`) }
}
function json(value: unknown): unknown { if (typeof value !== 'string') return undefined; try { return JSON.parse(value) } catch { throw new TypeError('malformed durable JSON checkpoint') } }
function text(value: unknown): string { if (typeof value !== 'string') return value === null || value === undefined ? '' : String(value); return value }
function integer(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new TypeError('durable integer is invalid'); return result }
function number(value: unknown): number | undefined { if (value === null || value === undefined) return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new TypeError('durable metric is invalid'); return result }
