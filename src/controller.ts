import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { requestProposal, ProposalAgentError, type ProposalHistoryEntry } from './agent.js'
import { normalizeRunPolicy, type ResolvedConfig } from './config.js'
import { createEvaluatorArtifactWriterFactory } from './evaluator-artifacts.js'
import { createEvaluatorBoundary, freezeEvaluatorProvenance, revalidateEvaluatorBoundary, runEvaluator, type EvaluatorResult } from './evaluator.js'
import {
  acquireRunLock, allocateRunWorktree, checkoutCandidateForEvaluation, commitCandidate, discoverRepository, durableGitIdentity,
  makeRunGitIdentity, reconcileAcceptedHead, reconcileRejectedHead, releaseTerminalRunLock,
  removeRunWorktree, resolveGitExecutable, restoreAcceptedWorktree, snapshotCandidate, validateCandidate,
  verifyExactWorktree, type CandidateSnapshot, type GitCommandOptions, type GitConfigBaseline,
  type RepositoryDiscovery, type RunGitIdentity,
} from './git.js'
import { reconcileRecovery, type RecoveredEvaluation, type RecoveredExperiment, type RecoveryDirective } from './recovery.js'
import { DurableTracker, type ArtifactRecord } from './tracker.js'
import {
  decodeRunResult, isTargetReached, type AutoresearchRunResult, type AutoresearchToolInput,
  type BestResult, type BlockerEvidence, type ExperimentDurableState, type NormalizedRunPolicy,
  type ResultCounts, type RunDurableState, type RunId,
} from './types.js'

export interface AutoresearchRunReady { readonly runId: RunId; readonly tracker: string; readonly branch: string; readonly worktree: string }
export interface AutoresearchRunControllerOptions { readonly config: ResolvedConfig; readonly input: AutoresearchToolInput; readonly parent: Agent; readonly signal: AbortSignal; readonly jobId?: string }

interface Runtime {
  readonly runId: string; readonly policy: NormalizedRunPolicy; readonly discovery: RepositoryDiscovery
  readonly identity: RunGitIdentity; readonly tracker: DurableTracker; readonly gitExecutable: string
  readonly policySha256: string; readonly provenanceSha256: string; readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>
}

/** Sole owner of one repository/worktree/evaluator state machine. Construction has no external effects. */
export class AutoresearchRunController {
  readonly ready: Promise<AutoresearchRunReady>
  private resolveReady!: (value: AutoresearchRunReady) => void
  private rejectReady!: (reason: unknown) => void
  private readonly aborter = new AbortController()
  private runPromise?: Promise<AutoresearchRunResult>
  private cancelReason = 'cancelled'
  private tracker?: DurableTracker
  private quiescenceFailure?: ProposalAgentError

