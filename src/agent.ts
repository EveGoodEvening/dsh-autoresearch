import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.js'
import { captureGitConfigBaseline, type GitCommandOptions, type GitConfigBaseline } from './git.js'
import type {
  BestResult,
  ExperimentDurableState,
  ExperimentId,
  FullCommitSha,
  NormalizedRunPolicy,
  RunId,
} from './types.js'

export const PROPOSAL_REPORT_TOOL = 'autoresearch_report' as const
export const PROPOSAL_INHERITED_TOOLS = ['read', 'write', 'edit', 'glob', 'grep'] as const

export type ProposalAgentErrorCode =
  | 'route-unavailable' | 'capability-unavailable' | 'handoff-too-large' | 'cancelled'
  | 'report-missing' | 'report-duplicate' | 'report-malformed' | 'report-stale'
  | 'report-wrong-experiment' | 'report-too-large' | 'not-quiescent' | 'dispose-failed'

export class ProposalAgentError extends Error {
  constructor(readonly code: ProposalAgentErrorCode, message: string, readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProposalAgentError'
  }
}

export interface ProposalHistoryEntry {
  readonly ordinal: number
  readonly experimentId: ExperimentId
  readonly state: ExperimentDurableState
  readonly candidateCommit?: FullCommitSha
  readonly metric?: number
  readonly decision?: 'accept' | 'reject'
  readonly failureCode?: string
}

export interface ProposalWorkspaceFacts {
  readonly repositoryId: string
  readonly branch: string
  readonly worktree: string
  readonly startCommit: FullCommitSha
  readonly acceptedCommit: FullCommitSha
}

export interface ProposalAgentRequest {
  readonly parent: Agent
  readonly runId: RunId
  readonly experimentId: ExperimentId
  readonly ordinal: number
  readonly workspace: ProposalWorkspaceFacts
  readonly policy: NormalizedRunPolicy
  readonly policySha256: string
  readonly provenanceSha256: string
  readonly best: BestResult
  readonly history: readonly ProposalHistoryEntry[]
  readonly config: Pick<ResolvedConfig, 'provider' | 'model' | 'maxTokens' | 'maxHandoffChars'>
  readonly gitExecutable: string
  readonly gitOptions: Omit<GitCommandOptions, 'cwd' | 'signal'>
  readonly persistTrustedGitConfig: (baseline: GitConfigBaseline) => void
  readonly signal: AbortSignal
}

export interface ProposalAgentResult {
  readonly hypothesis: string
  readonly intendedEdits: readonly string[]
  readonly implementationSummary: string
  readonly blockerClaim: string | null
}

interface WireReport extends ProposalAgentResult {
  readonly runId: string
  readonly experimentId: string
  readonly ordinal: number
  readonly nonce: string
}

const REPORT_SCHEMA: JsonSchemaNode & Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'experimentId', 'ordinal', 'nonce', 'hypothesis', 'intendedEdits', 'implementationSummary', 'blockerClaim'],
  properties: {
    runId: { type: 'string' },
    experimentId: { type: 'string' },
    ordinal: { type: 'integer' },
    nonce: { type: 'string' },
    hypothesis: { type: 'string' },
    intendedEdits: { type: 'array', items: { type: 'string' } },
    implementationSummary: { type: 'string' },
    blockerClaim: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
}

const REPORT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object', additionalProperties: false, required: ['accepted'], properties: { accepted: { type: 'boolean' } },
}

function fail(code: ProposalAgentErrorCode, message: string, cause?: unknown): ProposalAgentError {
  return new ProposalAgentError(code, message, cause)
}

function normalizedText(value: string, label: string): string {
  if (value !== value.trim() || value.length === 0 || /[\0\r]/u.test(value)) throw fail('report-malformed', `${label} must be normalized non-empty text`)
  return value
}

