import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig as resolveDeploymentConfig } from './config.js'
import type { Config as AutoresearchConfig } from './config.js'
export { Config, DEFAULT_CONFIG, normalizeRunPolicy } from './config.js'
export { boundText, renderExperimentResult, renderRunResult, renderToolResult } from './render.js'
export { AUTORESEARCH_TOOL_OUTPUT_SCHEMA, AUTORESEARCH_TOOL_PARAMETERS, decodeExperimentResult, decodeRunResult, isTargetReached } from './types.js'
export type * from './types.js'
export type { Config as AutoresearchConfig, ResolvedConfig as AutoresearchResolvedConfig } from './config.js'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolCallView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    autoresearch: 'autoresearch'
  }
}

export const name = 'autoresearch'
export const inject = ['jobs', 'subagents', 'systemPrompt', 'tools', 'workflowEngine']


interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxExperiments: number
  readonly maxHandoffChars: number
  readonly maxResultChars: number
  readonly resultsFile: string
  readonly branchPrefix: string
}

type MetricDirection = 'minimize' | 'maximize'
type ExperimentStatus = 'baseline' | 'keep' | 'discard' | 'crash' | 'blocked'
type RunStatus = 'target-reached' | 'budget-limited' | 'blocked'

interface ExperimentReport {
  readonly status: ExperimentStatus
  readonly metric: number | null
  readonly experimentCommit: string
  readonly headCommit: string
  readonly summary: string
  readonly evidence: string[]
  readonly nextIdea: string
  readonly blocker: string
}
interface SuccessfulRunResult {
  readonly status: RunStatus
  readonly experimentsStarted: number
  readonly bestMetric: number | null
  readonly bestCommit: string
  readonly lastReport: ExperimentReport
}

interface FailedRoundResult {
  readonly status: 'round-failed'
  readonly experimentsStarted: number
  readonly bestMetric: number | null
  readonly bestCommit: string
  readonly lastReport: ExperimentReport | null
}

type AutoresearchRunResult = SuccessfulRunResult | FailedRoundResult

interface ToolArgs {
  objective: string
  run_tag: string
  mutable_files: string[]
  evaluation_command: string
  metric_name: string
  metric_direction: MetricDirection
  experiment_timeout_minutes: number
  constraints?: string[]
  max_experiments?: number
  target_metric?: number
  run_in_background?: boolean
}

interface RunSpec {
  readonly objective: string
  readonly runTag: string
  readonly mutableFiles: string[]
  readonly evaluationCommand: string
  readonly metricName: string
  readonly metricDirection: MetricDirection
  readonly experimentTimeoutMinutes: number
  readonly constraints: string[]
  readonly maxExperiments: number
  readonly targetMetric?: number
  readonly resultsFile: string
  readonly branchPrefix: string
  readonly maxHandoffChars: number
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['baseline', 'keep', 'discard', 'crash', 'blocked'] },
    metric: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    experimentCommit: { type: 'string' },
    headCommit: { type: 'string' },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextIdea: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: [
    'status',
    'metric',
    'experimentCommit',
    'headCommit',
    'summary',
    'evidence',
    'nextIdea',
    'blocker',
  ],
  additionalProperties: false,
} as const

const AUTORESEARCH_META = {
  name: 'autoresearch',
  description: 'Run baseline-first metric-driven experiments with fresh agents and a shared Git workspace.',
  phases: [{ title: 'Experiments', detail: 'One isolated research worker per measured experiment.' }],
}