  constructor(private readonly ctx: Context, private readonly options: AutoresearchRunControllerOptions) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    const abort = () => this.cancel(String(options.signal.reason ?? 'cancelled'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  }

  run(): Promise<AutoresearchRunResult> { return this.runPromise ??= this.execute() }
  cancel(reason = 'cancelled'): void { if (this.aborter.signal.aborted) return; this.cancelReason = normalizedReason(reason); this.aborter.abort(new Error(this.cancelReason)) }
  async dispose(): Promise<void> { this.cancel('controller disposed'); if (this.runPromise) await this.runPromise.catch(() => undefined); else this.rejectReady(new Error('controller disposed before start')) }

  private async execute(): Promise<AutoresearchRunResult> {
    let runtime: Runtime | undefined
    try {
      runtime = await this.initialize()
      this.tracker = runtime.tracker
      this.resolveReady({ runId: runtime.runId, tracker: runtime.tracker.path, branch: runtime.identity.branch, worktree: runtime.identity.worktree })
      return await this.drive(runtime)
    } catch (error) {
      this.rejectReady(error)
      if (runtime && this.aborter.signal.aborted) return this.cancelled(runtime)
      throw error
    } finally {
      runtime?.tracker.close()
    }
  }

  private async initialize(): Promise<Runtime> {
    let policy = normalizeRunPolicy(this.options.input, this.options.config, String(this.options.parent.session.header.cwd))
    const gitOptions = { timeoutMs: policy.timeoutMs, graceMs: this.options.config.terminationGraceMs, maxStdoutBytes: this.options.config.maxStdoutBytes, maxStderrBytes: this.options.config.maxStderrBytes }
    const gitExecutable = await resolveGitExecutable(this.ctx, this.options.config.gitExecutable, this.aborter.signal)
    const discovery = await discoverRepository(this.ctx, gitExecutable, policy.repository, { ...gitOptions, signal: this.aborter.signal })
    const runId = policy.resumeRunId ?? randomUUID()
    const trackerPath = join(discovery.gitCommonDir, this.options.config.stateRoot, 'runs', runId, 'tracker.sqlite')
    const tracker = DurableTracker.open(trackerPath)
    const existing = tracker.getRun(runId)
    let runTag = policy.runTag
    if (policy.resumeRunId) {
      if (!existing) throw new Error(`resume run ${runId} has no durable tracker row`)
      runTag = String(existing['run_tag'])
      policy = { ...canonicalPolicy(policy), runTag }
    }
    if (!runTag) throw new TypeError('run tag is unavailable')
    const identityPolicy = canonicalPolicy(policy)
    const policySha256 = hash(identityPolicy)
    const discoveryBoundary = createEvaluatorBoundary(discovery.repository, { evaluation: policy.evaluation, normalizedPolicySha256: policySha256 })
    const provenance = freezeEvaluatorProvenance(discovery.repository, provenanceInput(identityPolicy, policySha256, discoveryBoundary.evaluationSha256))
    const provenanceSha256 = provenance.sha256
    const identity = makeRunGitIdentity(this.options.config, discovery, runTag, runId)
    if (!existing) tracker.createRun({ runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag, branch: identity.branch, worktree: identity.worktree, agentId: String(this.options.parent.id), sessionId: String(this.options.parent.session.header.id), policy: identityPolicy, policySha256, provenance, provenanceSha256 })
    return { runId, policy: identityPolicy, discovery, identity, tracker, gitExecutable, policySha256, provenanceSha256, gitOptions }
  }

  private async drive(runtime: Runtime): Promise<AutoresearchRunResult> {
    let directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal })
    while (true) {
      if (this.aborter.signal.aborted) return this.cancelled(runtime)
      if (directive.kind === 'initialize') { await this.allocateAndStartBaseline(runtime, directive.reuseLock); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'evaluate') { await this.evaluate(runtime, directive.experiment, directive.commit, directive.createExperiment, directive.attemptOrdinal); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'finalize-evaluation') { await this.finalizeEvaluation(runtime, directive.experiment, directive.evaluation); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'settle-baseline') { this.settleBaseline(runtime, directive); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'commit-candidate') { await this.commitRecoveredCandidate(runtime, directive.experiment, directive.snapshot, directive.validatedPaths); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'reconcile-candidate') { await this.reconcileCandidate(runtime, directive); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'ready') {
        if (runtime.policy.target !== undefined && isTargetReached(runtime.policy.metricDirection, directive.best.metric, runtime.policy.target)) return this.complete(runtime, 'target-reached', directive.best)
        if (directive.nextOrdinal > runtime.policy.maxExperiments) return this.complete(runtime, 'budget-limited', directive.best)
        await this.propose(runtime, directive.best, directive.nextOrdinal)
        directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue
      }
      if (directive.kind === 'blocked') return this.block(runtime, directive)
      return this.returnTerminal(runtime, directive)
    }
  }

  private async allocateAndStartBaseline(r: Runtime, reuseLock: boolean): Promise<void> {
    if (!reuseLock) {
      r.tracker.checkpointRun(r.runId, { intent: { kind: 'acquire-lock' } })
      acquireRunLock(r.tracker, r.identity, r.discovery.repositoryId, this.options.config.maxActiveRunsPerRepository)
      r.tracker.checkpointRun(r.runId, { outcome: { kind: 'lock-acquired' }, intent: { kind: 'allocate-worktree' } })
    }
    await allocateRunWorktree(this.ctx, r.gitExecutable, r.discovery, r.identity, durableGitIdentity(r.tracker, r.runId), { ...r.gitOptions, signal: this.aborter.signal }, reuseLock)
    await verifyExactWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.discovery.startCommit, { ...r.gitOptions, signal: this.aborter.signal })
    r.tracker.transitionRun(r.runId, 'baseline-running', { outcome: { kind: reuseLock ? 'worktree-reconciled-and-verified' : 'worktree-allocated-and-verified' } })
  }

  private async propose(r: Runtime, best: BestResult, ordinal: number): Promise<void> {
    const experimentId = `${r.runId}-candidate-${ordinal}`
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'proposal', experimentId, ordinal } })
    let trusted: GitConfigBaseline | undefined
    try {
      const proposal = await requestProposal(this.ctx, { parent: this.options.parent, runId: r.runId, experimentId, ordinal, workspace: { repositoryId: r.discovery.repositoryId, branch: r.identity.branch, worktree: r.identity.worktree, startCommit: r.discovery.startCommit, acceptedCommit: best.commit }, policy: r.policy, policySha256: r.policySha256, provenanceSha256: r.provenanceSha256, best, history: history(r.tracker, r.runId), config: this.options.config, gitExecutable: r.gitExecutable, gitOptions: r.gitOptions, persistTrustedGitConfig: baseline => { trusted = baseline; r.tracker.checkpointRun(r.runId, { outcome: { kind: 'trusted-git-config', experimentId, baseline } }) }, signal: this.aborter.signal })
      if (proposal.blockerClaim) r.tracker.checkpointRun(r.runId, { outcome: { kind: 'child-blocker-claim', experimentId, claim: proposal.blockerClaim, authoritative: false } })
      if (!trusted) throw new Error('proposal did not persist trusted Git configuration')
      const snapshot = await snapshotCandidate(this.ctx, r.gitExecutable, r.identity.worktree, trusted, { ...r.gitOptions, signal: this.aborter.signal })
      const validatedPaths = validateCandidate(snapshot, r.policy)
      r.tracker.prepareCandidate({ experimentId, runId: r.runId, ordinal, kind: 'candidate', parentCommit: best.commit, command: r.policy.evaluation.command, args: r.policy.evaluation.args, ...(r.policy.evaluation.cwd ? { cwd: r.policy.evaluation.cwd } : {}) }, { intent: { kind: 'candidate-snapshot', experimentId, snapshot, validatedPaths } })
    } catch (error) {
      if (error instanceof ProposalAgentError && (error.code === 'dispose-failed' || error.code === 'not-quiescent')) {
        this.quiescenceFailure = error
        r.tracker.transitionRun(r.runId, 'blocked', { terminalReason: error.message, blockedCode: 'attempt-uncertain', quiescent: false, ...(best ? { best } : {}) })
        return
      }
      if (this.aborter.signal.aborted) throw error
      const evidence = errorEvidence(error)
      r.tracker.checkpointRun(r.runId, { intent: { kind: 'restore-after-proposal-failure', commit: best.commit } })
      await restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, best.commit, { ...r.gitOptions, signal: this.aborter.signal })
      r.tracker.transitionRun(r.runId, 'round-failed', { terminalReason: evidence.message, blockedCode: evidence.code, quiescent: true })
    }
  }

  private async commitRecoveredCandidate(r: Runtime, experiment: RecoveredExperiment, snapshot: CandidateSnapshot, validatedPaths: readonly string[]): Promise<void> {
    const canonicalSnapshot = { ...snapshot, gitConfig: { files: snapshot.gitConfig.files.map(file => ({ logicalPath: file.logicalPath, path: file.path, exists: file.exists, ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }) })), allowedPaths: [...snapshot.gitConfig.allowedPaths] } }
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'candidate-commit', experimentId: experiment.experimentId, snapshot: canonicalSnapshot, validatedPaths } })
    const candidate = await commitCandidate(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, experiment.experimentId, canonicalSnapshot, validatedPaths, { ...r.gitOptions, signal: this.aborter.signal })
    await checkoutCandidateForEvaluation(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, candidate.candidateCommit, experiment.parentCommit, { ...r.gitOptions, signal: this.aborter.signal })
    r.tracker.recordCandidateCommit(experiment.experimentId, candidate.candidateCommit)
    r.tracker.checkpointRun(r.runId, { outcome: { kind: 'candidate-committed', candidate } })
  }

  private async evaluate(r: Runtime, experiment: RecoveredExperiment, commit: string, createExperiment: boolean, attemptOrdinal: number): Promise<void> {
    if (experiment.kind === 'candidate') await checkoutCandidateForEvaluation(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, commit, experiment.parentCommit, { ...r.gitOptions, signal: this.aborter.signal })
    await verifyExactWorktree(this.ctx, r.gitExecutable, r.identity.worktree, commit, { ...r.gitOptions, signal: this.aborter.signal })
    if (createExperiment) r.tracker.createExperiment({ experimentId: experiment.experimentId, runId: r.runId, ordinal: experiment.ordinal, kind: experiment.kind, parentCommit: experiment.parentCommit, command: r.policy.evaluation.command, args: r.policy.evaluation.args, ...(r.policy.evaluation.cwd ? { cwd: r.policy.evaluation.cwd } : {}) })
    const row = r.tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get(experiment.experimentId)
    if (row?.['state'] === 'baseline-pending') r.tracker.transitionExperiment(experiment.experimentId, 'running')
    const desired = experiment.kind === 'baseline' ? 'baseline-running' : 'candidate-running'
    const run = r.tracker.getRun(r.runId)!
    if (run['state'] !== desired) r.tracker.transitionRun(r.runId, desired, { intent: { kind: 'evaluation', experimentId: experiment.experimentId, attemptOrdinal } })
    const attemptId = `${experiment.experimentId}-attempt-${attemptOrdinal}`
    const boundary = createEvaluatorBoundary(r.identity.worktree, { evaluation: r.policy.evaluation, normalizedPolicySha256: r.policySha256, runId: r.runId, attemptId })
    revalidateEvaluatorBoundary(r.identity.worktree, boundary)
    let intentCreated = false
    const result = await runEvaluator({ subprocess: this.ctx.subprocess, worktree: r.identity.worktree, boundary, evaluation: r.policy.evaluation, metricName: r.policy.metricName, metricDirection: r.policy.metricDirection, timeoutMs: r.policy.timeoutMs, terminationGraceMs: this.options.config.terminationGraceMs, maxStdoutBytes: this.options.config.maxStdoutBytes, maxStderrBytes: this.options.config.maxStderrBytes, artifactWriterFactory: () => { if (!intentCreated) throw new Error('artifact capability requested before durable attempt intent'); return createEvaluatorArtifactWriterFactory(r.tracker.layout, r.runId, experiment.experimentId, attemptId)() }, environment: r.policy.environment, policy: r.policy, signal: this.aborter.signal, persistence: {
      persistSpawnIntent: intent => { r.tracker.createAttemptIntent({ attemptId, runId: r.runId, experimentId: experiment.experimentId, ordinal: attemptOrdinal }, intent); intentCreated = true },
      persistSpawnObserved: facts => r.tracker.recordAttemptObserved(attemptId, facts),
      persistAttemptOutcome: (facts, artifacts) => r.tracker.recordAttemptOutcome(attemptId, { facts, artifacts: artifacts.map(item => artifact(r, experiment.experimentId, attemptId, item)), outcome: { kind: 'evaluator-outcome', facts } }),
    } })
    const recovered = { ...result, attemptId, artifacts: result.artifacts.map(item => artifact(r, experiment.experimentId, attemptId, item)) } as RecoveredEvaluation
    await this.finalizeEvaluation(r, experiment, recovered)
  }

  private async finalizeEvaluation(r: Runtime, experiment: RecoveredExperiment, evaluation: RecoveredEvaluation): Promise<void> {
    if (evaluation.provenanceSha256 !== r.provenanceSha256) return this.failEvaluation(r, experiment, evaluation, 'provenance-mismatch', 'evaluator provenance changed')
    if (evaluation.kind === 'failed') return this.failEvaluation(r, experiment, evaluation, evaluation.code, evaluation.message)
    if (experiment.kind === 'baseline') {
      const best = { metric: evaluation.metric, commit: experiment.parentCommit, experimentId: experiment.experimentId }
      r.tracker.commitTerminalExperiment(experiment.experimentId, 'accepted', { metric: evaluation.metric, decision: 'accept' })
      r.tracker.transitionRun(r.runId, 'ready', { best, outcome: { kind: 'baseline-measured', metric: evaluation.metric } })
      return
    }
    r.tracker.checkpointExperiment(experiment.experimentId, { metric: evaluation.metric, outcome: { kind: 'measured', metric: evaluation.metric } })
    r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'measured', metric: evaluation.metric } })
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'decision', metric: evaluation.metric } })
  }
  private settleBaseline(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'settle-baseline' }>): void {
    if (directive.outcome.kind === 'accept') {
      const best = { metric: directive.outcome.metric, commit: directive.experiment.parentCommit, experimentId: directive.experiment.experimentId }
      r.tracker.transitionRun(r.runId, 'ready', { best, outcome: { kind: 'baseline-settled', metric: directive.outcome.metric } })
      return
    }
    const state = directive.outcome.state === 'cancelled' && directive.outcome.quiescent ? 'cancelled' : directive.outcome.quiescent ? 'baseline-blocked' : 'blocked'
    r.tracker.transitionRun(r.runId, state, { terminalReason: directive.outcome.message, blockedCode: directive.outcome.quiescent ? directive.outcome.code : 'attempt-uncertain', quiescent: directive.outcome.quiescent })
  }

  private failEvaluation(r: Runtime, experiment: RecoveredExperiment, evaluation: RecoveredEvaluation, code: string, message: string): void {
    const state: ExperimentDurableState = code === 'timeout' ? 'timed-out' : code === 'cancelled' ? 'cancelled' : code === 'provenance-mismatch' ? 'policy-violation' : 'crashed'
    r.tracker.commitTerminalExperiment(experiment.experimentId, state, experimentFacts(evaluation, { failureCode: code, failureMessage: message }))
    if (experiment.kind === 'baseline') r.tracker.transitionRun(r.runId, evaluation.exit.processTreeQuiescent ? 'baseline-blocked' : 'blocked', { terminalReason: message, blockedCode: evaluation.exit.processTreeQuiescent ? code : 'attempt-uncertain', quiescent: evaluation.exit.processTreeQuiescent })
    else r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'candidate-evaluation-failed', code, message } })
  }

  private async reconcileCandidate(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'reconcile-candidate' }>): Promise<void> {
    const best = durableBest(r.tracker, r.runId)
    const experimentRow = r.tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get(directive.experiment.experimentId)
    const experimentTerminal = experimentRow && !['baseline-pending', 'running'].includes(String(experimentRow['state']))
    if (!experimentTerminal && directive.outcome.kind !== 'cleanup') r.tracker.checkpointExperiment(directive.experiment.experimentId, { decision: directive.outcome.kind })
    if (r.tracker.getRun(r.runId)?.['state'] === 'candidate-running') r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'terminal-experiment-recovered' } })
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'git-reconciliation', outcome: directive.outcome } })
    if (directive.outcome.kind === 'accept') {
      await reconcileAcceptedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, directive.candidateCommit, { ...r.gitOptions, signal: this.aborter.signal })
      const next = { metric: directive.outcome.metric, commit: directive.candidateCommit, experimentId: directive.experiment.experimentId }
      if (!experimentTerminal) r.tracker.commitTerminalExperiment(directive.experiment.experimentId, 'accepted', { metric: next.metric, decision: 'accept' })
      const target = r.policy.target !== undefined && isTargetReached(r.policy.metricDirection, next.metric, r.policy.target)
      r.tracker.transitionRun(r.runId, target ? 'completed' : 'ready', { best: next, outcome: { kind: 'reconciled', decision: 'accept' } })
    } else {
      await reconcileRejectedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, directive.candidateCommit, directive.expectedAcceptedCommit, { ...r.gitOptions, signal: this.aborter.signal })
      if (!experimentTerminal && directive.outcome.kind === 'reject') r.tracker.commitTerminalExperiment(directive.experiment.experimentId, 'rejected', { metric: directive.outcome.metric, decision: 'reject' })
      r.tracker.transitionRun(r.runId, directive.outcome.kind === 'cleanup' ? 'round-failed' : 'ready', { best, outcome: { kind: 'reconciled', decision: directive.outcome.kind } })
    }
  }

  private async complete(r: Runtime, status: 'target-reached' | 'budget-limited', best: BestResult): Promise<AutoresearchRunResult> {
    if (r.tracker.getRun(r.runId)?.['state'] !== 'completed') r.tracker.transitionRun(r.runId, 'completed', { best, terminalReason: status, quiescent: true })
    return this.finish(r, { status, ...(status === 'target-reached' ? { target: r.policy.target! } : {}), best })
  }

  private async block(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'blocked' }>): Promise<AutoresearchRunResult> {
    const best = optionalBest(r.tracker, r.runId)
    const row = r.tracker.getRun(r.runId)!
    if (!['completed','baseline-blocked','blocked','round-failed','cancelled'].includes(String(row['state']))) {
      const unresolved = r.tracker.recoveryState(r.runId).unresolvedExperiment
      if (unresolved) {
        const id = String(unresolved['experiment_id']); const state = String(unresolved['state'])
        if (state === 'baseline-pending') r.tracker.commitTerminalExperiment(id, 'cancelled', { failureCode: directive.code, failureMessage: directive.evidence[0]?.message ?? directive.code })
        else if (state === 'running') r.tracker.commitTerminalExperiment(id, 'crashed', { failureCode: directive.code, failureMessage: directive.evidence[0]?.message ?? directive.code })
      }
      r.tracker.transitionRun(r.runId, 'blocked', { blockedCode: directive.code, terminalReason: directive.evidence[0]?.message ?? directive.code, quiescent: false, ...(best ? { best } : {}) })
    }
    const result = best ? { status: 'blocked', best, evidence: directive.evidence } : { status: 'round-failed', reason: directive.evidence[0]?.message ?? directive.code, evidence: directive.evidence }
    return this.finish(r, result, directive.lock === 'release-after-persist' && r.tracker.recoveryState(r.runId).safeToReleaseTerminalLock)
  }

  private async cancelled(r: Runtime): Promise<AutoresearchRunResult> {
    const row = r.tracker.getRun(r.runId)
    if (this.quiescenceFailure) return this.block(r, { kind: 'blocked', runId: r.runId, code: 'attempt-uncertain', evidence: [{ code: this.quiescenceFailure.code, message: this.quiescenceFailure.message, artifacts: [] }], lock: 'retain' })
    if (!row) throw new Error(this.cancelReason)
    const lastState = String(row['state']) as RunDurableState
    if (['completed','baseline-blocked','blocked','round-failed','cancelled'].includes(lastState)) return this.returnTerminal(r, { kind: 'terminal', runId: r.runId, state: lastState as never, lock: 'release' })
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'cancellation', reason: this.cancelReason } })
    const unresolved = r.tracker.recoveryState(r.runId).unresolvedExperiment
    const best = optionalBest(r.tracker, r.runId)
    if (unresolved && ['baseline-pending','running'].includes(String(unresolved['state']))) r.tracker.commitTerminalExperiment(String(unresolved['experiment_id']), 'cancelled', { failureCode: 'cancelled', failureMessage: this.cancelReason })
    if (best) await restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, best.commit, r.gitOptions)
    r.tracker.transitionRun(r.runId, 'cancelled', { terminalReason: this.cancelReason, quiescent: true, ...(best ? { best } : {}) })
    return this.finish(r, { status: 'cancelled', lastState, reason: this.cancelReason, quiescent: true, ...(best ? { best } : {}) })
  }

  private async returnTerminal(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'terminal' }>): Promise<AutoresearchRunResult> {
    const row = r.tracker.getRun(r.runId)!
    const facts = common(r)
    const best = optionalBest(r.tracker, r.runId)
    let value: Record<string, unknown>
    if (directive.state === 'completed') value = { ...facts, status: r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? 'target-reached' : 'budget-limited', ...(r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? { target: r.policy.target } : {}), best }
    else if (directive.state === 'baseline-blocked') value = baselineBlocked(r)
    else if (directive.state === 'cancelled') value = { ...facts, status: 'cancelled', lastState: 'initializing', reason: String(row['terminal_reason'] ?? 'cancelled'), quiescent: true, ...(best ? { best } : {}) }
    else if (directive.state === 'blocked' && best) value = { ...facts, status: 'blocked', best, evidence: evidenceFromRun(row) }
    else value = { ...facts, status: 'round-failed', reason: String(row['terminal_reason'] ?? directive.state), evidence: evidenceFromRun(row), ...(best ? { best } : {}) }
    return this.finish(r, value, directive.lock !== 'retain')
  }

  private async finish(r: Runtime, specific: Record<string, unknown>, release = true): Promise<AutoresearchRunResult> {
    const value = { ...common(r), ...specific }
    const safeRelease = release && r.tracker.recoveryState(r.runId).safeToReleaseTerminalLock
    if (this.options.config.exportTsv) r.tracker.exportTsv(r.runId, r.tracker.layout.resolve(join('exports', `${r.runId}.tsv`)))
    if (safeRelease && this.options.config.cleanupWorktreesOnSuccess && !this.options.config.retainWorktrees) await removeRunWorktree(this.ctx, r.gitExecutable, r.discovery, r.identity, r.gitOptions)
    if (safeRelease) releaseTerminalRunLock(r.tracker, r.runId)
    return decodeRunResult(value, r.policy.metricDirection, this.options.config.maxResultChars)
  }
}