function decodeReport(value: unknown, request: ProposalAgentRequest, nonce: string, maxChars: number): WireReport {
  let serialized: string
  try { serialized = JSON.stringify(value) } catch (error) { throw fail('report-malformed', 'Proposal report must be JSON serializable', error) }
  if (serialized.length > maxChars) throw fail('report-too-large', `Proposal report exceeds ${maxChars} serialized characters`)
  const violations = validateJsonSchemaValue(REPORT_SCHEMA, value, '')
  if (violations.length > 0) throw fail('report-malformed', `Malformed proposal report: ${violations.join('; ')}`)
  const report = value as WireReport
  if (report.nonce !== nonce || report.runId !== request.runId) throw fail('report-stale', 'Proposal report does not belong to this run and nonce')
  if (report.experimentId !== request.experimentId || report.ordinal !== request.ordinal) throw fail('report-wrong-experiment', 'Proposal report does not belong to this experiment ordinal')
  normalizedText(report.hypothesis, 'hypothesis')
  normalizedText(report.implementationSummary, 'implementationSummary')
  for (const [index, path] of report.intendedEdits.entries()) normalizedText(path, `intendedEdits[${index}]`)
  if (report.blockerClaim !== null) normalizedText(report.blockerClaim, 'blockerClaim')
  return report
}

function buildPrompt(request: ProposalAgentRequest, nonce: string): string {
  const handoff = {
    task: 'Propose and implement exactly one bounded candidate in the isolated worktree, then call autoresearch_report exactly once.',
    identity: { runId: request.runId, experimentId: request.experimentId, ordinal: request.ordinal, nonce },
    workspace: request.workspace,
    policySha256: request.policySha256,
    provenanceSha256: request.provenanceSha256,
    objective: request.policy.objective,
    mutableFiles: request.policy.mutableGlobs,
    constraints: request.policy.constraints,
    best: request.best,
    history: request.history,
    reportContract: 'Report only hypothesis, intended edits, implementation summary, and an optional blocker claim. Never report metrics, status, commands, Git identities, decisions, acceptance, targets, or budgets.',
  }
  const json = JSON.stringify(handoff)
  if (json.length > request.config.maxHandoffChars) throw fail('handoff-too-large', `Proposal handoff exceeds ${request.config.maxHandoffChars} serialized characters`)
  return `AUTORESEARCH PROPOSAL ROUND\n\n${json}`
}

function resolvedRoute(request: ProposalAgentRequest, childDepth: number): AgentOptions {
  const requested: AgentOptions = {
    ...(request.config.provider === undefined ? {} : { provider: request.config.provider }),
    ...(request.config.model === undefined ? {} : { model: request.config.model }),
    ...(request.config.maxTokens === undefined ? {} : { maxTokens: request.config.maxTokens }),
  }
  const options = resolveChildAgentOptions(request.parent, requested, childDepth)
  if (options.provider === undefined || options.model === undefined) throw fail('route-unavailable', 'Proposal agent requires an explicit provider and model route')
  return options
}

function reportTool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: PROPOSAL_REPORT_TOOL,
    description: 'Submit the single authoritative proposal report for this round. Call exactly once, after all edits are complete.',
    parameters: REPORT_SCHEMA,
    output: {
      schema: REPORT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value !== null && 'accepted' in value && value.accepted === true ? 'Proposal report accepted.' : 'Proposal report rejected.' }],
    },
    execute,
  }
}