const AUTORESEARCH_SCRIPT = String.raw`
const reportSchema = args.reportSchema

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedOptionalText(value) {
  return typeof value === 'string' && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function improves(candidate, best) {
  return args.metricDirection === 'minimize' ? candidate < best : candidate > best
}

function targetReached(metric) {
  if (args.targetMetric === null) return false
  return args.metricDirection === 'minimize' ? metric <= args.targetMetric : metric >= args.targetMetric
}

function validateReport(report, experiment, previousBestMetric, previousBestCommit) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('autoresearch worker returned no structured experiment report')
  }
  if (!normalizedText(report.summary) || !normalizedList(report.evidence) || report.evidence.length === 0
    || !normalizedOptionalText(report.nextIdea) || !normalizedOptionalText(report.blocker)
    || !normalizedText(report.experimentCommit) || !normalizedText(report.headCommit)) {
    throw new Error('autoresearch worker returned malformed normalized report fields')
  }
  if (JSON.stringify(report).length > args.maxHandoffChars) {
    throw new Error('autoresearch report exceeds maxHandoffChars')
  }
  if (report.status === 'blocked' ? report.nextIdea !== '' : !normalizedText(report.nextIdea)) {
    throw new Error('autoresearch nextIdea must be empty only for blocked reports')
  }
  if (experiment === 1) {
    const baseline = report.status === 'baseline' && typeof report.metric === 'number'
      && report.experimentCommit === report.headCommit && report.blocker === ''
    const blocked = report.status === 'blocked' && report.metric === null
      && report.experimentCommit === report.headCommit && normalizedText(report.blocker)
    if (!baseline && !blocked) {
      throw new Error('the first autoresearch report must be a baseline or a concrete pre-baseline blocker')
    }
    return report
  }
  switch (report.status) {
    case 'baseline':
      throw new Error('baseline status is valid only for experiment 1')
    case 'keep':
      if (typeof report.metric !== 'number' || !improves(report.metric, previousBestMetric)
        || report.headCommit !== report.experimentCommit || report.blocker !== '') {
        throw new Error('kept experiment did not strictly improve the metric or preserve its commit')
      }
      break
    case 'discard':
      if (typeof report.metric !== 'number' || improves(report.metric, previousBestMetric)
        || report.headCommit !== previousBestCommit || report.blocker !== '') {
        throw new Error('discarded experiment improved or did not restore the best commit')
      }
      break
    case 'crash':
      if (report.metric !== null || report.headCommit !== previousBestCommit || report.blocker !== '') {
        throw new Error('crashed experiment must restore the best commit and report a null metric')
      }
      break
    case 'blocked':
      if (report.metric !== null || report.headCommit !== previousBestCommit || !normalizedText(report.blocker)) {
        throw new Error('blocked experiment must preserve the best commit and name a blocker')
      }
      break
    default:
      throw new Error('autoresearch worker returned an unknown status')
  }
  return report
}

let previous
let bestMetric = null
let bestCommit = ''
phase('Experiments')
for (let experiment = 1; experiment <= args.maxExperiments; experiment += 1) {
  const previousBestMetric = bestMetric
  const previousBestCommit = bestCommit
  const prior = previous === undefined ? '(none — establish the baseline)' : JSON.stringify(previous)
  const constraints = args.constraints.length === 0 ? '(none)' : args.constraints.map((item) => '- ' + item).join('\n')
  const prompt = [
    'You are experiment worker ' + experiment + ' of ' + args.maxExperiments + ' in a bounded autoresearch run. You receive no parent conversation or prior child session. Do not call autoresearch: this worker is already inside that loop.',
    'Immutable research objective:\n' + args.objective,
    'Research branch: ' + args.branchPrefix + args.runTag + '.',
    'Only these files or globs may be intentionally modified:\n' + args.mutableFiles.map((item) => '- ' + item).join('\n'),
    'Evaluation command (run exactly this command):\n' + args.evaluationCommand,
    'Metric: ' + args.metricName + ' (' + args.metricDirection + '). The evaluation command has a hard wall-clock ceiling of ' + args.experimentTimeoutMinutes + ' minutes. Kill an overrun and treat it as a crash.',
    'Durable ledger: ' + args.resultsFile + '. It is TSV, remains uncommitted, and has columns experiment, commit, metric, status, description. Keep command output in an uncommitted log beside it or another ignored path.',
    'Additional constraints:\n' + constraints,
    'The shared Git workspace is the source of truth. Inspect it before acting. The previous report is only a bounded handoff; verify branch, HEAD, ledger, and allowed-file state yourself. Preserve user work outside the research branch and allowed files.',
    experiment === 1
      ? 'Baseline protocol: require a clean research surface except the configured untracked ledger/log artifacts; fail blocked if the branch already exists or unrelated changes make a fresh run unsafe. Create the fresh branch from current HEAD, initialize the TSV header, run the unmodified evaluation, append the baseline row, and do not create a baseline-only commit.'
      : 'Experiment protocol: begin at best commit ' + previousBestCommit + ' with best metric ' + previousBestMetric + '. Form one concrete hypothesis, modify only allowed files, commit the candidate before evaluation, run the exact evaluation command under the hard timeout, parse the named scalar metric, and append one TSV row. Keep the commit only for a strict improvement; otherwise reset the branch to the previous best commit while leaving the TSV/log uncommitted. A simple deletion with equal behavior is not a metric improvement: record discard unless the objective explicitly defines a secondary simplicity criterion.',
    'Previous structured handoff:\n' + prior,
    'Return the exact structured report. experimentCommit is the measured candidate commit; headCommit is HEAD after keep/reset. baseline requires a numeric metric and matching commits. keep requires strict improvement. discard requires a numeric non-improvement and restored best HEAD. crash uses null metric and restored best HEAD. blocked is only for a concrete condition that prevents safe progress, uses null metric, preserves best HEAD, and names the blocker. evidence must cite observed command/Git/metric facts. nextIdea is empty only when blocked.',
  ].join('\n\n')
  const raw = await agent(prompt, {
    label: 'Autoresearch experiment ' + experiment,
    phase: 'Experiments',
    schema: reportSchema,
  })
  if (raw === null) {
    return {
      status: 'round-failed',
      experimentsStarted: experiment,
      bestMetric,
      bestCommit,
      lastReport: previous ?? null,
    }
  }
  const report = validateReport(raw, experiment, previousBestMetric, previousBestCommit)
  previous = report
  if (report.status === 'blocked') {
    if (experiment === 1) bestCommit = report.headCommit
    return {
      status: 'blocked',
      experimentsStarted: experiment,
      bestMetric,
      bestCommit,
      lastReport: report,
    }
  }
  if (experiment === 1 || report.status === 'keep') {
    bestMetric = report.metric
    bestCommit = report.headCommit
  }
  if (targetReached(bestMetric)) {
    return {
      status: 'target-reached',
      experimentsStarted: experiment,
      bestMetric,
      bestCommit,
      lastReport: report,
    }
  }
}
return {
  status: 'budget-limited',
  experimentsStarted: args.maxExperiments,
  bestMetric,
  bestCommit,
  lastReport: previous,
}
`

