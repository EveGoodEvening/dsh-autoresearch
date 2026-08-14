import { createHash } from 'node:crypto'
import { lstatSync, openSync, closeSync, constants, fstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { GitBoundaryError, inspectRunGitState, validateCandidate, verifyCandidateTree } from './git.js'
import type { CandidateSnapshot, GitCommandOptions, RepositoryDiscovery, RunGitIdentity, RunGitInspection } from './git.js'
import { parseFinalLineMetric } from './evaluator.js'
import type { EvaluatorAttemptFacts, EvaluatorResult } from './evaluator.js'
import type { ArtifactRecord, DurableTracker, RecoveryState } from './tracker.js'
import type { AttemptId, BestResult, BlockerEvidence, ExperimentId, FullCommitSha, NormalizedRunPolicy, RunDurableState, RunId } from './types.js'
import type { SQLOutputValue } from 'node:sqlite'

export type RecoveryBlockCode = 'run-missing' | 'repository-mismatch' | 'start-commit-mismatch' | 'policy-mismatch' | 'provenance-mismatch' | 'lock-mismatch' | 'state-ambiguous' | 'commit-missing' | 'git-external-mutation' | 'protected-change' | 'artifact-incomplete' | 'attempt-uncertain' | 'decision-mismatch' | 'reconciliation-unauthorized'
export interface RecoveredExperiment { readonly experimentId: ExperimentId; readonly ordinal: number; readonly kind: 'baseline' | 'candidate'; readonly parentCommit: FullCommitSha; readonly candidateCommit?: FullCommitSha }
export type RecoveredEvaluation = { readonly kind: 'measured'; readonly attemptId: AttemptId; readonly metric: number; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly ArtifactRecord[] } | { readonly kind: 'failed'; readonly attemptId: AttemptId; readonly code: Extract<EvaluatorResult, { kind: 'failed' }>['code']; readonly message: string; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly ArtifactRecord[] }
export interface RecoveryRequest { readonly tracker: DurableTracker; readonly runId: RunId; readonly discovery: RepositoryDiscovery; readonly identity: RunGitIdentity; readonly policy: NormalizedRunPolicy; readonly policySha256: string; readonly provenanceSha256: string; readonly gitExecutable: string; readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>; readonly signal: AbortSignal }
export type RecoveryDirective = { readonly kind: 'initialize'; readonly runId: RunId; readonly startCommit: FullCommitSha } | { readonly kind: 'ready'; readonly runId: RunId; readonly best: BestResult; readonly nextOrdinal: number; readonly restoreCommit: FullCommitSha } | { readonly kind: 'commit-candidate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly snapshot: CandidateSnapshot; readonly validatedPaths: readonly string[] } | { readonly kind: 'evaluate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly commit: FullCommitSha; readonly createExperiment: boolean; readonly attemptOrdinal: number; readonly rerun: boolean } | { readonly kind: 'finalize-evaluation'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly evaluation: RecoveredEvaluation } | { readonly kind: 'reconcile-candidate'; readonly runId: RunId; readonly experiment: RecoveredExperiment; readonly candidateCommit: FullCommitSha; readonly expectedAcceptedCommit: FullCommitSha; readonly outcome: { readonly kind: 'accept'; readonly metric: number } | { readonly kind: 'reject'; readonly metric: number } | { readonly kind: 'cleanup'; readonly terminalExperimentState: 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled' } } | { readonly kind: 'terminal'; readonly runId: RunId; readonly state: 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed' | 'cancelled'; readonly lock: 'release' | 'already-released' | 'retain' } | { readonly kind: 'blocked'; readonly runId: RunId; readonly code: RecoveryBlockCode; readonly evidence: readonly BlockerEvidence[]; readonly lock: 'retain' | 'release-after-persist' }

const SHA = /^[0-9a-f]{40}$/u
const HASH = /^[0-9a-f]{64}$/u
const TERMINAL: Readonly<Record<RunDurableState, boolean>> = { initializing: false, 'baseline-running': false, ready: false, 'candidate-prepared': false, 'candidate-running': false, deciding: false, completed: true, 'baseline-blocked': true, blocked: true, 'round-failed': true, cancelled: true }
const FAILURE_CODES: Readonly<Record<string, true>> = { spawn: true, timeout: true, cancelled: true, exit: true, signal: true, 'output-limit': true, 'metric-protocol': true }

type Row = Record<string, SQLOutputValue>
class RecoveryEvidenceError extends Error {
  constructor(readonly code: RecoveryBlockCode, message: string) { super(message); this.name = 'RecoveryEvidenceError' }
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
  if (state === 'initializing' && !recovery.activeLock) return { kind: 'initialize', runId: request.runId, startCommit: request.discovery.startCommit }

  const inspection = await inspectRunGitState(ctx, request.gitExecutable, request.discovery, request.identity, { ...request.gitOptions, signal: request.signal })
  const gitFailure = validateGitInspection(request, state, inspection)
  if (gitFailure) return gitFailure

  const experiments = request.tracker.database.prepare('SELECT * FROM experiments WHERE run_id = ? ORDER BY ordinal').all(request.runId) as Row[]
  const attempts = request.tracker.database.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY experiment_id, ordinal').all(request.runId) as Row[]
  if (experiments.filter(row => !isExperimentTerminal(text(row['state']))).length > 1) return blocked(request, 'state-ambiguous', 'multiple unresolved experiments exist', 'retain')

  if (state === 'initializing') return { kind: 'initialize', runId: request.runId, startCommit: request.discovery.startCommit }
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

  if (state === 'baseline-running' || state === 'candidate-running') return evaluationDirective(request, experiment, row, attempts)
  if (state === 'deciding') return decidingDirective(request, run, experiment, row, attempts)
  return blocked(request, 'state-ambiguous', `unsupported nonterminal state ${state}`, 'retain')
}

function validateIdentity(run: Row, request: RecoveryRequest): RecoveryDirective | undefined {
  if (text(run['repository_id']) !== request.discovery.repositoryId || text(run['repository']) !== request.discovery.repository || text(run['git_common_dir']) !== request.discovery.gitCommonDir || text(run['caller_cwd']) !== request.discovery.callerCwd) return blocked(request, 'repository-mismatch', 'repository discovery differs from immutable run identity', 'retain')
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
  if (latest['process_tree_quiescent'] !== 1) {
    const evidence = [`attempt ${text(latest['attempt_id'])} lacks durable whole-process-tree quiescence`]
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
  return { kind: 'evaluate', runId: request.runId, experiment, commit, createExperiment: false, attemptOrdinal: integer(latest['ordinal']) + 1, rerun: true }
}

function reconstructEvaluation(request: RecoveryRequest, experiment: RecoveredExperiment, attempt: Row): RecoveredEvaluation | undefined {
  if (!attempt['exited_at']) return undefined
  const artifacts = request.tracker.database.prepare('SELECT * FROM artifacts WHERE run_id = ? AND experiment_id = ? AND attempt_id = ? ORDER BY kind').all(request.runId, experiment.experimentId, text(attempt['attempt_id'])) as Row[]
  if (artifacts.length === 0) return undefined
  if (artifacts.length !== 2 || artifacts.map(row => text(row['kind'])).sort().join(',') !== 'stderr,stdout') throw new RecoveryEvidenceError('artifact-incomplete', 'durable attempt artifacts are incomplete or duplicated')
  const decoded: ArtifactRecord[] = []
  let stdout = ''
  for (const row of artifacts) {
    const kind = text(row['kind'])
    const path = join(request.tracker.layout.root, 'artifacts', request.runId, experiment.experimentId, text(attempt['attempt_id']), `${kind}.log`)
    const bytes = readSecure(path)
    const location = `artifact:sha256:${createHash('sha256').update(path).digest('hex')}`
    if (text(row['location']) !== location || integer(row['size_bytes']) !== bytes.length || text(row['sha256']) !== createHash('sha256').update(bytes).digest('hex')) throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} failed path, size, or hash verification`)
    const metadata = json(row['metadata_json'])
    if (!metadata || typeof metadata !== 'object' || typeof (metadata as Record<string, unknown>).truncated !== 'boolean') throw new RecoveryEvidenceError('artifact-incomplete', `artifact ${kind} has invalid truncation metadata`)
    decoded.push({ artifactId: text(row['artifact_id']), runId: request.runId, experimentId: experiment.experimentId, attemptId: text(attempt['attempt_id']), kind, location, sizeBytes: bytes.length, sha256: text(row['sha256']), owner: text(row['owner']), retention: text(row['retention']), metadata })
    if (kind === 'stdout') stdout = bytes.toString('utf8')
  }
  const exit = decodeExit(attempt)
  const attemptId = text(attempt['attempt_id'])
  const provenanceSha256 = spawnProvenance(attempt)
  if (provenanceSha256 !== request.provenanceSha256) throw new RecoveryEvidenceError('provenance-mismatch', 'attempt spawn provenance differs from the durable run provenance')
  const failureCode = attempt['failure_code'] === null ? undefined : text(attempt['failure_code'])
  if (failureCode) {
    const code = FAILURE_CODES[failureCode] ? failureCode as Extract<EvaluatorResult, { kind: 'failed' }>['code'] : 'exit'
    return { kind: 'failed', attemptId, code, message: text(attempt['failure_message']) || failureCode, provenanceSha256, exit, artifacts: decoded }
  }
  if (exit.timedOut) return { kind: 'failed', attemptId, code: 'timeout', message: 'evaluator timed out', provenanceSha256, exit, artifacts: decoded }
  if (exit.cancelled) return { kind: 'failed', attemptId, code: 'cancelled', message: 'evaluator cancelled', provenanceSha256, exit, artifacts: decoded }
  if (exit.signal) return { kind: 'failed', attemptId, code: 'signal', message: `evaluator exited by signal ${exit.signal}`, provenanceSha256, exit, artifacts: decoded }
  if (exit.exitCode !== 0) return { kind: 'failed', attemptId, code: 'exit', message: `evaluator exited with code ${exit.exitCode}`, provenanceSha256, exit, artifacts: decoded }
  const truncated = decoded.some(item => Boolean((item.metadata as Record<string, unknown>).truncated))
  if (truncated) return { kind: 'failed', attemptId, code: 'output-limit', message: 'evaluator output was truncated', provenanceSha256, exit, artifacts: decoded }
  try { return { kind: 'measured', attemptId, metric: parseFinalLineMetric(stdout, request.policy.metricName), provenanceSha256, exit, artifacts: decoded } }
  catch (error) { return { kind: 'failed', attemptId, code: 'metric-protocol', message: error instanceof Error ? error.message : String(error), provenanceSha256, exit, artifacts: decoded } }
}

function decidingDirective(request: RecoveryRequest, run: Row, experiment: RecoveredExperiment, row: Row, attempts: Row[]): RecoveryDirective {
  const latest = attempts.filter(item => text(item['experiment_id']) === experiment.experimentId).sort((a, b) => integer(a['ordinal']) - integer(b['ordinal'])).at(-1)
  if (latest && latest['process_tree_quiescent'] !== 1) {
    const message = `attempt ${text(latest['attempt_id'])} lacks durable whole-process-tree quiescence`
    request.tracker.checkpointRecoverableBlocked(request.runId, { code: 'attempt-uncertain', evidence: [message] })
    return blocked(request, 'attempt-uncertain', message, 'retain')
  }
  if (!experiment.candidateCommit) return blocked(request, 'commit-missing', 'deciding candidate has no candidate commit', 'retain')
  const best = decodeBest(run)
  if (!best) return blocked(request, 'state-ambiguous', 'deciding run has no prior best', 'retain')
  const metric = number(row['metric'])
  if (metric === undefined) {
    const terminal = terminalExperimentState(row)
    return terminal ? { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: 'cleanup', terminalExperimentState: terminal } } : blocked(request, 'state-ambiguous', 'deciding experiment lacks metric or terminal failure', 'retain')
  }
  const expected = request.policy.metricDirection === 'minimize' ? metric < best.metric : metric > best.metric
  const durable = row['decision'] === null ? undefined : text(row['decision'])
  if (durable && durable !== (expected ? 'accept' : 'reject')) return blocked(request, 'decision-mismatch', 'durable decision differs from strict host recomputation', 'retain')
  return { kind: 'reconcile-candidate', runId: request.runId, experiment, candidateCommit: experiment.candidateCommit, expectedAcceptedCommit: best.commit, outcome: { kind: expected ? 'accept' : 'reject', metric } }
}

function terminalDirective(request: RecoveryRequest, state: RunDurableState, recovery: RecoveryState): RecoveryDirective {
  const terminal = state as 'completed' | 'baseline-blocked' | 'blocked' | 'round-failed' | 'cancelled'
  if (recovery.activeLock && recovery.processDisposition === 'uncertain') return { kind: 'terminal', runId: request.runId, state: terminal, lock: 'retain' }
  return { kind: 'terminal', runId: request.runId, state: terminal, lock: recovery.activeLock ? 'release' : 'already-released' }
}

function decodeExperiment(row: Row): RecoveredExperiment {
  const candidate = row['candidate_commit'] === null ? undefined : text(row['candidate_commit'])
  return { experimentId: text(row['experiment_id']), ordinal: integer(row['ordinal']), kind: text(row['kind']) as 'baseline' | 'candidate', parentCommit: text(row['parent_commit']), ...(candidate ? { candidateCommit: candidate } : {}) }
}
function decodeBest(run: Row): BestResult | undefined { const metric = number(run['best_metric']); const commit = run['best_commit'] === null ? '' : text(run['best_commit']); const experimentId = run['best_experiment_id'] === null ? '' : text(run['best_experiment_id']); return metric !== undefined && SHA.test(commit) && experimentId ? { metric, commit, experimentId } : undefined }
function decodeExit(row: Row): EvaluatorAttemptFacts { return { ...(row['provider_pid'] === null ? {} : { providerPid: integer(row['provider_pid']) }), ...(row['spawned_at'] === null ? {} : { spawnedAt: text(row['spawned_at']) }), exitedAt: text(row['exited_at']), exitCode: row['exit_code'] === null ? null : integer(row['exit_code']), signal: row['signal'] === null ? null : text(row['signal']), timedOut: row['timed_out'] === 1, cancelled: text(row['failure_code']) === 'cancelled', processTreeQuiescent: row['process_tree_quiescent'] === 1, ...(row['failure_code'] === null ? {} : { failureCode: text(row['failure_code']) }), ...(row['failure_message'] === null ? {} : { failureMessage: text(row['failure_message']) }) } }
function spawnProvenance(row: Row): string { const intent = json(row['spawn_intent_json']); return intent && typeof intent === 'object' ? String((intent as Record<string, unknown>).provenanceSha256 ?? (intent as Record<string, unknown>).provenance_sha256 ?? '') : '' }
function findCandidateIntent(transitions: Row[], experimentId: string): CandidateSnapshot | undefined { for (const row of [...transitions].reverse()) { if (row['experiment_id'] !== null && row['experiment_id'] !== experimentId) continue; const intent = json(row['intent_json']); if (!intent || typeof intent !== 'object') continue; const object = intent as Record<string, unknown>; const snapshot = (object.snapshot ?? (object.kind === 'candidate-snapshot' ? object : undefined)) as CandidateSnapshot | undefined; if (snapshot?.parentCommit && Array.isArray(snapshot.changed) && Array.isArray(snapshot.ignoredUntracked) && snapshot.gitConfig) return snapshot } }
function terminalExperimentState(row: Row): 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled' | undefined { const value = text(row['state']); return ['crashed', 'timed-out', 'policy-violation', 'cancelled'].includes(value) ? value as 'crashed' | 'timed-out' | 'policy-violation' | 'cancelled' : undefined }
function isExperimentTerminal(state: string): boolean { return !['baseline-pending', 'running'].includes(state) }
function exactState(value: unknown): RunDurableState { const state = text(value) as RunDurableState; if (!['initializing', 'baseline-running', 'ready', 'candidate-prepared', 'candidate-running', 'deciding', 'completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(state)) throw new TypeError(`unknown durable run state ${state}`); return state }
function blocked(request: RecoveryRequest, code: RecoveryBlockCode, message: string, lock: 'retain' | 'release-after-persist'): RecoveryDirective { return { kind: 'blocked', runId: request.runId, code, evidence: [{ code, message, artifacts: [] }], lock } }
function gitBlocked(request: RecoveryRequest, error: unknown): RecoveryDirective { if (error instanceof GitBoundaryError) { const code: RecoveryBlockCode = error.code.includes('protected') || error.code.includes('policy') ? 'protected-change' : error.code.includes('missing') || error.code.includes('sha') ? 'commit-missing' : 'git-external-mutation'; return { kind: 'blocked', runId: request.runId, code, evidence: [{ code: error.code, message: error.message, artifacts: [] }, ...error.evidence.map(message => ({ code: error.code, message, artifacts: [] }))], lock: 'retain' } } throw error }
function readSecure(path: string): Buffer {
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('artifact is not a regular owner-controlled file')
    const canonical = realpathSync(path)
    if (canonical !== path) throw new Error('artifact path traverses a symlink')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('artifact identity changed'); return readFileSync(fd) }
    finally { closeSync(fd) }
  } catch (error) { throw new RecoveryEvidenceError('artifact-incomplete', `artifact could not be securely recovered: ${error instanceof Error ? error.message : String(error)}`) }
}
function json(value: unknown): unknown { if (typeof value !== 'string') return undefined; try { return JSON.parse(value) } catch { throw new TypeError('malformed durable JSON checkpoint') } }
function text(value: unknown): string { if (typeof value !== 'string') return value === null || value === undefined ? '' : String(value); return value }
function integer(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new TypeError('durable integer is invalid'); return result }
function number(value: unknown): number | undefined { if (value === null || value === undefined) return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new TypeError('durable metric is invalid'); return result }