/** Create, drive, drain, and dispose one isolated proposal child. */
export async function requestProposal(ctx: Context, request: ProposalAgentRequest): Promise<ProposalAgentResult> {
  if (request.parent.ctx !== ctx) throw fail('capability-unavailable', 'Proposal parent and controller must share one authoritative Context')
  // These delegation inputs belong to this call even if the parent changes while Git is inspected.
  const childDepth = resolveChildDepth(request.parent, undefined)
  const delegatedPolicy = captureDelegatedPolicyOverrides(request.parent)
  const agentOptions = resolvedRoute(request, childDepth)
  const meta = { ...childSessionMeta(request.parent, childDepth, 0), cwd: request.workspace.worktree }
  const nonce = randomUUID()
  const sessionId = SessionId(randomUUID())
  const prompt = buildPrompt(request, nonce)
  if (request.signal.aborted) throw fail('cancelled', 'Proposal request was cancelled before child creation', request.signal.reason)

  const baseline = await captureGitConfigBaseline(ctx, request.gitExecutable, request.workspace.worktree, request.policy, request.gitOptions)
  request.persistTrustedGitConfig(baseline)
  if (request.signal.aborted) throw fail('cancelled', 'Proposal request was cancelled before child publication', request.signal.reason)

  let handle: AgentHandle | undefined
  let disposePromise: Promise<void> | undefined
  let terminal = false
  let reportCalls = 0
  let pendingReport: WireReport | undefined
  let committedReport: WireReport | undefined
  let reportError: ProposalAgentError | undefined

  const dispose = (): Promise<void> => {
    if (handle === undefined) return Promise.resolve()
    disposePromise ??= handle.dispose()
    return disposePromise
  }

  const releaseOwner = ctx.effect(() => async () => {
    handle?.agent.cancel({ kind: 'parent' })
    await dispose()
  }, 'autoresearch.proposalChild()')

  const abort = (): void => {
    handle?.agent.cancel({ kind: 'parent' })
    void dispose().catch(() => undefined)
  }
  request.signal.addEventListener('abort', abort, { once: true })

  let operationError: unknown
  try {
    handle = await ctx.agents.create({
      sessionId,
      meta,
      agentOptions,
      signal: request.signal,
      setup(childCtx) {
        const child = childCtx.agent
        if (child === undefined) throw fail('capability-unavailable', 'Unpublished child Agent is unavailable during setup')
        appendDelegatedPolicyOverrides(child.session, delegatedPolicy)
        applyChildComposition(childCtx, request.parent, { toolFilter: { allow: PROPOSAL_INHERITED_TOOLS } })
        childCtx.tools.presentAs('native')
        childCtx.tools.register(reportTool(async (args, exec) => {
          reportCalls += 1
          if (reportCalls !== 1) {
            reportError = fail('report-duplicate', 'Proposal report tool may execute exactly once')
            terminal = true
            throw reportError
          }
          try { pendingReport = decodeReport(args, request, nonce, request.config.maxHandoffChars) }
          catch (error) { reportError = error instanceof ProposalAgentError ? error : fail('report-malformed', 'Proposal report validation failed', error); terminal = true; throw reportError }
          terminal = true
          exec.concludeTurn()
          return { accepted: true }
        }))
        childCtx.systemPrompt.section({
          name: 'tool:autoresearch_report',
          order: 190,
          text: 'After completing all permitted edits, call autoresearch_report exactly once. Its identity fields must exactly match the AUTORESEARCH PROPOSAL ROUND handoff. The tool call is terminal; do no work after it.',
        })
        childCtx.tools.guard((execution) => {
          if (!terminal) return undefined
          if (execution.name === PROPOSAL_REPORT_TOOL) reportError = fail('report-duplicate', 'Proposal report tool may execute exactly once')
          return `Proposal round is terminal; ${execution.name} cannot run after autoresearch_report`
        })
        childCtx.on('tools/result', (execution, result: Readonly<ToolExecutionResult>) => {
          if (execution.name !== PROPOSAL_REPORT_TOOL) return
          if (!result.isError && pendingReport !== undefined && reportCalls === 1) committedReport = pendingReport
        })
      },
    })

    if (request.signal.aborted) {
      handle.agent.cancel({ kind: 'parent' })
      throw fail('cancelled', 'Proposal request was cancelled after child publication', request.signal.reason)
    }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-autoresearch' } }))
    await handle.agent.whenIdle()
    if (request.signal.aborted) throw fail('cancelled', 'Proposal request was cancelled', request.signal.reason)
    if (reportError !== undefined) throw reportError
    if (reportCalls === 0 || committedReport === undefined) throw fail('report-missing', 'Proposal agent reached idle without one authoritative report')
    if (reportCalls !== 1) throw fail('report-duplicate', 'Proposal agent submitted more than one report')
  } catch (error) {
    operationError = request.signal.aborted && !(error instanceof ProposalAgentError)
      ? fail('cancelled', 'Proposal request was cancelled', error)
      : error
  } finally {
    request.signal.removeEventListener('abort', abort)
    try { await releaseOwner() } catch (error) { operationError = fail('dispose-failed', 'Proposal child disposal failed', error) }
  }

  if (handle !== undefined) {
    if (ctx.agents.get(sessionId) !== undefined) throw fail('not-quiescent', 'Disposed proposal child remains registered')
    const liveJobs = ctx.jobs.list(handle.agent).filter((job: JobSnapshot) => job.status === 'running' || job.status === 'stopping')
    if (liveJobs.length > 0) throw fail('not-quiescent', 'Disposed proposal child retains nonterminal jobs')
  }
  if (operationError !== undefined) throw operationError
  const report = committedReport!
  return {
    hypothesis: report.hypothesis,
    intendedEdits: [...report.intendedEdits],
    implementationSummary: report.implementationSummary,
    blockerClaim: report.blockerClaim,
  }
}
