import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { requestProposal, ProposalAgentError, type ProposalHistoryEntry } from './agent.js'
import { normalizeRunPolicy, type HostEvaluatorRegistration, type ResolvedConfig } from './config.js'
import { createEvaluatorArtifactWriterFactory, redactConfiguredSecrets } from './evaluator-artifacts.js'
import { captureFrozenFileAttempt, createEvaluatorBoundary, evaluatorEvaluationSha256, freezeEvaluatorProvenanceFromManifest, FrozenEvaluatorBoundaryError, recomputeRegistrationManifest, revalidateEvaluatorBoundary, revalidateFrozenFileAttempt, runEvaluator, type FrozenEvaluatorProvenance } from './evaluator.js'
import {
  acquireControllerClaim, acquireRunLock, assertWithinOriginalWorkspace, resolveOriginalWorkspaceAuthority, allocateRunWorktree, canonicalizeRepositoryTarget, checkoutCandidateForEvaluation, commitCandidate, currentControllerProcessIdentity, deriveRegistrationManifestAtStartCommit, discoverContainedRepository, durableGitIdentity, RepositoryContainmentError,
  GitBoundaryError, heartbeatControllerClaim, restoreAcceptedAfterCandidateCommit, makeRunGitIdentity, reconcileAcceptedHead, reconcileRejectedHead, recoverTerminalRunLock, recoverTerminalRunLockUnderControllerClaim, releaseControllerClaim, rollbackRunActivationAuthority,
  removeRunWorktree, resolveGitExecutable, restoreAcceptedWorktree, runGit, snapshotCandidate, validateCandidate, validateFrozenCandidatePaths,
  verifyExactWorktree, type CandidateSnapshot, type ControllerProcessIdentity, type GitCommandOptions, type GitConfigBaseline,
  type RepositoryDiscovery, type RunGitIdentity,
} from './git.js'
import { CANDIDATE_REJECTION_INTENT, classifyDurableRegistration, reconcileRecovery, type RecoveredEvaluation, type RecoveredExperiment, type RecoveryDirective } from './recovery.js'
import { DurableTracker, TRACKER_SCHEMA_VERSION, serializeDurablePolicy, serializeRedactedDurablePolicy, type ArtifactRecord, type HostFailureFacts } from './tracker.js'
import { applyRunRetention, sweepRepositoryRetention } from './retention.js'
import { StateLayout } from './state-layout.js'
import {
  decodeRunResult, durableRunId, isTargetReached, registrationFingerprint, type ActivationAutoresearchToolInput, type AutoresearchRunResult,
  type BestResult, type BlockerEvidence, type DurableRegistrationIdentity, type DurableRunPolicy, type ExperimentDurableState,
  type NormalizedRunPolicy, type ResultCounts, type RunDurableState, type RunId,
} from './types.js'

export interface AutoresearchRunReady { readonly runId: RunId; readonly tracker: string; readonly branch: string; readonly worktree: string }
export interface AcceptedRepositoryPreflight { readonly discovery: RepositoryDiscovery; readonly gitExecutable: string; readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'> }
export interface AutoresearchRunControllerOptions { readonly config: ResolvedConfig; readonly input: ActivationAutoresearchToolInput; readonly parent: Agent; readonly signal: AbortSignal; readonly repositoryPreflight?: AcceptedRepositoryPreflight; readonly jobId?: string }

interface Runtime {
  readonly runId: string; readonly policy: DurableRunPolicy; readonly discovery: RepositoryDiscovery
  readonly identity: RunGitIdentity; readonly tracker: DurableTracker; readonly gitExecutable: string
  readonly policySha256: string; readonly provenanceSha256: string; readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>
  readonly claimOwner?: string; readonly claimProcess?: ControllerProcessIdentity
  readonly registration?: DurableRegistrationIdentity; readonly legacy?: 'terminal' | 'nonterminal'; readonly readonlyTerminal?: true; readonly preclaimBlock?: { code: string; message: string }
}
const CONTROLLER_LEASE_MS = 30_000
export function validateAutoresearchRequest(config: ResolvedConfig, input: ActivationAutoresearchToolInput): HostEvaluatorRegistration | undefined {
  if ('resume_run_id' in input) {
    durableRunId(input.resume_run_id)
    return undefined
  }
  return config.evaluatorRegistry.resolve(input.evaluator_id)
}

function trackerPathForRun(discovery: RepositoryDiscovery, stateRoot: string, runId: string, existing: boolean): string {
  durableRunId(runId, 'runId')
  const state = existing ? StateLayout.inspect(join(discovery.gitCommonDir, stateRoot)) : StateLayout.open(join(discovery.gitCommonDir, stateRoot))
  const runs = existing ? state.inspectDirectory('runs') : state.openDirectory('runs')
  const run = existing ? runs.inspectDirectory(runId) : runs.openDirectory(runId)
  return existing ? run.inspectFile('tracker.sqlite') : run.resolve('tracker.sqlite')
}

/** Structural view of `@deepseek-ai/dsh-working-directory`'s service; the immutable Session header keeps only the original project. */
interface EffectiveWorkingDirectory { ensure(agent: Agent, signal?: AbortSignal): Promise<string> }

/**
 * Resolve the calling Agent's effective directory: the working-directory service when the Host mounts it
 * (tracking `cd`-style changes and missing-directory recovery), otherwise the Session's original `cwd` when the Host
 * composes no such service. A registered but inactive service (for example during HMR) fails closed rather than
 * silently resolving targets against a directory the agent has left.
 */
export async function resolveCallerCwd(ctx: Context, parent: Agent, signal: AbortSignal): Promise<string> {
  const workingDirectory = ctx.get('workingDirectory') as EffectiveWorkingDirectory | undefined
  if (workingDirectory !== undefined) return workingDirectory.ensure(parent, signal)
  if (ctx.get('workingDirectory', false) !== undefined) throw new Error('The working-directory service is not active; retry autoresearch after it reloads')
  return String(parent.session.header.cwd)
}

/**
 * The effective directory selects the default and relative repository target. Because the model can change it without
 * approval, a changed directory is authorized only inside the immutable original workspace, and the effective directory
 * and target are checked against it before discovery. Inside an original repository, discovery is anchored at the
 * canonical original directory and must find that same repository, so nested repositories, `.git` files and linked worktrees are rejected exactly as an explicit target would be.
 * Inside an original non-repository directory, the discovered repository root and Git common dir must stay inside it.
 */
export async function preflightAutoresearchRepository(ctx: Context, options: Pick<AutoresearchRunControllerOptions, 'config' | 'input' | 'parent' | 'signal'>): Promise<AcceptedRepositoryPreflight> {
  const originalCwd = String(options.parent.session.header.cwd)
  // An explicit absolute target selects itself, so the effective directory has no authority over it: anchor at the original directory.
  const callerCwd = typeof options.input.repository === 'string' && isAbsolute(options.input.repository) ? originalCwd : await resolveCallerCwd(ctx, options.parent, options.signal)
  const timeoutMs = options.input.timeout_ms ?? options.config.defaultTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > options.config.maxTimeoutMs) throw new TypeError('timeout_ms exceeds deployment maximum')
  const gitOptions = { timeoutMs: options.config.gitTimeoutMs, graceMs: options.config.terminationGraceMs, maxStdoutBytes: options.config.gitMaxStdoutBytes, maxStderrBytes: options.config.gitMaxStderrBytes }
  const commandOptions = { ...gitOptions, signal: options.signal }
  const requestedTarget = await canonicalizeRepositoryTarget(callerCwd, options.input.repository)
  const gitExecutable = await resolveGitExecutable(ctx, options.config.gitExecutable, options.signal)
  const changed = callerCwd !== originalCwd && requestedTarget.parentCwd !== await realpath(originalCwd).catch(() => undefined)
  const authority = changed ? await resolveOriginalWorkspaceAuthority(ctx, gitExecutable, originalCwd, commandOptions) : undefined
  if (authority !== undefined) assertWithinOriginalWorkspace(authority.root, requestedTarget.parentCwd, requestedTarget.requestedPath)
  const discovery = await discoverContainedRepository(ctx, gitExecutable, authority?.repository === true ? { ...requestedTarget, parentCwd: authority.anchor } : requestedTarget, commandOptions)
  if (authority?.repository === true && discovery.repository !== authority.root) throw new RepositoryContainmentError('repository-target-outside-parent', 'Repository discovered from the Session original workspace differs from its authority', [discovery.repository, authority.root])
  if (authority !== undefined && !authority.repository) assertWithinOriginalWorkspace(authority.root, discovery.repository, discovery.gitCommonDir)
  return { discovery, gitExecutable, gitOptions }
}

const CONTROLLER_HEARTBEAT_MS = 5_000


/** Sole owner of one repository/worktree/evaluator state machine. Construction has no external effects. */
export class AutoresearchRunController {
  readonly ready: Promise<AutoresearchRunReady>
  private resolveReady!: (value: AutoresearchRunReady) => void
  private rejectReady!: (reason: unknown) => void
  private readonly aborter = new AbortController()
  private runPromise?: Promise<AutoresearchRunResult>
  private preparePromise?: Promise<Runtime>
  private disposePromise?: Promise<void>
  private cancelReason = 'cancelled'
  private jobId?: string
  private readySettled = false
  private runtime: Runtime | undefined
  private cancellationRequested = false
  private disposed = false
  private cancellationPersisted = false
  private quiescenceFailure?: ProposalAgentError
  /** A quiescent proposal failure whose accepted-HEAD restoration failed: failure recovery finishes drive()'s round-failed verdict. */
  private claimHeartbeat: NodeJS.Timeout | undefined
  private claimFailure?: unknown
  /** Aborted on claim loss: failure-recovery Git runs on it instead of the (already settled) run aborter. */
  private failureCleanup?: AbortController