const DESCRIPTION = 'Start a Karpathy-style autoresearch loop for one explicit metric-driven research task. '
  + 'The loop establishes a baseline, gives each measured experiment to a fresh child agent, uses Git and an uncommitted TSV ledger as durable memory, keeps only strict metric improvements, and continues until its experiment cap, target metric, or concrete blocker. '
  + 'Run in the background by default and monitor with job_output/job_list; use foreground only when the next action needs the terminal result.'

const GUIDANCE = 'Use autoresearch ONLY when the direct human explicitly asks for autonomous metric-driven experimentation. '
  + 'Require one scalar metric, one exact evaluation command, a narrow mutable file set, and a fresh run tag. '
  + 'It runs in the background by default; use job tools to inspect or stop it. Do not use it for ordinary coding, open-ended research without an executable metric, or changes that cannot be safely isolated on a Git branch.'

function normalizedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

function relativeResearchPath(value: unknown, label: string): string {
  const path = normalizedText(value, label)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(path)
    || path.split(/[\\/]/u).includes('..') || /[\r\n\0]/u.test(path)) {
    throw new TypeError(`${label} must be a normalized relative path without parent traversal`)
  }
  return path
}

function resolveConfig(config: AutoresearchConfig): ResolvedConfig {
  const deployment = resolveDeploymentConfig(config)
  return {
    subagentProvider: normalizedText(config.subagentProvider ?? 'spawn', 'subagentProvider'),
    maxExperiments: deployment.maxExperiments,
    maxHandoffChars: deployment.maxHandoffChars,
    maxResultChars: deployment.maxResultChars,
    resultsFile: relativeResearchPath(config.resultsFile ?? 'autoresearch-results.tsv', 'resultsFile'),
    branchPrefix: deployment.branchPrefix,
  }
}