function provenanceInput(policy: NormalizedRunPolicy, policySha256: string, evaluationSha256: string) { return { evaluation: policy.evaluation, metricName: policy.metricName, metricDirection: policy.metricDirection, environment: policy.environment, policy: { normalizedPolicySha256: policySha256, evaluationSha256, policy }, ...(policy.provenance.dataset ? { dataset: { dataset: policy.provenance.dataset } } : {}) } }
function canonicalPolicy(policy: NormalizedRunPolicy): NormalizedRunPolicy { const { resumeRunId: _resume, ...durable } = policy; return durable as NormalizedRunPolicy }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex') }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, sort(v)])); return value }
function normalizedReason(value: string): string { const text = value.trim().replace(/[\0\r\n]+/gu, ' '); return text || 'cancelled' }
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return undefined; try { return JSON.parse(value) } catch { return undefined } }
function artifact(r: Runtime, experimentId: string, attemptId: string, item: { kind: string; location: string; sizeBytes: number; sha256: string; truncated: boolean }): ArtifactRecord { return { artifactId: `${attemptId}-${item.kind}`, runId: r.runId, experimentId, attemptId, kind: item.kind, location: item.location, sizeBytes: item.sizeBytes, sha256: item.sha256, owner: 'evaluator', retention: 'retain', metadata: { truncated: item.truncated } } }
function experimentFacts(evaluation: RecoveredEvaluation, extra: Record<string, unknown>) { return { ...extra, exitCode: evaluation.exit.exitCode, signal: evaluation.exit.signal, timedOut: evaluation.exit.timedOut } as never }
function optionalBest(tracker: DurableTracker, runId: string): BestResult | undefined { const row = tracker.getRun(runId); return row?.['best_metric'] === null || row?.['best_metric'] === undefined ? undefined : { metric: Number(row['best_metric']), commit: String(row['best_commit']), experimentId: String(row['best_experiment_id']) } }
function durableBest(tracker: DurableTracker, runId: string): BestResult { const best = optionalBest(tracker, runId); if (!best) throw new Error('durable best result is missing'); return best }
function history(tracker: DurableTracker, runId: string): ProposalHistoryEntry[] { return (tracker.database.prepare('SELECT * FROM experiments WHERE run_id = ? AND kind = ? ORDER BY ordinal DESC LIMIT 20').all(runId, 'candidate') as Record<string, unknown>[]).reverse().map(row => ({ ordinal: Number(row['ordinal']), experimentId: String(row['experiment_id']), state: String(row['state']) as ExperimentDurableState, ...(row['candidate_commit'] ? { candidateCommit: String(row['candidate_commit']) } : {}), ...(row['metric'] === null ? {} : { metric: Number(row['metric']) }), ...(row['decision'] ? { decision: String(row['decision']) as 'accept'|'reject' } : {}), ...(row['failure_code'] ? { failureCode: String(row['failure_code']) } : {}) })) }
function counts(tracker: DurableTracker, runId: string): ResultCounts { const candidates = Number(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE run_id = ? AND kind = 'candidate'").get(runId)?.['n'] ?? 0); const completed = Number(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE run_id = ? AND kind = 'candidate' AND state NOT IN ('baseline-pending','running')").get(runId)?.['n'] ?? 0); const attempts = Number(tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?').get(runId)?.['n'] ?? 0); return { experimentsStarted: candidates, experimentsCompleted: completed, attempts } }
function artifacts(tracker: DurableTracker, runId: string) { return (tracker.database.prepare('SELECT artifact_id, kind, location, size_bytes, sha256 FROM artifacts WHERE run_id = ? ORDER BY created_at, artifact_id').all(runId) as Record<string, unknown>[]).map(row => ({ artifactId: String(row['artifact_id']), kind: String(row['kind']), location: String(row['location']), sizeBytes: Number(row['size_bytes']), sha256: String(row['sha256']) })) }
function common(r: Runtime) { return { runId: r.runId, tracker: r.tracker.path, counts: counts(r.tracker, r.runId), artifacts: artifacts(r.tracker, r.runId) } }
function errorEvidence(error: unknown): { code: string; message: string } { return { code: error instanceof ProposalAgentError ? error.code : String((error as { code?: unknown }).code ?? 'round-failed'), message: error instanceof Error ? error.message : String(error) } }
function evidenceFromRun(row: Record<string, unknown>): BlockerEvidence[] { return [{ code: String(row['blocked_code'] ?? 'terminal'), message: String(row['terminal_reason'] ?? 'run terminated'), artifacts: [] }] }
function baselineBlocked(r: Runtime): Record<string, unknown> { const attempt = r.tracker.database.prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at LIMIT 1").get(r.runId)!; const refs = artifacts(r.tracker, r.runId); return { ...common(r), status: 'baseline-blocked', baselineAttemptId: String(attempt['attempt_id']), reason: String(attempt['failure_message'] ?? 'baseline evaluation failed'), exit: { exitCode: attempt['exit_code'] === null ? null : Number(attempt['exit_code']), signal: attempt['signal'] === null ? null : String(attempt['signal']), timedOut: attempt['timed_out'] === 1, stdout: refs.find(item => item.kind === 'stdout')!, stderr: refs.find(item => item.kind === 'stderr')! } }
}
