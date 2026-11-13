import type { Disposable } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { AutoresearchExperimentResult, AutoresearchRunResult, AutoresearchToolResult } from './types.js'

const TRUNCATION_NOTICE = '\n… [truncated]'

type SuccessfulRunResult = Extract<AutoresearchRunResult, { status: 'budget-limited' | 'target-reached' }>

export interface SuccessfulJobOutput {
  readonly state: { jobId: string; success?: { text: string; status: SuccessfulRunResult['status'] } }
  readonly dispose: Disposable
}

/** Detail budget only: the exact mandatory success envelope is never sliced. */
export function serializeSuccessfulRunResult(result: SuccessfulRunResult, maxChars: number): string {
  const full = JSON.stringify(result)
  if (full.length <= maxChars) return full
  return JSON.stringify({
    status: result.status,
    runId: result.runId,
    tracker: result.tracker,
    best: result.best,
    counts: result.counts,
    ...(result.status === 'target-reached' ? { target: result.target } : {}),
    detailsOmitted: true,
  })
}

/** Owner-lived presentation only; never retains the controller or canonical result. */
export function retainSuccessfulJobOutput(owner: Agent, maxBytes: number): SuccessfulJobOutput {
  const state: SuccessfulJobOutput['state'] = { jobId: '' }
  // Append: enclosing Host policies must evaluate the proposed two-block shape.
  const dispose = owner.ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'job_output' || exec.agent !== owner || !state.jobId) return next()
    const args = exec.arguments
    if (!args || typeof args !== 'object' || !('job_id' in args) || args.job_id !== state.jobId) return next()
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content')
      || result.isError || exec.signal.aborted || !state.success) return decision
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value) || value['text'] !== state.success.text) return decision
    const job = value['job']
    if (!job || typeof job !== 'object' || Array.isArray(job) || job['id'] !== state.jobId
      || job['kind'] !== 'autoresearch' || job['status'] !== 'completed' || job['detail'] !== state.success.status) return decision
    const { text, status } = state.success
    const suffix = `\n[status: completed, ${status}]`
    const [block] = result.content
    if (result.content.length !== 1 || block?.type !== 'text' || block.text !== text + suffix) return decision
    // Subtract the actual suffix bytes, avoiding unsafe cap arithmetic at MAX_SAFE_INTEGER.
    if (Buffer.byteLength(text, 'utf8') <= maxBytes - Buffer.byteLength(suffix, 'utf8')) return decision
    return {
      kind: 'accept',
      content: [{ type: 'text', text }, { type: 'text', text: suffix }],
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
    }
  })
  return { state, dispose }
}

export function boundText(text: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive safe integer')
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

export function renderRunResult(result: AutoresearchRunResult, maxChars: number): string {
  const lines = [`Autoresearch run ${result.runId}: ${result.status}`, `Tracker: ${result.tracker}`]
  if ('best' in result && result.best !== undefined) {
    lines.push(`Best: ${result.best.metric} at ${result.best.commit} (${result.best.experimentId})`)
  }
  lines.push(`Experiments: ${result.counts.experimentsCompleted}/${result.counts.experimentsStarted}; attempts: ${result.counts.attempts}`)
  if ('reason' in result) lines.push(`Reason: ${result.reason}`)
  if (result.status === 'target-reached') lines.push(`Target: ${result.target}`)
  if (result.status === 'blocked' || result.status === 'round-failed') {
    lines.push(`Evidence: ${result.evidence.map((item) => `${item.code}: ${item.message}`).join('; ') || '(none)'}`)
  }
  if (result.artifacts.length > 0) lines.push(`Artifacts: ${result.artifacts.map((item) => item.artifactId).join(', ')}`)
  return boundText(lines.join('\n'), maxChars)
}

export function renderExperimentResult(result: AutoresearchExperimentResult, maxChars: number): string {
  const lines = [`Experiment ${result.experimentId}: ${result.kind}`, `Parent: ${result.parentCommit}`, `Attempt: ${result.attemptId}`]
  if ('metric' in result) lines.push(`Metric: ${result.metric}`)
  if ('candidateCommit' in result && result.candidateCommit !== undefined) lines.push(`Candidate: ${result.candidateCommit}`)
  if ('reason' in result) lines.push(`Reason: ${result.reason}`)
  return boundText(lines.join('\n'), maxChars)
}

export function renderToolResult(result: AutoresearchToolResult, maxChars: number): string {
  if (result.kind === 'background') {
    return boundText(`Started autoresearch run ${result.runId} as job ${result.jobId}.\nTracker: ${result.tracker}\nBranch: ${result.branch}\nWorktree: ${result.worktree}`, maxChars)
  }
  if (result.kind === 'background-start-failed') {
    return boundText(`Autoresearch background startup ${result.status} for job ${result.jobId}: ${result.reason}`, maxChars)
  }
  return renderRunResult(result.run, maxChars)
}