function requireFreshProvider(ctx: Context, providerName: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`autoresearch subagent provider "${providerName}" is not registered`)
  if (!provider.capabilities.outputSchema) {
    throw new Error(`autoresearch subagent provider "${providerName}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`autoresearch subagent provider "${providerName}" inherits parent context; a fresh provider is required`)
  }
  return provider
}

function resolveRunSpec(args: ToolArgs, config: ResolvedConfig): RunSpec {
  const objective = normalizedText(args.objective, 'objective')
  const runTag = normalizedText(args.run_tag, 'run_tag')
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(runTag) || runTag.endsWith('.') || runTag.includes('..')) {
    throw new TypeError('run_tag must be lower-case Git-safe text without slashes')
  }
  if (!Array.isArray(args.mutable_files) || args.mutable_files.length === 0) {
    throw new TypeError('mutable_files must contain at least one relative file or glob')
  }
  const mutableFiles = [...new Set(args.mutable_files.map((value, index) =>
    relativeResearchPath(value, `mutable_files[${index}]`)))]
  const evaluationCommand = normalizedText(args.evaluation_command, 'evaluation_command')
  if (/[\r\n\0]/u.test(evaluationCommand)) {
    throw new TypeError('evaluation_command must be one normalized shell command line')
  }
  const metricName = normalizedText(args.metric_name, 'metric_name')
  if (args.metric_direction !== 'minimize' && args.metric_direction !== 'maximize') {
    throw new TypeError('metric_direction must be minimize or maximize')
  }
  const experimentTimeoutMinutes = positiveSafeInteger(
    args.experiment_timeout_minutes,
    'experiment_timeout_minutes',
  )
  const constraints = (args.constraints ?? []).map((value, index) => normalizedText(value, `constraints[${index}]`))
  const maxExperiments = args.max_experiments === undefined
    ? config.maxExperiments
    : positiveSafeInteger(args.max_experiments, 'max_experiments')
  if (maxExperiments > config.maxExperiments) {
    throw new TypeError(`max_experiments ${maxExperiments} exceeds the deployment ceiling ${config.maxExperiments}`)
  }
  if (args.target_metric !== undefined && !Number.isFinite(args.target_metric)) {
    throw new TypeError('target_metric must be finite when supplied')
  }
  return {
    objective,
    runTag,
    mutableFiles,
    evaluationCommand,
    metricName,
    metricDirection: args.metric_direction,
    experimentTimeoutMinutes,
    constraints,
    maxExperiments,
    ...args.target_metric === undefined ? {} : { targetMetric: args.target_metric },
    resultsFile: config.resultsFile,
    branchPrefix: config.branchPrefix,
    maxHandoffChars: config.maxHandoffChars,
  }
}


function readNormalizedString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value !== value.trim() || (!allowEmpty && value.length === 0)) {
    throw new Error(`autoresearch workflow returned invalid ${label}`)
  }
  return value
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`autoresearch workflow returned invalid ${label}`)
  return value.map((item, index) => readNormalizedString(item, `${label}[${index}]`))
}

function readReport(value: unknown, maxChars: number): ExperimentReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('autoresearch workflow returned a malformed experiment report')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'blocker,evidence,experimentCommit,headCommit,metric,nextIdea,status,summary') {
    throw new Error('autoresearch workflow returned a malformed experiment report')
  }
  const status = record['status']
  if (status !== 'baseline' && status !== 'keep' && status !== 'discard'
    && status !== 'crash' && status !== 'blocked') {
    throw new Error('autoresearch workflow returned an unknown experiment status')
  }
  const metric = record['metric']
  if (metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric))) {
    throw new Error('autoresearch workflow returned an invalid metric')
  }
  const report: ExperimentReport = {
    status,
    metric,
    experimentCommit: readNormalizedString(record['experimentCommit'], 'experimentCommit'),
    headCommit: readNormalizedString(record['headCommit'], 'headCommit'),
    summary: readNormalizedString(record['summary'], 'summary'),
    evidence: readStringList(record['evidence'], 'evidence'),
    nextIdea: readNormalizedString(record['nextIdea'], 'nextIdea', true),
    blocker: readNormalizedString(record['blocker'], 'blocker', true),
  }
  if (report.evidence.length === 0) throw new Error('autoresearch workflow returned no experiment evidence')
  if (report.status === 'blocked') {
    if (report.metric !== null || report.blocker.length === 0 || report.nextIdea !== '') {
      throw new Error('autoresearch workflow returned an invalid blocked report')
    }
  } else {
    if (report.blocker !== '' || report.nextIdea.length === 0) {
      throw new Error('autoresearch workflow returned invalid continuation fields')
    }
    if (report.status === 'crash' ? report.metric !== null : report.metric === null) {
      throw new Error('autoresearch workflow returned a metric inconsistent with experiment status')
    }
  }
  if (JSON.stringify(report).length > maxChars) {
    throw new Error('autoresearch workflow returned an oversized experiment report')
  }
  return report
}

function readRunResult(value: unknown, spec: RunSpec): AutoresearchRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('autoresearch workflow returned a malformed terminal result')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'bestCommit,bestMetric,experimentsStarted,lastReport,status'
    || typeof record['experimentsStarted'] !== 'number'
    || !Number.isSafeInteger(record['experimentsStarted'])
    || record['experimentsStarted'] < 1
    || record['experimentsStarted'] > spec.maxExperiments) {
    throw new Error('autoresearch workflow returned a malformed terminal result')
  }
  const experimentsStarted = record['experimentsStarted']
  const bestMetric = record['bestMetric']
  const bestCommit = readNormalizedString(record['bestCommit'], 'bestCommit', record['status'] === 'round-failed')
  if (record['status'] === 'round-failed') {
    if (bestMetric !== null && (typeof bestMetric !== 'number' || !Number.isFinite(bestMetric))) {
      throw new Error('autoresearch workflow returned an invalid failed-round metric')
    }
    const lastReport = record['lastReport'] === null ? null : readReport(record['lastReport'], spec.maxHandoffChars)
    if (experimentsStarted === 1 ? bestMetric !== null || bestCommit !== '' || lastReport !== null
      : bestMetric === null || bestCommit === '' || lastReport === null) {
      throw new Error('autoresearch workflow returned inconsistent failed-round state')
    }
    return { status: 'round-failed', experimentsStarted, bestMetric, bestCommit, lastReport }
  }
  if (record['status'] !== 'target-reached' && record['status'] !== 'budget-limited' && record['status'] !== 'blocked') {
    throw new Error('autoresearch workflow returned an unknown terminal status')
  }
  if (bestMetric !== null && (typeof bestMetric !== 'number' || !Number.isFinite(bestMetric))) {
    throw new Error('autoresearch workflow returned an invalid best metric')
  }
  if (record['status'] !== 'blocked' && bestMetric === null) {
    throw new Error('autoresearch workflow returned no finite best metric')
  }
  if (record['status'] === 'budget-limited' && experimentsStarted !== spec.maxExperiments) {
    throw new Error('autoresearch workflow returned budget-limited before the experiment cap')
  }
  const lastReport = readReport(record['lastReport'], spec.maxHandoffChars)
  if (record['status'] === 'blocked' && lastReport.status !== 'blocked') {
    throw new Error('autoresearch workflow returned blocked without a blocked report')
  }
  return {
    status: record['status'],
    experimentsStarted,
    bestMetric,
    bestCommit,
    lastReport,
  }
}

function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `autoresearch workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `autoresearch workflow failed: ${result.error ?? 'unknown error'}`
    default:
      return `autoresearch workflow ended abnormally (${String(result.stopReason satisfies never)})`
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

function renderRunResult(result: AutoresearchRunResult, maxChars: number): string {
  if (result.status === 'round-failed') {
    return boundResult(
      `Autoresearch experiment ${result.experimentsStarted} failed before a valid report.\n`
      + `Best metric: ${result.bestMetric === null ? '(baseline unavailable)' : result.bestMetric}\n`
      + `Best commit: ${result.bestCommit === '' ? '(baseline unavailable)' : result.bestCommit}\n`
      + `Last report:\n${result.lastReport === null ? '(none)' : JSON.stringify(result.lastReport, null, 2)}`,
      maxChars,
    )
  }
  const headline = result.status === 'target-reached'
    ? 'Autoresearch reached the target metric.'
    : result.status === 'blocked'
      ? 'Autoresearch stopped on a concrete blocker.'
      : 'Autoresearch reached its experiment limit.'
  return boundResult(
    `${headline}\nExperiments: ${result.experimentsStarted}\nBest metric: ${result.bestMetric}\n`
    + `Best commit: ${result.bestCommit}\nLast report:\n${JSON.stringify(result.lastReport, null, 2)}`,
    maxChars,
  )
}

function workflowArgs(spec: RunSpec): Record<string, unknown> {
  return {
    objective: spec.objective,
    runTag: spec.runTag,
    mutableFiles: spec.mutableFiles,
    evaluationCommand: spec.evaluationCommand,
    metricName: spec.metricName,
    metricDirection: spec.metricDirection,
    experimentTimeoutMinutes: spec.experimentTimeoutMinutes,
    constraints: spec.constraints,
    maxExperiments: spec.maxExperiments,
    targetMetric: spec.targetMetric ?? null,
    resultsFile: spec.resultsFile,
    branchPrefix: spec.branchPrefix,
    maxHandoffChars: spec.maxHandoffChars,
    reportSchema: REPORT_SCHEMA,
  }
}


async function settleRun(run: WorkflowRun, spec: RunSpec): Promise<AutoresearchRunResult> {
  try {
    const settled = await run.result
    const error = stopReasonError(settled)
    if (error !== undefined) throw new Error(error)
    return readRunResult(settled.value, spec)
  } finally {
    await run.dispose()
  }
}

async function settleJob(run: WorkflowRun, spec: RunSpec, maxResultChars: number): Promise<JobOutcome> {
  try {
    const result = await settleRun(run, spec)
    if (result.status === 'round-failed') {
      return { status: 'failed', detail: 'experiment worker failed', output: renderRunResult(result, maxResultChars) }
    }
    return { status: 'completed', detail: result.status, output: renderRunResult(result, maxResultChars) }
  } catch (error: unknown) {
    return { status: 'failed', detail: String(error) }
  }
}

function presentCall(args: ToolArgs): ToolCallView {
  return { card: 'generic', title: 'autoresearch', rawInput: args.objective }
}


/** Register the autoresearch tool, background producer, and model policy. */
export function apply(ctx: Context, config: AutoresearchConfig): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({ name: 'tool:autoresearch', order: 116.25, text: GUIDANCE })
  ctx.tools.register(defineTool({
    name: 'autoresearch',
    description: DESCRIPTION,
    parameters: {
      objective: { type: 'string', required: true, description: 'Immutable research objective.' },
      run_tag: { type: 'string', required: true, description: 'Fresh lower-case Git-safe run tag without slashes.' },
      mutable_files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Narrow relative files or globs that experiment workers may intentionally modify.',
      },
      evaluation_command: {
        type: 'string',
        required: true,
        description: 'Exact single-line command every baseline and candidate must run.',
      },
      metric_name: { type: 'string', required: true, description: 'Scalar metric parsed from evaluation output.' },
      metric_direction: {
        type: 'string',
        required: true,
        enum: ['minimize', 'maximize'],
        description: 'Whether a lower or higher metric is better.',
      },
      experiment_timeout_minutes: {
        type: 'number',
        required: true,
        description: 'Positive safe-integer wall-clock ceiling for each evaluation command.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional immutable restrictions such as read-only files or dependency bans.',
      },
      max_experiments: {
        type: 'number',
        description: 'Optional positive safe-integer experiment count, bounded by deployment config.',
      },
      target_metric: {
        type: 'number',
        description: 'Optional metric threshold that ends the run after a baseline or kept experiment reaches it.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run as a generic background job. Defaults to true; set false to wait for completion.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              agentsStarted: { type: 'integer', required: true },
              result: { type: 'json', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started autoresearch job ${value.jobId}`
          : renderRunResult(value.result as unknown as AutoresearchRunResult, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('autoresearch requires a calling agent (exec.agent was undefined)')
      const spec = resolveRunSpec(args, resolved)
      void requireFreshProvider(ctx, resolved.subagentProvider)
      const runInBackground = args.run_in_background ?? true
      if (runInBackground) {
        const id = ctx.jobs.start({
          kind: 'autoresearch',
          label: `autoresearch ${spec.runTag}: ${spec.objective}`,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const run = ctx.workflowEngine.start({
              script: AUTORESEARCH_SCRIPT,
              meta: AUTORESEARCH_META,
              args: workflowArgs(spec),
              subagentProvider: resolved.subagentProvider,
              maxTotalAgents: spec.maxExperiments,
              parent,
              signal: controller.signal,
            })
            return {
              cancel(reason?: string) {
                controller.abort(reason ?? 'autoresearch job killed')
                run.cancel(reason ?? 'autoresearch job killed')
              },
              done: settleJob(run, spec, resolved.maxResultChars),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const run = ctx.workflowEngine.start({
        script: AUTORESEARCH_SCRIPT,
        meta: AUTORESEARCH_META,
        args: workflowArgs(spec),
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: spec.maxExperiments,
        parent,
        signal: exec.signal,
      })
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) run.cancel('parent step aborted')
      try {
        const settled = await run.result
        const error = stopReasonError(settled)
        if (error !== undefined) throw new Error(error)
        const result = readRunResult(settled.value, spec)
        if (result.status === 'round-failed') throw new Error(renderRunResult(result, resolved.maxResultChars))
        return {
          kind: 'foreground' as const,
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: result as unknown as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await run.dispose()
      }
    },
    presentCall,
    presentResult: () => ({ card: 'generic' }),
  }))
}