  constructor(private readonly ctx: Context, private readonly options: AutoresearchRunControllerOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => undefined)
    const abort = () => this.cancel(String(options.signal.reason ?? 'cancelled'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  }

  setJobId(jobId: string): void { if (this.preparePromise || this.runPromise) throw new Error('job id must be assigned before controller preparation'); if (this.jobId !== undefined) throw new Error('job id is already assigned'); this.jobId = normalizedReason(jobId) }
  /** Test-only seam after writable identity revalidation and controller claim, before terminal evidence recheck. */
  terminalResumeClaimAcquiredForTest(): void {}
  /** Test-only seam: returning false models a process crash, which cannot run in-process terminal failure persistence. */
  unexpectedFailurePersistenceForTest(_error: unknown): boolean { return true }
  prepare(jobId?: string): Promise<AutoresearchRunReady> {
    if (jobId !== undefined) {
      if (this.jobId === undefined) this.jobId = normalizedReason(jobId)
      else if (this.jobId !== normalizedReason(jobId)) throw new Error('job id is already assigned')
    }
    return this.prepareRuntime().then(runtime => ({ runId: runtime.runId, tracker: runtime.tracker.path, branch: runtime.identity.branch, worktree: runtime.identity.worktree }))
  }
  run(): Promise<AutoresearchRunResult> { return this.runPromise ??= this.execute() }

  cancel(reason = 'cancelled'): void {
    if (!this.cancellationRequested) {
      this.cancellationRequested = true
      this.cancelReason = normalizedReason(reason)
    }
    this.persistCancellationIntent()
    if (!this.aborter.signal.aborted) this.aborter.abort(new Error(this.cancelReason))
  }
  dispose(): Promise<void> {
    return this.disposePromise ??= this.disposeOnce()
  }

  private async disposeOnce(): Promise<void> {
    this.cancel('controller disposed')
    this.disposed = true
    if (!this.readySettled) { this.readySettled = true; this.rejectReady(new Error('controller disposed before start')) }
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined)
      return
    }
    if (this.preparePromise) await this.preparePromise.catch(() => undefined)
    const runtime = this.runtime
    if (runtime) this.releaseRuntime(runtime)
  }

  private prepareRuntime(): Promise<Runtime> {
    return this.preparePromise ??= this.initialize().then(runtime => {
      this.runtime = runtime
      if (this.disposed) {
        this.releaseRuntime(runtime)
        throw new Error('controller disposed before start')
      }
      if (this.cancellationRequested) {
        this.persistCancellationIntent()
        if (!this.aborter.signal.aborted) this.aborter.abort(new Error(this.cancelReason))
      }
      return runtime
    })
  }

  private async execute(): Promise<AutoresearchRunResult> {
    let runtime: Runtime | undefined
    try {
      runtime = await this.prepareRuntime()
      // Readiness is published by drive() only after durable branch/worktree allocation.
      return await this.drive(runtime)
    } catch (error) {
      if (!this.readySettled) { this.readySettled = true; this.rejectReady(error) }
      if (this.claimFailure) throw this.claimFailure
      if (runtime && this.aborter.signal.aborted) return await this.cancelled(runtime)
      if (runtime && error instanceof RejectedReconciliationBlockedError) {
        const best = durableBest(runtime.tracker, runtime.runId)
        return decodeRunResult({ ...common(runtime), status: 'blocked', best, evidence: error.evidence.map(message => ({ code: error.code, message, artifacts: [] })) }, runtime.policy.metricDirection)
      }
      if (runtime && runtime.claimOwner && runtime.claimProcess && !runtime.legacy && !runtime.readonlyTerminal && !runtime.preclaimBlock) return await this.failUnexpectedly(runtime, error)
      throw error
    } finally {
      if (runtime) this.releaseClaim(runtime)
      runtime?.tracker.close()
      if (this.runtime === runtime) this.runtime = undefined
    }
  }

  private async initialize(): Promise<Runtime> {
    let tracker: DurableTracker | undefined
    let claimed: { runId: string; ownerId: string } | undefined
    let allocated: { discovery: RepositoryDiscovery; identity: RunGitIdentity; gitExecutable: string; gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'> } | undefined
    let registeredRunPendingActivation: string | undefined
    try {
      const resumeRunId = 'resume_run_id' in this.options.input ? this.options.input.resume_run_id : undefined
      const isResume = resumeRunId !== undefined
      const selected = validateAutoresearchRequest(this.options.config, this.options.input)
      const repositoryPreflight = this.options.repositoryPreflight ?? await preflightAutoresearchRepository(this.ctx, {
        config: this.options.config,
        input: this.options.input,
        parent: this.options.parent,
        signal: this.aborter.signal,
      })
      const { gitExecutable, gitOptions } = repositoryPreflight
      let discovery = repositoryPreflight.discovery
      const runId = resumeRunId ?? randomUUID()
      if (!isResume) sweepRepositoryRetention(discovery.gitCommonDir, this.options.config.stateRoot, this.options.config, runId)
      const trackerPath = trackerPathForRun(discovery, this.options.config.stateRoot, runId, isResume)
      if (isResume) {
        const preflight = DurableTracker.openReadOnly(trackerPath)
        let preflightAccepted = false
        try {
          const existing = preflight.getRun(runId)
          if (!existing) throw new Error(`resume run ${runId} has no durable tracker row`)
          const state = String(existing['state']) as RunDurableState
          const durablePolicy = decodeDurablePolicy(existing['policy_json'])
          const durableStartCommit = String(existing['start_commit'])
          const resumeDiscovery = { ...discovery, startCommit: durableStartCommit }
          const identity = makeRunGitIdentity(this.options.config, resumeDiscovery, String(existing['run_tag']), runId)
          const terminal = isTerminalState(state)
          const policySha256 = String(existing['policy_sha256'])
          const provenanceSha256 = String(existing['provenance_sha256'])
          const classification = classifyDurableRegistration(preflight, runId)
          if (classification.kind === 'legacy') {
            tracker = preflight
            if (!terminal) return { runId, policy: durablePolicy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256, provenanceSha256, gitOptions, legacy: 'nonterminal' }
            const identityBlock = validateReadOnlyResumeIdentity(existing, discovery, identity, durablePolicy, policySha256, undefined, true)
            if (identityBlock) return { runId, policy: durablePolicy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256, provenanceSha256, gitOptions, preclaimBlock: identityBlock }
            return { runId, policy: durablePolicy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256, provenanceSha256, gitOptions, legacy: 'terminal' }
          }
          if (classification.kind === 'blocked') {
            tracker = preflight
            return registrationBlockedRuntime(tracker, runId, durablePolicy, resumeDiscovery, identity, gitExecutable, gitOptions, classification.evidence.code, classification.evidence.message)
          }
          let current: HostEvaluatorRegistration
          try {
            current = this.options.config.evaluatorRegistry.resolve(classification.identity.evaluatorId)
            if (registrationFingerprint(current, classification.identity.manifest) !== classification.identity.registrationFingerprint) throw new TypeError('evaluator registration differs from the immutable durable registration')
          } catch (error) {
            tracker = preflight
            const message = error instanceof Error ? error.message : `evaluator registration ${classification.identity.evaluatorId} is unavailable`
            return registrationBlockedRuntime(tracker, runId, durablePolicy, resumeDiscovery, identity, gitExecutable, gitOptions, 'evaluator-registration-mismatch', message)
          }
          let policy = durablePolicy
          let acceptedPolicySha256 = policySha256
          let expectedProvenance: FrozenEvaluatorProvenance | undefined
          if (!terminal) {
            policy = canonicalPolicy(normalizeRunPolicy(this.options.input, this.options.config, resumeDiscovery.callerCwd, current), resumeDiscovery.repository, String(existing['run_tag']))
            acceptedPolicySha256 = hash(policy)
            try {
              expectedProvenance = freezeEvaluatorProvenanceFromManifest(provenanceInput(policy, acceptedPolicySha256, evaluatorEvaluationSha256(policy.evaluation), current), classification.identity.manifest)
            } catch (error) {
              if (!(error instanceof FrozenEvaluatorBoundaryError)) throw error
              tracker = preflight
              return { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: classification.identity, preclaimBlock: { code: 'provenance-mismatch', message: error.message } }
            }
          }
          const identityBlock = validateReadOnlyResumeIdentity(existing, discovery, identity, policy, acceptedPolicySha256, expectedProvenance, terminal)
          if (identityBlock) {
            tracker = preflight
            return { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: classification.identity, preclaimBlock: identityBlock }
          }
          if (terminal) {
            const terminalPreflight = await reconcileRecovery(this.ctx, { runId, policy, discovery: resumeDiscovery, identity, tracker: preflight, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: classification.identity, signal: this.aborter.signal })
            if (terminalPreflight.kind === 'blocked') {
              tracker = preflight
              return { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: classification.identity, preclaimBlock: { code: terminalPreflight.code, message: terminalPreflight.evidence[0]?.message ?? 'terminal evidence is invalid' } }
            }
            if (terminalPreflight.kind !== 'terminal') {
              tracker = preflight
              return { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: classification.identity, preclaimBlock: { code: 'state-ambiguous', message: `terminal preflight returned ${terminalPreflight.kind}` } }
            }
          }
          const acceptedTerminalEvidence = terminal ? captureTerminalResumeEvidence(preflight, runId) : undefined
          const acceptedIdentity = captureAcceptedResumeIdentity(preflight, runId)
          preflight.close()
          preflightAccepted = true
          tracker = DurableTracker.open(trackerPath)
          revalidateAcceptedResumeIdentity(tracker, runId, acceptedIdentity)
          const writableRegistration = classifyDurableRegistration(tracker, runId)
          if (writableRegistration.kind !== 'registered' || writableRegistration.identity.registrationFingerprint !== classification.identity.registrationFingerprint) throw new Error('durable evaluator registration changed between read-only classification and writable open')
          const writableRow = tracker.getRun(runId)
          if (!writableRow) throw new Error(`resume run ${runId} has no durable tracker row after writable open`)
          if (terminal) {
            const claimOwner = randomUUID(); const claimProcess = currentControllerProcessIdentity()
            try {
              acquireControllerClaim(tracker, runId, claimOwner, CONTROLLER_LEASE_MS, new Date(), claimProcess)
            } catch (error) {
              if (!(error instanceof GitBoundaryError) || error.code !== 'run-controller-active') throw error
              tracker.close()
              tracker = DurableTracker.openReadOnly(trackerPath)
              const runtime = { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: writableRegistration.identity, readonlyTerminal: true as const }
              this.runtime = runtime; tracker = undefined
              return runtime
            }
            claimed = { runId, ownerId: claimOwner }
            this.terminalResumeClaimAcquiredForTest()
            const terminalEvidenceChanged = acceptedTerminalEvidence !== captureTerminalResumeEvidence(tracker, runId)
            if (terminalEvidenceChanged) {
              const runtime = { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, claimOwner, claimProcess, registration: writableRegistration.identity, preclaimBlock: { code: 'state-ambiguous', message: 'terminal run, transition, attempt, experiment, artifact, or cancellation-origin evidence changed after preflight' } }
              this.runtime = runtime; tracker = undefined
              return runtime
            }
            tracker.resumeOwnedArtifactDiscards(runId)
            const terminalFinal = await reconcileRecovery(this.ctx, { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, registration: writableRegistration.identity, signal: this.aborter.signal })
            if (terminalFinal.kind !== 'terminal') {
              const preclaimBlock = terminalFinal.kind === 'blocked'
                ? { code: terminalFinal.code, message: terminalFinal.evidence[0]?.message ?? 'terminal evidence is invalid after artifact discard recovery' }
                : { code: 'state-ambiguous', message: `terminal reconciliation after artifact discard recovery returned ${terminalFinal.kind}` }
              const runtime = { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, claimOwner, claimProcess, registration: writableRegistration.identity, preclaimBlock }
              this.runtime = runtime; tracker = undefined
              return runtime
            }
            recoverTerminalRunLockUnderControllerClaim(tracker, runId, claimOwner, claimProcess)
            applyRunRetention(tracker, runId, this.options.config)
            sweepRepositoryRetention(resumeDiscovery.gitCommonDir, this.options.config.stateRoot, this.options.config, runId)

            const runtime = { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, claimOwner, claimProcess, registration: writableRegistration.identity }
            this.startClaimHeartbeat(runtime); this.runtime = runtime; tracker = undefined
            return runtime
          }
          const claimOwner = randomUUID(); const claimProcess = currentControllerProcessIdentity()
          acquireControllerClaim(tracker, runId, claimOwner, CONTROLLER_LEASE_MS, new Date(), claimProcess); claimed = { runId, ownerId: claimOwner }
          tracker.resumeOwnedArtifactDiscards(runId)
          applyRunRetention(tracker, runId, this.options.config)
          sweepRepositoryRetention(resumeDiscovery.gitCommonDir, this.options.config.stateRoot, this.options.config, runId)
          const runtime = { runId, policy, discovery: resumeDiscovery, identity, tracker, gitExecutable, policySha256: acceptedPolicySha256, provenanceSha256, gitOptions, claimOwner, claimProcess, registration: writableRegistration.identity }
          this.startClaimHeartbeat(runtime); this.runtime = runtime; tracker = undefined
          return runtime
        } finally {
          if (!preflightAccepted && tracker !== preflight) preflight.close()
        }
      }
      tracker = DurableTracker.open(trackerPath)
      const registration = selected!
      const normalized = normalizeRunPolicy(this.options.input, this.options.config, discovery.callerCwd, registration)
      const runTag = normalized.runTag!
      const policy = canonicalPolicy(normalized, discovery.repository, runTag)
      const policySha256 = hash(policy)
      const identity = makeRunGitIdentity(this.options.config, discovery, runTag, runId)
      await allocateRunWorktree(this.ctx, gitExecutable, discovery, identity, { runId, repositoryId: discovery.repositoryId, startCommit: discovery.startCommit, branch: identity.branch, worktree: identity.worktree }, { ...gitOptions, signal: this.aborter.signal })
      allocated = { discovery, identity, gitExecutable, gitOptions }
      const manifest = await deriveRegistrationManifestAtStartCommit(this.ctx, gitExecutable, discovery, identity, registration, { ...gitOptions, signal: this.aborter.signal })
      const evaluationSha256 = evaluatorEvaluationSha256(policy.evaluation)
      const provenance = freezeEvaluatorProvenanceFromManifest(provenanceInput(policy, policySha256, evaluationSha256, registration), manifest)
      const registrationIdentity = tracker.createRegisteredRun({ runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag, branch: identity.branch, worktree: identity.worktree, agentId: String(this.options.parent.id), sessionId: String(this.options.parent.session.header.id), policy, policySha256, provenance, provenanceSha256: provenance.sha256, registration, manifest })
      registeredRunPendingActivation = runId
      if (this.jobId !== undefined) tracker.checkpointRun(runId, { outcome: { kind: 'background-job-registered', jobId: this.jobId } })
      acquireRunLock(tracker, identity, discovery.repositoryId, this.options.config.maxActiveRunsPerRepository)
      const claimOwner = randomUUID(); const claimProcess = currentControllerProcessIdentity()
      acquireControllerClaim(tracker, runId, claimOwner, CONTROLLER_LEASE_MS, new Date(), claimProcess); claimed = { runId, ownerId: claimOwner }
      registeredRunPendingActivation = undefined
      const runtime = { runId, policy, discovery, identity, tracker, gitExecutable, policySha256, provenanceSha256: provenance.sha256, gitOptions, claimOwner, claimProcess, registration: registrationIdentity }
      this.startClaimHeartbeat(runtime); this.runtime = runtime; tracker = undefined; allocated = undefined
      return runtime
    } catch (error) {
      const cleanupErrors: unknown[] = []
      const cleanup = (operation: () => void): void => { try { operation() } catch (cleanupError) { cleanupErrors.push(cleanupError) } }
      const cleanupAsync = async (operation: () => Promise<unknown>): Promise<void> => { try { await operation() } catch (cleanupError) { cleanupErrors.push(cleanupError) } }
      if (tracker && claimed) cleanup(() => { releaseControllerClaim(tracker!, claimed!.runId, claimed!.ownerId) })
      if (tracker && registeredRunPendingActivation) {
        cleanup(() => { rollbackRunActivationAuthority(tracker!, registeredRunPendingActivation!) })
        cleanup(() => { tracker!.rollbackRegisteredRunActivation(registeredRunPendingActivation!) })
      }
      if (tracker) cleanup(() => { tracker!.close() })
      if (allocated) {
        await cleanupAsync(() => removeRunWorktree(this.ctx, allocated!.gitExecutable, allocated!.discovery, allocated!.identity, allocated!.gitOptions))
        await cleanupAsync(() => runGit(this.ctx, allocated!.gitExecutable, ['update-ref', '-d', allocated!.identity.acceptedRef], { ...allocated!.gitOptions, cwd: allocated!.discovery.repository }))
        await cleanupAsync(() => runGit(this.ctx, allocated!.gitExecutable, ['branch', '-D', allocated!.identity.branch], { ...allocated!.gitOptions, cwd: allocated!.discovery.repository }))
      }
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `autoresearch activation failed and ${cleanupErrors.length} cleanup phase(s) also failed`, { cause: error })
      throw error
    }
  }
  private startClaimHeartbeat(runtime: Runtime): void {
    if (!runtime.claimOwner || !runtime.claimProcess) return
    this.claimHeartbeat = setInterval(() => {
      try { heartbeatControllerClaim(runtime.tracker, runtime.runId, runtime.claimOwner!, CONTROLLER_LEASE_MS, new Date(), runtime.claimProcess!) }
      catch (error) { this.recordClaimFailure(error) }
    }, CONTROLLER_HEARTBEAT_MS)
    this.claimHeartbeat.unref()
  }
  private recordClaimFailure(error: unknown): void {
    this.claimFailure ??= error
    if (!this.aborter.signal.aborted) this.aborter.abort(error)
    // Failure recovery deliberately ignores the run aborter, but must stop mutating a worktree another controller may own.
    if (this.failureCleanup && !this.failureCleanup.signal.aborted) this.failureCleanup.abort(error)
  }
  private assertClaim(runtime: Runtime): void {
    if (!runtime.claimOwner || !runtime.claimProcess) return
    if (this.claimFailure) throw this.claimFailure
    // A synchronously detected claim loss is recorded like a heartbeat loss, so no failure path treats it as an owned failure.
    try { heartbeatControllerClaim(runtime.tracker, runtime.runId, runtime.claimOwner, CONTROLLER_LEASE_MS, new Date(), runtime.claimProcess) }
    catch (error) { this.recordClaimFailure(error); throw error }
  }
  private releaseClaim(runtime: Runtime): void {
    if (this.claimHeartbeat) { clearInterval(this.claimHeartbeat); this.claimHeartbeat = undefined }
    if (runtime.claimOwner && runtime.claimProcess) releaseControllerClaim(runtime.tracker, runtime.runId, runtime.claimOwner, runtime.claimProcess)
  }
  private releaseRuntime(runtime: Runtime): void {
    if (this.runtime !== runtime) return
    this.releaseClaim(runtime)
    runtime.tracker.close()
    this.runtime = undefined
  }

  private persistCancellationIntent(): void {
    const runtime = this.runtime
    if (!runtime || this.cancellationPersisted) return
    const state = String(runtime.tracker.getRun(runtime.runId)?.['state'] ?? '')
    if (['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(state)) return
    runtime.tracker.checkpointRun(runtime.runId, { intent: { kind: 'cancellation', reason: this.cancelReason } })
    this.cancellationPersisted = true
  }
  private async drive(runtime: Runtime): Promise<AutoresearchRunResult> {
    if (runtime.legacy || runtime.readonlyTerminal || runtime.preclaimBlock) {
      if (!this.readySettled) { this.readySettled = true; this.resolveReady({ runId: runtime.runId, tracker: runtime.tracker.path, branch: runtime.identity.branch, worktree: runtime.identity.worktree }) }
      if (runtime.legacy === 'nonterminal') return readonlyBlockedResult(runtime, 'legacy-evaluator-policy-unsupported', 'legacy nonterminal runs cannot be resumed under the Host evaluator contract')
      if (runtime.preclaimBlock) return readonlyBlockedResult(runtime, runtime.preclaimBlock.code, runtime.preclaimBlock.message)
      const directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal })
      if (directive.kind === 'blocked') return readonlyBlockedResult(runtime, directive.code, directive.evidence[0]?.message ?? 'legacy terminal evidence is invalid')
      if (directive.kind !== 'terminal') throw new Error(`legacy terminal replay validation returned ${directive.kind}`)
      return readonlyTerminalReplay(runtime, directive)
    }
    this.assertClaim(runtime)
    let directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal })
    while (true) {
      this.assertClaim(runtime)
      if (directive.kind !== 'initialize' && !this.readySettled) {
        this.readySettled = true
        this.resolveReady({ runId: runtime.runId, tracker: runtime.tracker.path, branch: runtime.identity.branch, worktree: runtime.identity.worktree })
      }
      if (this.aborter.signal.aborted) return this.cancelled(runtime)
      if (directive.kind === 'initialize') { await this.allocateAndStartBaseline(runtime, directive.reuseLock); this.assertClaim(runtime); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'evaluate') {
        if (directive.rerun && directive.attemptOrdinal > 2) this.exhaustEvaluationRerun(runtime, directive.experiment)
        else {
          try { await this.evaluate(runtime, directive.experiment, directive.commit, directive.createExperiment, directive.attemptOrdinal) }
          catch (error) {
            if (!isFrozenEvaluatorViolation(error)) throw error
            const best = optionalBest(runtime.tracker, runtime.runId)
            if (directive.experiment.kind === 'candidate' && best) {
              runtime.tracker.checkpointRun(runtime.runId, { intent: { kind: 'git-reconciliation', outcome: { kind: 'terminal-block', code: 'provenance-mismatch' } } })
              try {
                await reconcileRejectedHead(this.ctx, runtime.gitExecutable, runtime.identity.worktree, runtime.identity, directive.commit, best.commit, { ...runtime.gitOptions, signal: this.aborter.signal })
              } catch (reconcileError) {
                if (!(reconcileError instanceof GitBoundaryError)) throw reconcileError
                this.blockRejectedReconciliation(runtime, reconcileError)
              }
            }
            return this.block(runtime, { kind: 'blocked', runId: runtime.runId, code: 'provenance-mismatch', evidence: [{ code: 'provenance-mismatch', message: error instanceof Error ? error.message : 'frozen evaluator files differ from the immutable manifest', artifacts: [] }], lock: 'release-after-persist' })
          }
        }
        this.assertClaim(runtime); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue
      }
      if (directive.kind === 'finalize-evaluation') { if (directive.evaluation.policyViolation) this.finalizeFrozenMismatch(runtime, directive.experiment, directive.evaluation, directive.evaluation.policyViolation.message); else await this.finalizeEvaluation(runtime, directive.experiment, directive.evaluation); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'settle-baseline') { this.settleBaseline(runtime, directive); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'commit-candidate') { await this.commitRecoveredCandidate(runtime, directive.experiment, directive.snapshot, directive.validatedPaths); this.assertClaim(runtime); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'reconcile-candidate') { await this.reconcileCandidate(runtime, directive); this.assertClaim(runtime); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
      if (directive.kind === 'ready') {
        if (runtime.policy.target !== undefined && isTargetReached(runtime.policy.metricDirection, directive.best.metric, runtime.policy.target)) return this.complete(runtime, 'target-reached', directive.best)
        if (directive.nextOrdinal > runtime.policy.maxExperiments) return this.complete(runtime, 'budget-limited', directive.best)
        const pendingProposal = pendingProposalFailure(runtime.tracker, runtime.runId)
        await restoreAcceptedWorktree(this.ctx, runtime.gitExecutable, runtime.identity.worktree, runtime.identity, directive.restoreCommit, { ...runtime.gitOptions, signal: this.aborter.signal })
        // A proposal failure whose restoration never completed: finish its durable round-failed verdict, never re-propose.
        if (pendingProposal) { this.assertClaim(runtime); this.finishProposalFailure(runtime, pendingProposal); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue }
        if (!runtime.registration) throw new Error('durable evaluator registration is unavailable')
        try { recomputeRegistrationManifest(runtime.identity.worktree, runtime.registration.manifest) }
        catch (error) {
          if (!(error instanceof FrozenEvaluatorBoundaryError)) throw error
          return this.block(runtime, { kind: 'blocked', runId: runtime.runId, code: 'provenance-mismatch', evidence: [{ code: 'evaluator-registration-mismatch', message: error.message, artifacts: [] }], lock: 'release-after-persist' })
        }
        await this.propose(runtime, directive.best, directive.nextOrdinal)
        this.assertClaim(runtime); directive = await reconcileRecovery(this.ctx, { ...runtime, signal: this.aborter.signal }); continue
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
      if (!r.registration) throw new Error('durable evaluator registration is unavailable')
      const registration = r.registration.registration
      const evaluatorContext = { metricName: r.policy.metricName, metricDirection: r.policy.metricDirection, metricParserVersion: this.options.config.evaluatorRegistry.resolve(r.registration.evaluatorId).metricParserVersion, evaluatorFiles: registration.evaluatorFiles, localDatasetFiles: registration.dataset.kind === 'local' ? registration.dataset.files : [] }
      const historyPage = r.tracker.researchHistoryPage(r.runId)
      const proposal = await requestProposal(this.ctx, { parent: this.options.parent, runId: r.runId, experimentId, ordinal, workspace: { repositoryId: r.discovery.repositoryId, branch: r.identity.branch, worktree: r.identity.worktree, startCommit: r.discovery.startCommit, acceptedCommit: best.commit }, policy: r.policy, evaluatorContext, redactionSecrets: Object.values(r.policy.environment), policySha256: r.policySha256, provenanceSha256: r.provenanceSha256, best, history: historyPage.entries, historyOlderEntriesTruncated: historyPage.olderEntriesTruncated, config: this.options.config, gitExecutable: r.gitExecutable, gitOptions: r.gitOptions, persistTrustedGitConfig: baseline => { trusted = baseline; r.tracker.checkpointRun(r.runId, { outcome: { kind: 'trusted-git-config', experimentId, baseline } }) }, signal: this.aborter.signal })
      if (proposal.blockerClaim) r.tracker.checkpointRun(r.runId, { outcome: { kind: 'child-blocker-claim', experimentId, claim: proposal.blockerClaim, authoritative: false } })
      if (!trusted || !r.registration) throw new Error('proposal did not preserve trusted evaluator state')
      const snapshot = await snapshotCandidate(this.ctx, r.gitExecutable, r.identity.worktree, trusted, { ...r.gitOptions, signal: this.aborter.signal })
      validateFrozenCandidatePaths(snapshot, { evaluatorFiles: r.registration.registration.evaluatorFiles, datasetFiles: r.registration.registration.dataset.kind === 'local' ? r.registration.registration.dataset.files : [] })
      const validatedPaths = validateCandidate(snapshot, r.policy)
      r.tracker.prepareCandidate({ experimentId, runId: r.runId, ordinal, kind: 'candidate', parentCommit: best.commit, command: r.policy.evaluation.command, args: r.policy.evaluation.args, ...(r.policy.evaluation.cwd ? { cwd: r.policy.evaluation.cwd } : {}), annotation: { trust: 'untrusted-child-annotation', redaction: 'exact-configured-secrets-only', hypothesis: proposal.hypothesis, intendedEdits: proposal.intendedEdits, implementationSummary: proposal.implementationSummary }, redactionSecrets: Object.values(r.policy.environment) }, { intent: { kind: 'candidate-snapshot', experimentId, snapshot, validatedPaths } })
    } catch (error) {
      if (error instanceof ProposalAgentError && (error.code === 'dispose-failed' || error.code === 'not-quiescent')) { this.quiescenceFailure = error; r.tracker.transitionRun(r.runId, 'blocked', { terminalReason: error.message, blockedCode: 'attempt-uncertain', quiescent: false, ...(best ? { best } : {}) }); return }
      if (this.aborter.signal.aborted) throw error
      const evidence = errorEvidence(error)
      // The proposal verdict is durable before restoration: if restoring fails, failure recovery and every resume read it back
      // and finish drive()'s round-failed verdict instead of proposing a fresh candidate at the same ordinal.
      r.tracker.checkpointRun(r.runId, { intent: { kind: PROPOSAL_FAILURE_INTENT, commit: best.commit, code: evidence.code, message: evidence.message } })
      await restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, best.commit, { ...r.gitOptions, signal: this.aborter.signal })
      this.finishProposalFailure(r, evidence)
    }
  }

  /** drive()'s round-failed verdict for a quiescent proposal failure, persisted once its accepted HEAD is restored. */
  private finishProposalFailure(r: Runtime, evidence: ProposalFailureEvidence, controllerFailure: readonly BlockerEvidence[] = []): void {
    r.tracker.transitionRun(r.runId, 'round-failed', { terminalReason: evidence.message, blockedCode: evidence.code, quiescent: true, ...(controllerFailure.length > 0 ? { outcome: { kind: CONTROLLER_FAILURE_OUTCOME, evidence: [evidence, ...controllerFailure].map(({ code, message }) => ({ code, message })) } } : {}) })
  }

  private async commitRecoveredCandidate(r: Runtime, experiment: RecoveredExperiment, snapshot: CandidateSnapshot, validatedPaths: readonly string[]): Promise<void> {
    const canonicalSnapshot = { ...snapshot, gitConfig: { files: snapshot.gitConfig.files.map(file => ({ logicalPath: file.logicalPath, path: file.path, exists: file.exists, ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }) })), allowedPaths: [...snapshot.gitConfig.allowedPaths] } }
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'candidate-commit', experimentId: experiment.experimentId, snapshot: canonicalSnapshot, validatedPaths } })
    const candidate = await commitCandidate(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, experiment.experimentId, canonicalSnapshot, validatedPaths, { ...r.gitOptions, signal: this.aborter.signal })
    await checkoutCandidateForEvaluation(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, candidate.candidateCommit, experiment.parentCommit, { ...r.gitOptions, signal: this.aborter.signal })
    r.tracker.recordCandidateCommit(experiment.experimentId, candidate.candidateCommit, { changedPaths: candidate.changedPaths, ...(candidate.diffStats === undefined ? {} : { diffStats: candidate.diffStats }) }, Object.values(r.policy.environment))
    r.tracker.checkpointRun(r.runId, { outcome: { kind: 'candidate-committed', candidateCommit: candidate.candidateCommit, parentCommit: candidate.parentCommit, auditRef: candidate.auditRef, ...(candidate.diffStats === undefined ? {} : { diffStats: candidate.diffStats }) } })
  }

  private async evaluate(r: Runtime, experiment: RecoveredExperiment, commit: string, createExperiment: boolean, attemptOrdinal: number): Promise<void> {
    if (experiment.kind === 'candidate') await checkoutCandidateForEvaluation(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, commit, experiment.parentCommit, { ...r.gitOptions, signal: this.aborter.signal })
    await verifyExactWorktree(this.ctx, r.gitExecutable, r.identity.worktree, commit, { ...r.gitOptions, signal: this.aborter.signal })
    if (!r.registration) throw new Error('durable evaluator registration is unavailable')
    recomputeRegistrationManifest(r.identity.worktree, r.registration.manifest)
    const frozenFiles = captureFrozenFileAttempt(r.identity.worktree, r.registration.manifest)
    if (createExperiment) r.tracker.createExperiment({ experimentId: experiment.experimentId, runId: r.runId, ordinal: experiment.ordinal, kind: experiment.kind, parentCommit: experiment.parentCommit, command: r.policy.evaluation.command, args: r.policy.evaluation.args, ...(r.policy.evaluation.cwd ? { cwd: r.policy.evaluation.cwd } : {}) })
    const row = r.tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get(experiment.experimentId)
    if (row?.['state'] === 'baseline-pending') r.tracker.transitionExperiment(experiment.experimentId, 'running')
    const desired = experiment.kind === 'baseline' ? 'baseline-running' : 'candidate-running'
    if (r.tracker.getRun(r.runId)?.['state'] !== desired) r.tracker.transitionRun(r.runId, desired, { intent: { kind: 'evaluation', experimentId: experiment.experimentId, attemptOrdinal } })
    const attemptId = `${experiment.experimentId}-attempt-${attemptOrdinal}`
    const boundary = createEvaluatorBoundary(r.identity.worktree, { evaluation: r.policy.evaluation, normalizedPolicySha256: r.policySha256, evaluatorFiles: r.registration.registration.evaluatorFiles, runId: r.runId, attemptId })
    revalidateEvaluatorBoundary(r.identity.worktree, boundary); revalidateFrozenFileAttempt(r.identity.worktree, frozenFiles)
    let intentCreated = false
    const persistenceState: { frozenMismatch?: { message: string; evaluation: RecoveredEvaluation } } = {}
    const dataset = registrationDatasetMetadata(r.registration.registration)
    let artifactCapabilityFailed = false
    const evaluation = runEvaluator({ subprocess: this.ctx.subprocess, worktree: r.identity.worktree, boundary, frozenFiles, evaluation: r.policy.evaluation, metricName: r.policy.metricName, metricDirection: r.policy.metricDirection, timeoutMs: r.policy.timeoutMs, terminationGraceMs: this.options.config.terminationGraceMs, maxStdoutBytes: this.options.config.maxStdoutBytes, maxStderrBytes: this.options.config.maxStderrBytes, artifactWriterFactory: () => { if (!intentCreated) throw new Error('artifact capability requested before durable attempt intent'); try { return createEvaluatorArtifactWriterFactory(r.tracker.layout, r.runId, experiment.experimentId, attemptId)() } catch (error) { artifactCapabilityFailed = true; throw error } }, environment: r.policy.environment, ...(dataset ? { dataset } : {}), policy: r.policy, signal: this.aborter.signal, persistence: {
      persistSpawnIntent: intent => { r.tracker.createAttemptIntent({ attemptId, runId: r.runId, experimentId: experiment.experimentId, ordinal: attemptOrdinal }, intent); intentCreated = true },
      persistSpawnObserved: facts => r.tracker.recordAttemptObserved(attemptId, facts),
      persistAttemptQuiescent: facts => r.tracker.recordAttemptObserved(attemptId, facts),
      persistAttemptOutcome: (outcome, outputArtifacts) => {
        const artifacts = outputArtifacts.map(item => artifact(r, experiment.experimentId, attemptId, item))
        const attemptResult = outcome.kind === 'measured' ? { kind: 'measured' as const, metric: outcome.metric } : { kind: 'failed' as const, code: outcome.code, message: outcome.message }
        let mismatchMessage: string | undefined
        if (outcome.kind === 'failed' && outcome.code === 'frozen-boundary') mismatchMessage = boundedMismatchMessage(outcome.message)
        else try { revalidateFrozenFileAttempt(r.identity.worktree, frozenFiles) }
        catch (error) {
          if (!isFrozenEvaluatorViolation(error)) throw error
          mismatchMessage = boundedMismatchMessage(error)
        }
        r.tracker.recordAttemptOutcome(attemptId, { facts: outcome.exit, artifacts, result: attemptResult, outcome: mismatchMessage === undefined ? { kind: 'evaluator-outcome' } : { kind: 'frozen-file-policy-mismatch', code: 'provenance-mismatch', message: mismatchMessage, evidence: [{ code: 'provenance-mismatch', message: mismatchMessage }] } })
        if (experiment.kind === 'candidate' && attemptResult.kind === 'failed' && attemptResult.code === 'spawn' && outcome.exit.providerPid === undefined && outcome.exit.spawnedAt === undefined && outcome.exit.processTreeQuiescent) r.tracker.discardProvenNoProcessCandidateArtifacts(attemptId)
        if (mismatchMessage !== undefined) persistenceState.frozenMismatch = { message: mismatchMessage, evaluation: { ...outcome, attemptId, artifacts } as RecoveredEvaluation }
      },
    } })
    let result: Awaited<typeof evaluation>
    try { result = await evaluation }
    catch (error) {
      // runEvaluator mints the attempt's artifact capability after its durable spawn intent and before provider spawn, so
      // a mint failure proves this attempt created no process: record that empty process tree as quiescent.
      if (!artifactCapabilityFailed) throw error
      try { r.tracker.recordAttemptObserved(attemptId, { processTreeQuiescent: true }) }
      catch (markError) { throw controllerAggregateError('evaluator artifact capability failed and its pre-spawn quiescence could not be recorded', [['original', error], ['quiescence record', markError]], Object.values(r.policy.environment)) }
      throw error
    }
    if (persistenceState.frozenMismatch) return this.finalizeFrozenMismatch(r, experiment, persistenceState.frozenMismatch.evaluation, persistenceState.frozenMismatch.message)
    const recovered = { ...result, attemptId, artifacts: result.artifacts.map(item => artifact(r, experiment.experimentId, attemptId, item)) } as RecoveredEvaluation
    await this.finalizeEvaluation(r, experiment, recovered)
  }
  private finalizeFrozenMismatch(r: Runtime, experiment: RecoveredExperiment, evaluation: RecoveredEvaluation, message: string): void {
    if (experiment.kind === 'candidate') r.tracker.appendFailureResearchFacts(experiment.experimentId, { code: 'provenance-mismatch' })
    r.tracker.commitTerminalExperiment(experiment.experimentId, 'policy-violation', experimentFacts(evaluation, { failureCode: 'provenance-mismatch', failureMessage: message }))
    if (experiment.kind === 'baseline') r.tracker.transitionRun(r.runId, 'blocked', { terminalReason: message, blockedCode: 'provenance-mismatch', quiescent: evaluation.exit.processTreeQuiescent })
    else r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'candidate-evaluation-failed', code: 'provenance-mismatch', message } })
  }

  private exhaustEvaluationRerun(r: Runtime, experiment: RecoveredExperiment): void {
    const message = 'proven-quiescent evaluator recovery rerun ended without a durable outcome'
    if (experiment.kind === 'candidate') r.tracker.appendFailureResearchFacts(experiment.experimentId, { code: 'recovery-rerun-exhausted' })
    r.tracker.commitTerminalExperiment(experiment.experimentId, 'crashed', { failureCode: 'recovery-rerun-exhausted', failureMessage: message })
    if (experiment.kind === 'baseline') r.tracker.transitionRun(r.runId, 'blocked', { terminalReason: message, blockedCode: 'recovery-rerun-exhausted', quiescent: true })
    else r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'candidate-evaluation-failed', code: 'recovery-rerun-exhausted', message } })
  }


  private async finalizeEvaluation(r: Runtime, experiment: RecoveredExperiment, evaluation: RecoveredEvaluation): Promise<void> {
    if (evaluation.provenanceSha256 !== r.provenanceSha256) return this.failEvaluation(r, experiment, evaluation, 'provenance-mismatch', 'evaluator provenance changed')
    if (evaluation.policyViolation?.code === 'provenance-mismatch') return this.finalizeFrozenMismatch(r, experiment, evaluation, evaluation.policyViolation.message)
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
    if (experiment.kind === 'candidate' && HANDOFF_FAILURE_CODES[code] === true) r.tracker.appendFailureResearchFacts(experiment.experimentId, mechanicalFailureFacts(code, evaluation))
    r.tracker.commitTerminalExperiment(experiment.experimentId, state, experimentFacts(evaluation, { failureCode: code, failureMessage: message }))
    if (experiment.kind === 'baseline') {
      const runState = code === 'cancelled' && evaluation.exit.processTreeQuiescent ? 'cancelled' : evaluation.exit.processTreeQuiescent ? 'baseline-blocked' : 'blocked'
      r.tracker.transitionRun(r.runId, runState, { terminalReason: message, blockedCode: evaluation.exit.processTreeQuiescent ? code : 'attempt-uncertain', quiescent: evaluation.exit.processTreeQuiescent })
      return
    }
    if (code === 'provenance-mismatch') {
      r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'candidate-evaluation-failed', code, message } })
      return
    }
    r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'candidate-evaluation-failed', code, message } })
  }

  /** `afterGit` re-proves ownership after each awaited Git operation, before any durable write that depends on it. */
  private async reconcileCandidate(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'reconcile-candidate' }>, signal = this.aborter.signal, afterGit: () => void = () => undefined): Promise<void> {
    const best = durableBest(r.tracker, r.runId)
    const experimentRow = r.tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get(directive.experiment.experimentId)
    const experimentTerminal = experimentRow && !['baseline-pending', 'running'].includes(String(experimentRow['state']))
    if (!experimentTerminal && (directive.outcome.kind === 'accept' || directive.outcome.kind === 'reject')) r.tracker.checkpointExperiment(directive.experiment.experimentId, { decision: directive.outcome.kind })
    if (r.tracker.getRun(r.runId)?.['state'] === 'candidate-running') r.tracker.transitionRun(r.runId, 'deciding', { outcome: { kind: 'terminal-experiment-recovered' } })
    r.tracker.checkpointRun(r.runId, { intent: { kind: 'git-reconciliation', outcome: directive.outcome } })
    if (directive.outcome.kind === 'accept') {
      try { await reconcileAcceptedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, directive.candidateCommit, { ...r.gitOptions, signal }) }
      finally { afterGit() }
      const next = { metric: directive.outcome.metric, commit: directive.candidateCommit, experimentId: directive.experiment.experimentId }
      if (!experimentTerminal) r.tracker.commitTerminalExperiment(directive.experiment.experimentId, 'accepted', { metric: next.metric, decision: 'accept' })
      const target = r.policy.target !== undefined && isTargetReached(r.policy.metricDirection, next.metric, r.policy.target)
      r.tracker.transitionRun(r.runId, target ? 'completed' : 'ready', { best: next, outcome: { kind: 'reconciled', decision: 'accept' } })
      return
    }
    try {
      await reconcileRejectedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, directive.candidateCommit, directive.expectedAcceptedCommit, { ...r.gitOptions, signal })
    } catch (error) {
      afterGit()
      if (!(error instanceof GitBoundaryError)) throw error
      return this.blockRejectedReconciliation(r, error)
    }
    afterGit()
    if (!experimentTerminal && directive.outcome.kind === 'reject') r.tracker.commitTerminalExperiment(directive.experiment.experimentId, 'rejected', { metric: directive.outcome.metric, decision: 'reject' })
    if (directive.outcome.kind === 'cancel') {
      r.tracker.transitionRun(r.runId, 'cancelled', { best, terminalReason: this.cancelReason, blockedCode: 'cancelled', quiescent: true, outcome: { kind: 'reconciled', decision: 'cancel' } })
      return
    }
    if (directive.outcome.kind === 'terminal-block') {
      r.tracker.transitionRun(r.runId, 'blocked', { best, terminalReason: directive.outcome.message, blockedCode: directive.outcome.code, quiescent: true, outcome: { kind: 'candidate-failure-reconciled', code: directive.outcome.code } })
      return
    }
    r.tracker.transitionRun(r.runId, 'ready', { best, outcome: directive.outcome.kind === 'continue-failure' ? { kind: 'candidate-failure-reconciled', code: directive.outcome.code } : { kind: 'reconciled', decision: 'reject' } })
  }

  private blockRejectedReconciliation(r: Runtime, error: GitBoundaryError): void {
    const evidence = normalizedGitReconciliationEvidence(error)
    r.tracker.checkpointRun(r.runId, {
      blockedCode: 'git-reconciliation-failed',
      outcome: { kind: 'git-reconciliation-blocked', code: error.code, evidence, head: 'uncertain' },
    })
    throw new RejectedReconciliationBlockedError(error.code, evidence)
  }

  private async complete(r: Runtime, status: 'target-reached' | 'budget-limited', best: BestResult): Promise<AutoresearchRunResult> {
    if (r.tracker.getRun(r.runId)?.['state'] !== 'completed') r.tracker.transitionRun(r.runId, 'completed', { best, terminalReason: status, quiescent: true })
    return this.finish(r, { status, ...(status === 'target-reached' ? { target: r.policy.target! } : {}), best })
  }

  /** `controllerFailure` persists the complete typed evidence in the terminal transition so terminal replay returns it unchanged. */
  private async block(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'blocked' }>, controllerFailure = false): Promise<AutoresearchRunResult> {
    // Failure persistence runs on fresh cleanup signals that ignore a lost claim: re-prove ownership right before the
    // synchronous terminal transition and lock release, so a controller that lost the run never terminalizes it.
    if (controllerFailure) this.assertClaim(r)
    const best = optionalBest(r.tracker, r.runId)
    const row = r.tracker.getRun(r.runId)!
    const provenQuiescent = directive.lock === 'release-after-persist' && r.tracker.recoveryState(r.runId).processDisposition !== 'uncertain'
    if (!['completed','baseline-blocked','blocked','round-failed','cancelled'].includes(String(row['state']))) {
      const unresolved = r.tracker.recoveryState(r.runId).unresolvedExperiment
      if (unresolved) {
        const id = String(unresolved['experiment_id']); const state = String(unresolved['state'])
        if (state === 'baseline-pending') r.tracker.commitTerminalExperiment(id, 'cancelled', { failureCode: directive.code, failureMessage: directive.evidence[0]?.message ?? directive.code })
        else if (state === 'running') r.tracker.commitTerminalExperiment(id, 'crashed', { failureCode: directive.code, failureMessage: directive.evidence[0]?.message ?? directive.code })
      }
      r.tracker.transitionRun(r.runId, 'blocked', { blockedCode: directive.code, terminalReason: directive.evidence[0]?.message ?? directive.code, quiescent: provenQuiescent, ...(best ? { best } : {}), ...(controllerFailure ? { outcome: { kind: CONTROLLER_FAILURE_OUTCOME, evidence: directive.evidence.map(({ code, message }) => ({ code, message })) } } : {}) })
    }
    const result = best ? { status: 'blocked', best, evidence: directive.evidence } : { status: 'round-failed', reason: directive.evidence[0]?.message ?? directive.code, evidence: directive.evidence }
    return this.finish(r, result, provenQuiescent)
  }

  private async cancelled(r: Runtime): Promise<AutoresearchRunResult> {
    const row = r.tracker.getRun(r.runId)
    if (this.quiescenceFailure) return this.block(r, { kind: 'blocked', runId: r.runId, code: 'attempt-uncertain', evidence: [{ code: this.quiescenceFailure.code, message: this.quiescenceFailure.message, artifacts: [] }], lock: 'retain' })
    if (!row) throw new Error(this.cancelReason)
    const state = String(row['state']) as RunDurableState
    if (['completed','baseline-blocked','blocked','round-failed','cancelled'].includes(state)) {
      const directive = await reconcileRecovery(this.ctx, { ...r, signal: new AbortController().signal })
      if (directive.kind === 'blocked') return this.block(r, directive)
      if (directive.kind === 'terminal') return this.returnTerminal(r, directive)
      throw new Error(`terminal cancellation reconciliation returned ${directive.kind}`)
    }
    this.persistCancellationIntent()
    const cleanupSignal = new AbortController().signal
    // Recovery also selects the latest terminal experiment: cancelled evaluator
    // outcomes are no longer unresolved, and an interrupted acceptance must finish
    // its validated transaction before choosing the accepted commit to restore.
    if (state === 'candidate-prepared') {
      const recovery = await reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal })
      if (recovery.kind === 'blocked') return this.block(r, recovery)
      if (recovery.kind === 'evaluate' && !recovery.rerun && recovery.attemptOrdinal === 1) {
        try {
          await reconcileRejectedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, recovery.commit, durableBest(r.tracker, r.runId).commit, { ...r.gitOptions, signal: cleanupSignal })
        } catch (error) {
          if (!(error instanceof GitBoundaryError)) throw error
          return this.block(r, { kind: 'blocked', runId: r.runId, code: 'git-external-mutation', evidence: [{ code: error.code, message: error.message, artifacts: [] }], lock: 'retain' })
        }
      } else if (recovery.kind !== 'commit-candidate') {
        return this.block(r, { kind: 'blocked', runId: r.runId, code: 'attempt-uncertain', evidence: [{ code: 'attempt-uncertain', message: `prepared candidate cancellation lacks pre-spawn authority (${recovery.kind})`, artifacts: [] }], lock: 'retain' })
      }
    }
    if (state === 'candidate-running' || state === 'deciding') {
      let recovery = await reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal })
      if (recovery.kind === 'finalize-evaluation') {
        await this.finalizeEvaluation(r, recovery.experiment, recovery.evaluation)
        recovery = await reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal })
      }
      if (recovery.kind === 'blocked') return this.block(r, recovery)
      if (recovery.kind !== 'reconcile-candidate') return this.block(r, { kind: 'blocked', runId: r.runId, code: 'attempt-uncertain', evidence: [{ code: 'attempt-uncertain', message: `candidate cancellation lacks a durable reconciliation outcome (${recovery.kind})`, artifacts: [] }], lock: 'retain' })
      try { await this.reconcileCandidate(r, recovery, cleanupSignal) }
      catch (error) {
        if (!(error instanceof RejectedReconciliationBlockedError)) throw error
        return this.block(r, { kind: 'blocked', runId: r.runId, code: 'git-external-mutation', evidence: error.evidence.map(message => ({ code: error.code, message, artifacts: [] })), lock: 'retain' })
      }
      const settled = await reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal })
      if (settled.kind === 'blocked') return this.block(r, settled)
      if (settled.kind === 'terminal') return this.returnTerminal(r, settled)
    }
    const unresolved = r.tracker.recoveryState(r.runId).unresolvedExperiment
    const best = optionalBest(r.tracker, r.runId)
    if (unresolved && ['baseline-pending','running'].includes(String(unresolved['state']))) r.tracker.commitTerminalExperiment(String(unresolved['experiment_id']), 'cancelled', { failureCode: 'cancelled', failureMessage: this.cancelReason })
    if (best) await restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, best.commit, { ...r.gitOptions, signal: cleanupSignal })
    r.tracker.transitionRun(r.runId, 'cancelled', { terminalReason: this.cancelReason, quiescent: true, ...(best ? { best } : {}) })
    const directive = await reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal })
    if (directive.kind === 'blocked') return this.block(r, directive)
    if (directive.kind !== 'terminal' || directive.state !== 'cancelled') throw new Error(`durable cancellation reconciliation returned ${directive.kind}`)
    return this.returnTerminal(r, directive)
  }

  /**
   * Releasing the controller claim does not release the shared active-run lock: an owned run that fails unexpectedly
   * after activation must be terminalized, or it blocks every later run on the repository. Terminal persistence goes
   * through block(), which releases the lock only when every attempt is durably quiescent. A run without an active lock
   * has nothing to leak and stays resumable, and an already-terminal run keeps its existing replay/release path. A
   * controller that no longer provably owns the run never terminalizes it: another controller may be driving it.
   */
  private async failUnexpectedly(r: Runtime, error: unknown): Promise<AutoresearchRunResult> {
    if (!this.unexpectedFailurePersistenceForTest(error)) throw error
    if (error instanceof GitBoundaryError && CLAIM_LOSS_CODES.has(error.code)) throw error
    const secrets = Object.values(r.policy.environment)
    try { heartbeatControllerClaim(r.tracker, r.runId, r.claimOwner!, CONTROLLER_LEASE_MS, new Date(), r.claimProcess!) }
    catch (claimError) { this.claimFailure ??= claimError; throw controllerAggregateError('autoresearch run failed and this controller no longer provably owns it, so its terminal failure was not persisted', [['original', error], ['claim', claimError]], secrets) }
    let recovery: ReturnType<DurableTracker['recoveryState']>
    try { recovery = r.tracker.recoveryState(r.runId) }
    catch (inspectionError) { throw controllerAggregateError('autoresearch run failed and its durable state could not be inspected for terminal failure persistence', [['original', error], ['inspection', inspectionError]], secrets) }
    const state = String(recovery.run['state']) as RunDurableState
    if (isTerminalState(state)) {
      // The terminal transition committed but its finish() failed before releasing the lock: release it now when the
      // durable row proves quiescence, exactly as a terminal resume would, rather than stranding it.
      if (recovery.activeLock && recovery.run['terminal_quiescent'] === 1 && recovery.processDisposition === 'quiescent') {
        try { recoverTerminalRunLockUnderControllerClaim(r.tracker, r.runId, r.claimOwner!, r.claimProcess!) }
        catch (releaseError) { throw controllerAggregateError('autoresearch run failed after its terminal transition and its quiescent run lock could not be released', [['original', error], ['release', releaseError]], secrets) }
      }
      throw error
    }
    if (!recovery.activeLock) throw error
    const evidence = controllerFailureEvidence(error, secrets)
    try {
      // A proposal child that is not proven quiescent may still be editing the worktree: block without restoring it and
      // retain the lock, exactly as cancellation does.
      if (this.quiescenceFailure) return await this.block(r, { kind: 'blocked', runId: r.runId, code: 'attempt-uncertain', evidence: [{ code: this.quiescenceFailure.code, message: this.quiescenceFailure.message, artifacts: [] }, ...evidence], lock: 'retain' }, true)
      return await this.terminalizeFailure(r, state, evidence)
    } catch (cleanupError) {
      // Any cleanup failure after a claim loss (including Git aborted by it) is that loss: another controller may own the run.
      if (this.claimFailure !== undefined) throw controllerAggregateError('autoresearch run failed and this controller lost its claim during failure recovery, so its terminal failure was not persisted', [['original', error], ['claim', this.claimFailure], ...(cleanupError === this.claimFailure ? [] : [['recovery', cleanupError] as const])], secrets)
      if (cleanupError instanceof ResumableControllerFailure) {
        let proposal: ProposalFailureEvidence | undefined
        try { proposal = pendingProposalFailure(r.tracker, r.runId) } catch { proposal = undefined }
        const proposalPart = proposal ? [[`proposal ${proposal.code}`, Object.assign(new Error(proposal.message), { name: 'ProposalFailure', code: proposal.code })] as const] : []
        throw controllerAggregateError('autoresearch run failed and its accepted HEAD could not be restored; the run remains nonterminal with its lock held so a resume can retry reconciliation', [['original', error], ...proposalPart, ['restoration', cleanupError.cause]], secrets)
      }
      throw controllerAggregateError('autoresearch run failed and its terminal failure persistence also failed', [['original', error], ['persistence', cleanupError]], secrets)
    }
  }

  /**
   * Initializing runs have no attempt, so they terminalize directly. Every later phase first reconciles with a fresh,
   * non-aborted cleanup signal: a durably recorded attempt outcome (baseline or candidate) is authority and is finalized
   * before terminalizing, never overwritten as crashed. A baseline without an outcome never moved HEAD. A candidate phase may
   * leave an unaccepted candidate checked out: like cancellation it first reconciles with a fresh, non-aborted cleanup
   * signal and restores the accepted HEAD. Terminal lock retention is reserved for real process uncertainty (block()
   * still retains it whenever an attempt is not durably quiescent). When every process is quiescent but restoration or
   * candidate reconciliation fails on Git state (a transient Git error, a stray worktree file, an index lock) or recovery
   * settles somewhere unexpected, the run is left nonterminal with its lock held: a terminal row with an unproven
   * quiescence would retain the lock permanently, while a resume after the condition clears retries the reconciliation
   * and releases it. A rejected reconciliation keeps the recoverable `git-reconciliation-blocked` checkpoint that drive()
   * also writes. When the controller itself terminalizes the failure (a `controller-failed` block, or a block that
   * recovery resolves to), the original failure's typed evidence is persisted with that terminal transition.
   *
   * A durable, validated decision supersedes the transient controller failure: when reconciliation settles an
   * already-recorded outcome into its own terminal state (an accepted candidate reaching the target, a classified
   * baseline failure, a persisted cancellation or terminal block), or into a ready state that drive() would complete
   * (a measured best meeting the target, or an exhausted experiment budget), that canonical result is returned and the controller
   * failure is deliberately not attached. The failure interrupted only work that recovery then completed exactly as a
   * resume would; those result shapes carry no evidence field, and a terminal replay rebuilds the result solely from
   * durable rows, so attaching it live would make the first result differ from every replay.
   */
  private async terminalizeFailure(r: Runtime, state: RunDurableState, evidence: readonly BlockerEvidence[]): Promise<AutoresearchRunResult> {
    const secrets = Object.values(r.policy.environment)
    // Every durable or worktree mutation below first re-proves the controller claim (block() does so itself).
    const guard = (): void => this.assertClaim(r)
    const failure = (): Promise<AutoresearchRunResult> => this.block(r, { kind: 'blocked', runId: r.runId, code: 'controller-failed', evidence, lock: 'release-after-persist' }, true)
    // A ready run that has met its target or exhausted its budget completes exactly as drive() completes it on every
    // ready directive, before restoring HEAD or proposing: recovery already settled that outcome successfully.
    const completion = (best: BestResult, nextOrdinal: number): Promise<AutoresearchRunResult> | undefined => {
      const status = r.policy.target !== undefined && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? 'target-reached' : nextOrdinal > r.policy.maxExperiments ? 'budget-limited' : undefined
      if (status === undefined) return undefined
      guard()
      return this.complete(r, status, best)
    }
    const blockedByRecovery = (directive: Extract<RecoveryDirective, { kind: 'blocked' }>): Promise<AutoresearchRunResult> => this.block(r, { ...directive, evidence: [...directive.evidence, ...evidence] }, true)
    const resumable = (cause: unknown): never => { throw new ResumableControllerFailure(cause) }
    const restoreOrResume = async (restore: () => Promise<void>, terminalize: () => Promise<AutoresearchRunResult> = failure): Promise<AutoresearchRunResult> => {
      guard()
      try { await restore() }
      catch (error) {
        if (!(error instanceof GitBoundaryError)) throw error
        return resumable(error)
      }
      return terminalize()
    }
    // A fresh signal the settled run aborter never aborts, but a claim loss does (recordClaimFailure).
    this.failureCleanup = new AbortController()
    if (this.claimFailure !== undefined) this.failureCleanup.abort(this.claimFailure)
    const cleanupSignal = this.failureCleanup.signal
    const options = { ...r.gitOptions, signal: cleanupSignal }
    const reconcile = (): Promise<RecoveryDirective> => { guard(); return reconcileRecovery(this.ctx, { ...r, signal: cleanupSignal }) }
    if (state === 'initializing') return failure()
    if (state === 'ready') {
      const best = durableBest(r.tracker, r.runId)
      const completed = completion(best, nextCandidateOrdinal(r.tracker, r.runId))
      if (completed) return completed
      // A quiescent proposal failure whose own restoration failed (its verdict is durable in the last run checkpoint): once
      // restored, persist drive()'s round-failed verdict with the proposal's evidence, followed by the controller failure
      // that interrupted it. A resume reads the same checkpoint when this restoration also fails.
      const proposalFailure = pendingProposalFailure(r.tracker, r.runId)
      const roundFailed = proposalFailure && (async (): Promise<AutoresearchRunResult> => {
        guard()
        this.finishProposalFailure(r, proposalFailure, evidence)
        const settled = await reconcile()
        if (settled.kind === 'terminal') { guard(); return this.returnTerminal(r, settled) }
        if (settled.kind === 'blocked') return blockedByRecovery(settled)
        throw new Error(`proposal failure recovery settled as ${settled.kind}`)
      })
      return restoreOrResume(() => restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, best.commit, options), roundFailed || failure)
    }
    let recovery: RecoveryDirective
    try { recovery = await reconcile() }
    catch (error) {
      // The baseline never moves HEAD: without any durable attempt outcome there is nothing to finalize, so terminalize
      // directly. A recorded outcome is authority and must not be overwritten as crashed: stay nonterminal for a resume.
      if (state === 'baseline-running' && !hasDurableAttemptOutcome(r.tracker, r.runId)) return failure()
      throw error
    }
    // A durably classified attempt outcome is authority (baseline or candidate): finalize it before terminalizing,
    // exactly as drive() does on resume, instead of committing a measured experiment as crashed.
    if (recovery.kind === 'finalize-evaluation' && state !== 'candidate-prepared') {
      guard()
      if (recovery.evaluation.policyViolation) this.finalizeFrozenMismatch(r, recovery.experiment, recovery.evaluation, recovery.evaluation.policyViolation.message)
      else await this.finalizeEvaluation(r, recovery.experiment, recovery.evaluation)
      recovery = await reconcile()
    }
    // A committed terminal baseline whose run transition did not land settles exactly as drive() would.
    if (recovery.kind === 'settle-baseline') {
      guard()
      this.settleBaseline(r, recovery)
      recovery = await reconcile()
    }
    if (recovery.kind === 'blocked') return blockedByRecovery(recovery)
    // A failed baseline outcome settles to its own canonical terminal result (baseline-blocked, cancelled or blocked).
    if (recovery.kind === 'terminal') { guard(); return this.returnTerminal(r, recovery) }
    // A measured baseline is the accepted best: unless it already completes the run, terminalize the controller failure
    // with it, from the accepted HEAD.
    if (recovery.kind === 'ready') {
      const completed = completion(recovery.best, recovery.nextOrdinal)
      if (completed) return completed
      const restoreCommit = recovery.restoreCommit
      return restoreOrResume(() => restoreAcceptedWorktree(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, restoreCommit, options))
    }
    // The baseline has no durable outcome (no attempt, or a proven-quiescent attempt without one): nothing moved HEAD.
    if (recovery.kind === 'evaluate' && recovery.experiment.kind === 'baseline') return failure()
    // Candidate committed but not yet evaluated (or proven quiescent without an outcome): reject it back to accepted HEAD.
    if (recovery.kind === 'evaluate' && recovery.experiment.kind === 'candidate') {
      const commit = recovery.commit
      const experimentId = recovery.experiment.experimentId
      return restoreOrResume(async () => {
        // A candidate-prepared resume otherwise requires the worktree to match the candidate exactly: durably mark the
        // rejection before its first destructive step, so a partial rejection stays resumable instead of reading as an
        // external mutation that would block the run and retain its lock.
        if (state === 'candidate-prepared') r.tracker.checkpointRun(r.runId, { intent: { kind: CANDIDATE_REJECTION_INTENT, experimentId, candidateCommit: commit } })
        await reconcileRejectedHead(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, commit, durableBest(r.tracker, r.runId).commit, options)
      })
    }
    // Candidate snapshot not yet durably committed: discard it back to the accepted commit. Its audit ref and branch move
    // may already have landed before the commit was recorded, which is a valid rejection state.
    if (recovery.kind === 'commit-candidate') {
      const experimentId = recovery.experiment.experimentId
      return restoreOrResume(() => restoreAcceptedAfterCandidateCommit(this.ctx, r.gitExecutable, r.identity.worktree, r.identity, experimentId, durableBest(r.tracker, r.runId).commit, options))
    }
    if (recovery.kind === 'reconcile-candidate') {
      guard()
      try { await this.reconcileCandidate(r, recovery, cleanupSignal, guard) }
      catch (error) {
        // The reject path has already checkpointed a recoverable `git-reconciliation-blocked` outcome, exactly as drive()
        // does; the accept path (reconcileAcceptedHead) throws GitBoundaryError and keeps its durable reconciliation intent.
        // Neither proves the accepted HEAD, and a resume retries both.
        if (error instanceof RejectedReconciliationBlockedError) {
          const best = durableBest(r.tracker, r.runId)
          return decodeRunResult({ ...common(r), status: 'blocked', best, evidence: [...evidence, ...error.evidence.map(message => ({ code: error.code, message: boundedFailureMessage(redactConfiguredSecrets(message, secrets)), artifacts: [] }))] }, r.policy.metricDirection)
        }
        if (error instanceof GitBoundaryError) return resumable(error)
        throw error
      }
      const settled = await reconcile()
      // reconcileCandidate already restored the accepted HEAD; an accept or reject that exhausts the budget completes.
      if (settled.kind === 'ready') return completion(settled.best, settled.nextOrdinal) ?? failure()
      if (settled.kind === 'blocked') return blockedByRecovery(settled)
      if (settled.kind === 'terminal') { guard(); return this.returnTerminal(r, settled) }
      return resumable(new Error(`candidate reconciliation settled as ${settled.kind}`))
    }
    return resumable(new Error(`${state} failure recovery returned ${recovery.kind}`))
  }

  private async returnTerminal(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'terminal' }>): Promise<AutoresearchRunResult> {
    const row = r.tracker.getRun(r.runId)!
    const validatedArtifacts = directive.artifacts.map(publicArtifact)
    const facts = common(r, validatedArtifacts)
    const best = optionalBest(r.tracker, r.runId)
    let value: Record<string, unknown>
    if (directive.state === 'completed') value = { ...facts, status: r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? 'target-reached' : 'budget-limited', ...(r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? { target: r.policy.target } : {}), best }
    else if (directive.state === 'baseline-blocked') value = baselineBlocked(r, validatedArtifacts)
    else if (directive.state === 'cancelled') value = cancelledResult(r, directive.lastState, validatedArtifacts)
    else if (directive.state === 'blocked' && best) value = { ...facts, status: 'blocked', best, evidence: durableControllerFailureEvidence(r.tracker, r.runId, row) ?? evidenceFromRun(row) }
    else value = { ...facts, status: 'round-failed', reason: String(row['terminal_reason'] ?? directive.state), evidence: durableControllerFailureEvidence(r.tracker, r.runId, row) ?? evidenceFromRun(row), ...(best ? { best } : {}) }
    return this.finish(r, value, directive.lock !== 'retain')
  }

  private async finish(r: Runtime, specific: Record<string, unknown>, release = true): Promise<AutoresearchRunResult> {
    // The terminal transition is already durable: release a provably quiescent run's lock before result decoding and the
    // presentation-only TSV export, so neither can strand the lock of a finished run.
    const recovery = r.tracker.recoveryState(r.runId)
    const safeRelease = release && recovery.run['terminal_quiescent'] === 1 && recovery.processDisposition === 'quiescent'
    if (safeRelease) recoverTerminalRunLock(r.tracker, r.runId)
    const result = decodeRunResult({ ...common(r), ...specific }, r.policy.metricDirection)
    const successful = result.status === 'target-reached' || result.status === 'budget-limited'
    const removeWorktree = !this.options.config.retainWorktrees && (!this.options.config.cleanupWorktreesOnSuccess || successful)
    // Export precedes retention so its artifact availability column reflects the run as it finished.
    if (this.options.config.exportTsv) r.tracker.exportTsv(r.runId, r.tracker.layout.resolve(join('exports', `${r.runId}.tsv`)))
    if (safeRelease) {
      applyRunRetention(r.tracker, r.runId, this.options.config)
      if (removeWorktree) await this.removeTerminalWorktree(r)
    }
    return result
  }

  /**
   * Worktree removal is best-effort cleanup of an already durable, quiescent terminal run, so it runs after the lock is
   * released and never decides the result. Plain `git worktree remove` refuses modified or untracked files (for example
   * evaluator output) and is deliberately never forced: that data stays in the retained worktree, exactly as with
   * `retainWorktrees: true`, and a later terminal replay retries the removal once the worktree is clean.
   */
  private async removeTerminalWorktree(r: Runtime): Promise<void> {
    try { await removeRunWorktree(this.ctx, r.gitExecutable, r.discovery, r.identity, r.gitOptions) }
    catch (error) { if (!(error instanceof GitBoundaryError)) throw error }
  }
}

