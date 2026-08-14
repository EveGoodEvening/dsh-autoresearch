import type { AutoresearchExperimentResult, AutoresearchRunResult, AutoresearchToolResult } from './types.js'

const TRUNCATION_NOTICE = '\n… [truncated]'

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