function normalizedGitReconciliationEvidence(error: GitBoundaryError): readonly string[] {
  const evidence = [error.message, ...error.evidence]
    .map(message => message.trim().replace(/[\0\r\n]+/gu, ' '))
    .filter(message => message.length > 0)
  return evidence.length > 0 ? evidence : ['Git reconciliation failed while restoring the accepted HEAD']
}

/** Every process is quiescent but the accepted HEAD is unproven: keep the run nonterminal and resumable instead of locking it terminally. */
class ResumableControllerFailure extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ResumableControllerFailure'
  }
}

class RejectedReconciliationBlockedError extends Error {
  constructor(readonly code: string, readonly evidence: readonly string[]) {
    super(evidence[0] ?? code)
    this.name = 'RejectedReconciliationBlockedError'
  }
}

function provenanceInput(policy: DurableRunPolicy, policySha256: string, evaluationSha256: string, registration: HostEvaluatorRegistration) { const dataset = registrationDatasetMetadata(registration); return { evaluation: policy.evaluation, evaluatorFiles: registration.evaluatorFiles, metricName: policy.metricName, metricDirection: policy.metricDirection, environment: policy.environment, policy: { normalizedPolicySha256: policySha256, evaluationSha256, policy }, ...(dataset ? { dataset } : {}) } }
function canonicalPolicy(policy: NormalizedRunPolicy, repository: string, runTag: string): DurableRunPolicy { const { resumeRunId: _resume, mode: _mode, ...durable } = policy; return { ...durable, repository, runTag } }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex') }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, sort(v)])); return value }
function normalizedReason(value: string): string { const text = value.trim().replace(/[\0\r\n]+/gu, ' '); return text || 'cancelled' }
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return undefined; try { return JSON.parse(value) } catch { return undefined } }
function artifact(r: Runtime, experimentId: string, attemptId: string, item: { kind: string; location: string; sizeBytes: number; sha256: string; truncated: boolean }): ArtifactRecord { return { artifactId: `${attemptId}-${item.kind}`, runId: r.runId, experimentId, attemptId, kind: item.kind, location: item.location, sizeBytes: item.sizeBytes, sha256: item.sha256, owner: 'evaluator', retention: 'retain', metadata: { truncated: item.truncated } } }
function isFrozenEvaluatorViolation(error: unknown): error is FrozenEvaluatorBoundaryError { return error instanceof FrozenEvaluatorBoundaryError }
/** Raw controller error text is display evidence: scrub exact configured environment values, control characters, and length. */
function controllerFailureMessage(error: unknown, secrets: readonly string[]): string { return boundedFailureMessage(redactConfiguredSecrets(error instanceof Error ? error.message : String(error), secrets)) }
/**
 * Tool and job adapters render only `error.message`, so an aggregate carries each wrapped error's bounded, scrubbed text
 * (for example a Git index.lock cause) in its own message; `errors` and `cause` keep the original objects for callers.
 */
function controllerAggregateError(summary: string, parts: readonly (readonly [label: string, error: unknown])[], secrets: readonly string[]): AggregateError {
  const details = parts.map(([label, error]) => `${label}: ${controllerFailureMessage(error, secrets).slice(0, AGGREGATE_DETAIL_CHARS)}`)
  return new AggregateError(parts.map(([, error]) => error), `${summary} (${details.join('; ')})`, { cause: parts[0]?.[1] })
}
const AGGREGATE_DETAIL_CHARS = 1024
/** Bounds before trimming: a cut at 4096 characters can otherwise end in whitespace or split a surrogate pair, which the result decoder rejects. */
function boundedText(text: string, fallback: string): string { return text.slice(0, 4096).replace(/[\uD800-\uDBFF]$/u, '').trim() || fallback }
function boundedFailureMessage(message: string): string { return boundedText(message.replace(/[\0-\x1f\x7f]+/gu, ' '), 'autoresearch controller failed unexpectedly') }
function boundedMismatchMessage(error: unknown): string { return boundedText(error instanceof Error ? error.message : String(error), 'frozen evaluator files differ from the immutable manifest') }
function experimentFacts(evaluation: RecoveredEvaluation, extra: Record<string, unknown>) { return { ...extra, exitCode: evaluation.exit.exitCode, signal: evaluation.exit.signal, timedOut: evaluation.exit.timedOut } as never }
function optionalBest(tracker: DurableTracker, runId: string): BestResult | undefined { const row = tracker.getRun(runId); return row?.['best_metric'] === null || row?.['best_metric'] === undefined ? undefined : { metric: Number(row['best_metric']), commit: String(row['best_commit']), experimentId: String(row['best_experiment_id']) } }
function durableBest(tracker: DurableTracker, runId: string): BestResult { const best = optionalBest(tracker, runId); if (!best) throw new Error('durable best result is missing'); return best }
const HANDOFF_FAILURE_CODES: Readonly<Record<string, true>> = { spawn: true, timeout: true, cancelled: true, exit: true, signal: true, 'output-limit': true, 'metric-protocol': true, 'provenance-mismatch': true, 'recovery-rerun-exhausted': true }
function mechanicalFailureFacts(code: string, evaluation: RecoveredEvaluation): HostFailureFacts { if (code === 'spawn') return { code, spawn: 'provider-spawn-failed' }; if (code === 'exit') return { code, exitCode: evaluation.exit.exitCode ?? -1 }; if (code === 'signal') return { code, signal: evaluation.exit.signal ?? 'UNKNOWN' }; if (code === 'timeout') return { code, timedOut: true }; if (code === 'output-limit') return { code, output: 'stdout-limit-exceeded' }; if (code === 'metric-protocol') return { code, metricProtocol: 'rejected' }; return { code } }
function counts(tracker: DurableTracker, runId: string): ResultCounts { const candidates = Number(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE run_id = ? AND kind = 'candidate'").get(runId)?.['n'] ?? 0); const completed = Number(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE run_id = ? AND kind = 'candidate' AND state NOT IN ('baseline-pending','running')").get(runId)?.['n'] ?? 0); const attempts = Number(tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?').get(runId)?.['n'] ?? 0); return { experimentsStarted: candidates, experimentsCompleted: completed, attempts } }
interface PublicArtifact { readonly artifactId: string; readonly kind: string; readonly location: string; readonly sizeBytes: number; readonly sha256: string }
function publicArtifact(row: Pick<ArtifactRecord, 'artifactId' | 'kind' | 'location' | 'sizeBytes' | 'sha256'>): PublicArtifact { return { artifactId: row.artifactId, kind: row.kind, location: row.location, sizeBytes: row.sizeBytes, sha256: row.sha256 } }
function artifacts(tracker: DurableTracker, runId: string) { return (tracker.database.prepare(`SELECT a.artifact_id, a.kind, a.location, a.size_bytes, a.sha256 FROM artifacts a LEFT JOIN experiments e ON e.run_id = a.run_id AND e.experiment_id = a.experiment_id LEFT JOIN attempts t ON t.run_id = a.run_id AND t.attempt_id = a.attempt_id WHERE a.run_id = ? ORDER BY COALESCE(e.ordinal, -1), COALESCE(t.ordinal, -1), a.kind, a.artifact_id`).all(runId) as Record<string, unknown>[]).map(row => ({ artifactId: String(row['artifact_id']), kind: String(row['kind']), location: String(row['location']), sizeBytes: Number(row['size_bytes']), sha256: String(row['sha256']) })) }
function common(r: Runtime, validatedArtifacts: readonly PublicArtifact[] = artifacts(r.tracker, r.runId)) { return { runId: r.runId, tracker: r.tracker.path, counts: counts(r.tracker, r.runId), artifacts: validatedArtifacts } }
function errorEvidence(error: unknown): { code: string; message: string } { return { code: error instanceof ProposalAgentError ? error.code : String((error as { code?: unknown }).code ?? 'round-failed'), message: error instanceof Error ? error.message : String(error) } }
const CONTROLLER_FAILURE_OUTCOME = 'controller-failure'
const PROPOSAL_FAILURE_INTENT = 'restore-after-proposal-failure'
interface ProposalFailureEvidence { readonly code: string; readonly message: string }
/**
 * A ready run whose latest round-relevant run checkpoint is a proposal failure's restoration intent has not yet persisted
 * that failure's round-failed verdict. Trailing ready->ready cancellation checkpoints record no round progress (a Host
 * disposal can land while failure recovery retries the restoration), so they are skipped; legacy intents without typed
 * evidence, or any other later checkpoint, return undefined.
 */
function pendingProposalFailure(tracker: DurableTracker, runId: string): ProposalFailureEvidence | undefined {
  const run = tracker.getRun(runId)
  if (run?.['state'] !== 'ready') return undefined
  const rows = tracker.database.prepare("SELECT from_state, to_state, intent_json FROM transitions WHERE run_id = ? AND scope = 'run' ORDER BY sequence DESC").iterate(runId) as Iterable<Record<string, unknown>>
  let record: Record<string, unknown> | undefined
  for (const row of rows) {
    if (row['to_state'] !== 'ready') return undefined
    const intent = parseJson(row['intent_json'])
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return undefined
    const candidate = intent as Record<string, unknown>
    if (candidate['kind'] === 'cancellation' && row['from_state'] === 'ready') continue
    record = candidate
    break
  }
  if (!record) return undefined
  if (record['kind'] !== PROPOSAL_FAILURE_INTENT || Object.keys(record).sort().join(',') !== 'code,commit,kind,message') return undefined
  if (record['commit'] !== run['best_commit'] || typeof record['code'] !== 'string' || !record['code'] || typeof record['message'] !== 'string') return undefined
  return { code: record['code'], message: record['message'] }
}
/** Losing the controller claim is not an owned failure: another controller may be driving the run. */
const CLAIM_LOSS_CODES: ReadonlySet<string> = new Set(['run-controller-claim-lost', 'run-controller-lost'])
/** Typed Git failures keep their machine code by field origin; only the display text is scrubbed and bounded. */
function controllerFailureEvidence(error: unknown, secrets: readonly string[]): BlockerEvidence[] {
  if (error instanceof GitBoundaryError) return normalizedGitReconciliationEvidence(error).map(message => ({ code: error.code, message: boundedFailureMessage(redactConfiguredSecrets(message, secrets)), artifacts: [] }))
  return [{ code: 'controller-failed', message: controllerFailureMessage(error, secrets), artifacts: [] }]
}
/**
 * The complete evidence of a terminalized controller failure lives in its terminal run transition. It is used only when
 * that transition is the run's last one and agrees with the row's authoritative terminal reason; otherwise the row facts
 * alone are returned.
 */
function durableControllerFailureEvidence(tracker: DurableTracker, runId: string, row: Record<string, unknown>): BlockerEvidence[] | undefined {
  const last = tracker.database.prepare("SELECT to_state, outcome_json FROM transitions WHERE run_id = ? AND scope = 'run' ORDER BY sequence DESC LIMIT 1").get(runId)
  if (!last || !['blocked', 'round-failed'].includes(String(row['state'])) || last['to_state'] !== row['state']) return undefined
  const outcome = parseJson(last['outcome_json'])
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return undefined
  const record = outcome as Record<string, unknown>
  if (record['kind'] !== CONTROLLER_FAILURE_OUTCOME || Object.keys(record).sort().join(',') !== 'evidence,kind' || !Array.isArray(record['evidence']) || record['evidence'].length === 0) return undefined
  const evidence: BlockerEvidence[] = []
  for (const item of record['evidence'] as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).sort().join(',') !== 'code,message' || typeof entry['code'] !== 'string' || !entry['code'] || typeof entry['message'] !== 'string' || !entry['message']) return undefined
    evidence.push({ code: entry['code'], message: entry['message'], artifacts: [] })
  }
  return evidence[0]!.message === row['terminal_reason'] ? evidence : undefined
}
/** The ordinal the next candidate would take, computed exactly as recovery's ready directive computes it. */
function nextCandidateOrdinal(tracker: DurableTracker, runId: string): number { return Number(tracker.database.prepare("SELECT COALESCE(MAX(ordinal), 0) AS n FROM experiments WHERE run_id = ? AND kind = 'candidate'").get(runId)?.['n'] ?? 0) + 1 }
/** Any recorded attempt outcome of this run is durable evaluator authority that terminal failure persistence must not overwrite. */
function hasDurableAttemptOutcome(tracker: DurableTracker, runId: string): boolean { return tracker.database.prepare('SELECT 1 FROM attempts WHERE run_id = ? AND (outcome_json IS NOT NULL OR exited_at IS NOT NULL) LIMIT 1').get(runId) !== undefined }
function evidenceFromRun(row: Record<string, unknown>): BlockerEvidence[] { return [{ code: String(row['blocked_code'] ?? 'terminal'), message: String(row['terminal_reason'] ?? 'run terminated'), artifacts: [] }] }
function baselineBlocked(r: Runtime, refs: PublicArtifact[]): Record<string, unknown> {
  const experiment = r.tracker.database.prepare("SELECT experiment_id FROM experiments WHERE run_id = ? AND kind = 'baseline' ORDER BY ordinal LIMIT 1").get(r.runId)
  const experimentId = experiment?.['experiment_id']
  if (typeof experimentId !== 'string' || !experimentId) throw new Error('baseline-blocked run is missing its baseline experiment')
  const attempt = r.tracker.database.prepare('SELECT * FROM attempts WHERE run_id = ? AND experiment_id = ? ORDER BY ordinal DESC LIMIT 1').get(r.runId, experimentId)
  const attemptId = attempt?.['attempt_id']
  if (!attempt || typeof attemptId !== 'string' || !attemptId) throw new Error('baseline-blocked run is missing its baseline attempt')
  return { ...common(r, refs), status: 'baseline-blocked', baselineAttemptId: attemptId, reason: String(attempt['failure_message'] ?? 'baseline evaluation failed'), exit: { exitCode: attempt['exit_code'] === null ? null : Number(attempt['exit_code']), signal: attempt['signal'] === null ? null : String(attempt['signal']), timedOut: attempt['timed_out'] === 1, stdout: refs.find(item => item.kind === 'stdout')!, stderr: refs.find(item => item.kind === 'stderr')! } }
}
function captureAcceptedResumeIdentity(tracker: DurableTracker, runId: string): string {
  const run = tracker.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
  const registration = tracker.database.prepare('SELECT * FROM run_registrations WHERE run_id = ?').get(runId)
  if (!run || !registration) throw new Error('accepted durable resume identity is incomplete')
  return JSON.stringify({ run, registration })
}
function revalidateAcceptedResumeIdentity(tracker: DurableTracker, runId: string, accepted: string): void {
  if (tracker.schemaVersion() !== TRACKER_SCHEMA_VERSION) throw new Error('writable resume tracker did not reach the canonical current schema')
  if (captureAcceptedResumeIdentity(tracker, runId) !== accepted) throw new Error('durable resume identity changed between read-only classification and writable open')
}
function captureTerminalResumeEvidence(tracker: DurableTracker, runId: string): string {
  const run = tracker.getRun(runId)
  if (!run) throw new Error('terminal resume evidence requires a durable run')
  const transitions = tracker.database.prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY sequence').all(runId)
  const experiments = tracker.database.prepare('SELECT * FROM experiments WHERE run_id = ? ORDER BY ordinal, experiment_id').all(runId).map(experiment => ({ annotation_json: null, host_facts_json: null, ...experiment }))
  const attempts = tracker.database.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY experiment_id, ordinal, attempt_id').all(runId)
  const artifacts = tracker.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY experiment_id, attempt_id, kind, artifact_id').all(runId)
  const cancellationOrigin = run['state'] === 'cancelled' ? tracker.cancellationOrigin(runId) : undefined
  return JSON.stringify({ run, transitions, experiments, attempts, artifacts, ...(cancellationOrigin === undefined ? {} : { cancellationOrigin }) })
}
function validateReadOnlyResumeIdentity(row: Record<string, unknown>, discovery: RepositoryDiscovery, identity: RunGitIdentity, policy: DurableRunPolicy, policySha256: string, expectedProvenance?: FrozenEvaluatorProvenance, policyAlreadyRedacted = false): { code: string; message: string } | undefined {
  if (String(row['policy_json']) !== (policyAlreadyRedacted ? serializeRedactedDurablePolicy(policy) : serializeDurablePolicy(policy))) return { code: 'policy-mismatch', message: 'durable policy bytes differ from the accepted policy identity' }
  if (String(row['repository_id']) !== discovery.repositoryId || String(row['repository']) !== discovery.repository || String(row['git_common_dir']) !== discovery.gitCommonDir) return { code: 'repository-mismatch', message: 'canonical repository identity differs from immutable durable identity' }
  if (!/^[0-9a-f]{40}$/u.test(String(row['start_commit']))) return { code: 'start-commit-mismatch', message: 'durable start commit is not a full commit identity' }
  if (String(row['branch']) !== identity.branch || String(row['worktree']) !== identity.worktree || String(row['run_tag']) !== identity.runTag || String(row['run_id']) !== identity.runId) return { code: 'repository-mismatch', message: 'run Git identity differs from immutable durable identity' }
  if (String(row['policy_sha256']) !== policySha256) return { code: 'policy-mismatch', message: 'normalized policy hash differs from durable policy' }
  const provenance = parseJson(row['provenance_json'])
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return { code: 'provenance-mismatch', message: 'durable evaluator provenance identity is malformed or inconsistent' }
  const durableProvenance = provenance as Record<string, unknown>
  if (policyAlreadyRedacted) {
    const semantic = parseJson(durableProvenance.canonical)
    if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) return { code: 'provenance-mismatch', message: 'durable evaluator provenance canonical payload is malformed' }
    const durableSemantic = semantic as Record<string, unknown>
    if (durableSemantic.metricName !== policy.metricName || durableSemantic.metricDirection !== policy.metricDirection) return { code: 'provenance-mismatch', message: 'durable evaluator provenance differs from immutable terminal policy' }
  }
  const provenanceSha256 = String(row['provenance_sha256'])
  if (!/^[0-9a-f]{64}$/u.test(provenanceSha256) || String(durableProvenance.sha256 ?? '') !== provenanceSha256 || typeof durableProvenance.canonical !== 'string' || createHash('sha256').update(durableProvenance.canonical).digest('hex') !== provenanceSha256) return { code: 'provenance-mismatch', message: 'durable evaluator provenance identity is malformed or inconsistent' }
  if (expectedProvenance && (String(row['provenance_json']) !== JSON.stringify(sort(expectedProvenance)) || provenanceSha256 !== expectedProvenance.sha256)) return { code: 'provenance-mismatch', message: 'durable evaluator provenance differs from validated policy, registration, manifest, or dataset identity' }
}

function registrationDatasetMetadata(registration: HostEvaluatorRegistration | DurableRegistrationIdentity['registration']): Readonly<Record<string, string>> | undefined {
  const dataset = registration.dataset
  if (dataset.kind === 'none') return undefined
  if (dataset.kind === 'external') return { kind: 'external', digest: dataset.digest, ...(dataset.identity ? { identity: dataset.identity } : {}) }
  return { kind: 'local', files: dataset.files.join('\n'), ...(dataset.identity ? { identity: dataset.identity } : {}) }
}
function decodeDurablePolicy(value: unknown): DurableRunPolicy {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('durable run policy is malformed')
  return parsed as DurableRunPolicy
}
function isTerminalState(state: RunDurableState): boolean { return ['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(state) }
function registrationBlockedRuntime(tracker: DurableTracker, runId: string, policy: DurableRunPolicy, discovery: RepositoryDiscovery, identity: RunGitIdentity, gitExecutable: string, gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>, code: string, message: string): Runtime {
  return { runId, policy, discovery, identity, tracker, gitExecutable, policySha256: String(tracker.getRun(runId)?.['policy_sha256'] ?? ''), provenanceSha256: String(tracker.getRun(runId)?.['provenance_sha256'] ?? ''), gitOptions, preclaimBlock: { code, message } }
}
function readonlyBlockedResult(r: Runtime, code: string, message: string): AutoresearchRunResult {
  const best = optionalBest(r.tracker, r.runId)
  const value = best ? { ...common(r), status: 'blocked', best, evidence: [{ code, message, artifacts: [] }] } : { ...common(r), status: 'round-failed', reason: message, evidence: [{ code, message, artifacts: [] }] }
  return decodeRunResult(value, r.policy.metricDirection)
}
function readonlyTerminalReplay(r: Runtime, directive: Extract<RecoveryDirective, { kind: 'terminal' }>): AutoresearchRunResult {
  const row = r.tracker.getRun(r.runId)!
  const state = String(row['state']) as RunDurableState
  if (!isTerminalState(state) || directive.state !== state) throw new Error(`terminal replay requires matching terminal durable state, received ${state}`)
  const refs = directive.artifacts.map(publicArtifact)
  const best = optionalBest(r.tracker, r.runId)
  let value: Record<string, unknown>
  if (state === 'completed') value = { ...common(r, refs), status: r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? 'target-reached' : 'budget-limited', ...(r.policy.target !== undefined && best && isTargetReached(r.policy.metricDirection, best.metric, r.policy.target) ? { target: r.policy.target } : {}), best }
  else if (state === 'baseline-blocked') value = baselineBlocked(r, refs)
  else if (state === 'cancelled' && directive.state === 'cancelled') value = cancelledResult(r, directive.lastState, refs)
  // Exactly as the claimed replay (returnTerminal) does, so a contended claim never changes the replayed evidence.
  else if (state === 'blocked' && best) value = { ...common(r, refs), status: 'blocked', best, evidence: durableControllerFailureEvidence(r.tracker, r.runId, row) ?? evidenceFromRun(row) }
  else value = { ...common(r, refs), status: 'round-failed', reason: String(row['terminal_reason'] ?? state), evidence: durableControllerFailureEvidence(r.tracker, r.runId, row) ?? evidenceFromRun(row), ...(best ? { best } : {}) }
  return decodeRunResult(value, r.policy.metricDirection)
}

function cancelledResult(r: Runtime, lastState: Exclude<RunDurableState, 'cancelled'>, artifacts: readonly PublicArtifact[]): Record<string, unknown> {
  const row = r.tracker.getRun(r.runId)!
  const best = optionalBest(r.tracker, r.runId)
  return { ...common(r, artifacts), status: 'cancelled', lastState, reason: String(row['terminal_reason'] ?? 'cancelled'), quiescent: true, ...(best ? { best } : {}) }
}
