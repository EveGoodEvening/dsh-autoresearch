export type MetricDirection = 'minimize' | 'maximize'
export type RunMode = 'background' | 'foreground'

export type RunId = string
export type ExperimentId = string
export type AttemptId = string
export type ArtifactId = string
export type TransitionId = string
export type FullCommitSha = string

export interface EvaluatorArgv {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
}

export interface ProvenanceInput {
  readonly evaluator?: string
  readonly dataset?: string
}

export interface ExceptionalPathPolicy {
  readonly dependencies: readonly string[]
  readonly evaluators: readonly string[]
  readonly datasets: readonly string[]
  readonly submodules: readonly string[]
  readonly gitConfig: readonly string[]
}

export interface AutoresearchToolInput {
  readonly repository?: string
  readonly run_tag?: string
  readonly resume_run_id?: RunId
  readonly objective: string
  readonly constraints?: readonly string[]
  readonly mutable_globs: readonly string[]
  readonly exceptional_allowlists?: Partial<ExceptionalPathPolicy>
  readonly evaluation: EvaluatorArgv
  readonly metric_name: string
  readonly metric_direction: MetricDirection
  readonly timeout_ms?: number
  readonly max_experiments?: number
  readonly target?: number
  readonly provenance?: ProvenanceInput
  readonly environment?: Readonly<Record<string, string>>
  readonly mode?: RunMode
}


/** Canonical model-tool input schema; nested objects reject unknown keys at the runtime decoder. */
export const AUTORESEARCH_TOOL_PARAMETERS = {
  repository: { type: 'string', description: 'Repository or cwd; defaults to the initiating agent cwd.' },
  run_tag: { type: 'string', description: 'Fresh Git-safe exclusion tag; mutually exclusive with resume_run_id.' },
  resume_run_id: { type: 'string', description: 'Durable run id to resume; mutually exclusive with run_tag.' },
  objective: { type: 'string', required: true, description: 'Immutable optimization objective.' },
  constraints: { type: 'array', items: { type: 'string' }, description: 'Immutable policy constraints.' },
  mutable_globs: { type: 'array', required: true, items: { type: 'string' }, description: 'Narrow relative mutable paths or globs.' },
  exceptional_allowlists: { type: 'object', additionalProperties: false, properties: { dependencies: { type: 'array', items: { type: 'string' } }, evaluators: { type: 'array', items: { type: 'string' } }, datasets: { type: 'array', items: { type: 'string' } }, submodules: { type: 'array', items: { type: 'string' } }, gitConfig: { type: 'array', items: { type: 'string' } } }, description: 'Explicit dependency, evaluator, dataset, submodule, and Git-config path exceptions.' },
  evaluation: { type: 'object', required: true, additionalProperties: false, properties: { command: { type: 'string', required: true }, args: { type: 'array', required: true, items: { type: 'string' } }, cwd: { type: 'string' } }, description: 'Shell-free evaluator argv: { command, args, cwd? }.' },
  metric_name: { type: 'string', required: true, description: 'Exact final-line JSON scalar key.' },
  metric_direction: { type: 'string', required: true, enum: ['minimize', 'maximize'], description: 'Strict improvement direction.' },
  timeout_ms: { type: 'number', description: 'Per-attempt timeout bounded by deployment policy.' },
  max_experiments: { type: 'number', description: 'Candidate experiment cap; baseline is separate.' },
  target: { type: 'number', description: 'Optional finite stopping threshold.' },
  provenance: { type: 'object', additionalProperties: false, properties: { evaluator: { type: 'string' }, dataset: { type: 'string' } }, description: 'Evaluator and dataset provenance labels.' },
  environment: { type: 'object', additionalProperties: true, description: 'Explicit evaluator environment overrides; every value must be a string.' },
  mode: { type: 'string', enum: ['background', 'foreground'], description: 'Defaults to background.' },
} as const

const artifactSchema = { type: 'object', additionalProperties: false, properties: { artifactId: { type: 'string', required: true }, kind: { type: 'string', required: true }, location: { type: 'string', required: true }, sizeBytes: { type: 'number', required: true }, sha256: { type: 'string', required: true } } } as const
const artifactsSchema = { type: 'array', items: artifactSchema } as const
const bestSchema = { type: 'object', additionalProperties: false, properties: { metric: { type: 'number', required: true }, commit: { type: 'string', required: true }, experimentId: { type: 'string', required: true } } } as const
const countsSchema = { type: 'object', additionalProperties: false, properties: { experimentsStarted: { type: 'number', required: true }, experimentsCompleted: { type: 'number', required: true }, attempts: { type: 'number', required: true } } } as const
const evidenceSchema = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true }, artifacts: { ...artifactsSchema, required: true } } } } as const
const exitSchema = { type: 'object', additionalProperties: false, properties: { exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true }, signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, timedOut: { type: 'boolean', required: true }, stdout: { ...artifactSchema, required: true }, stderr: { ...artifactSchema, required: true } } } as const
const runBase = { runId: { type: 'string', required: true }, tracker: { type: 'string', required: true }, counts: { ...countsSchema, required: true }, artifacts: { ...artifactsSchema, required: true } } as const
const runSchema = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'target-reached' }, target: { type: 'number', required: true }, best: { ...bestSchema, required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'budget-limited' }, best: { ...bestSchema, required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'baseline-blocked' }, baselineAttemptId: { type: 'string', required: true }, reason: { type: 'string', required: true }, exit: { ...exitSchema, required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'blocked' }, best: { ...bestSchema, required: true }, evidence: { ...evidenceSchema, required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'round-failed' }, reason: { type: 'string', required: true }, evidence: { ...evidenceSchema, required: true }, best: bestSchema } },
  { type: 'object', additionalProperties: false, properties: { ...runBase, status: { type: 'string', required: true, const: 'cancelled' }, lastState: { type: 'string', required: true, enum: ['initializing', 'baseline-running', 'ready', 'candidate-prepared', 'candidate-running', 'deciding', 'completed', 'baseline-blocked', 'blocked', 'round-failed'] }, reason: { type: 'string', required: true }, quiescent: { type: 'boolean', required: true, const: true }, best: bestSchema } },
] } as const

/** Canonical discriminated tool-output schema. */
export const AUTORESEARCH_TOOL_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, runId: { type: 'string', required: true }, jobId: { type: 'string', required: true }, tracker: { type: 'string', required: true }, branch: { type: 'string', required: true }, worktree: { type: 'string', required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background-start-failed' }, jobId: { type: 'string', required: true }, runId: { type: 'string' }, status: { type: 'string', required: true, enum: ['failed', 'cancelled'] }, reason: { type: 'string', required: true }, evidence: { ...evidenceSchema, required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'foreground' }, run: { ...runSchema, required: true } } },
  ],
} as const
export interface NormalizedRunPolicy {
  readonly repository: string
  readonly runTag?: string
  readonly resumeRunId?: RunId
  readonly objective: string
  readonly constraints: readonly string[]
  readonly mutableGlobs: readonly string[]
  readonly exceptionalAllowlists: ExceptionalPathPolicy
  readonly evaluation: EvaluatorArgv
  readonly metricName: string
  readonly metricDirection: MetricDirection
  readonly timeoutMs: number
  readonly maxExperiments: number
  readonly target?: number
  readonly provenance: ProvenanceInput
  readonly environment: Readonly<Record<string, string>>
  readonly mode: RunMode
}

export type DurableRunPolicy = Omit<NormalizedRunPolicy, 'resumeRunId' | 'mode' | 'runTag'> & {
  readonly runTag: string
}

export type RunDurableState =
  | 'initializing' | 'baseline-running' | 'ready' | 'candidate-prepared'
  | 'candidate-running' | 'deciding' | 'completed' | 'baseline-blocked'
  | 'blocked' | 'round-failed' | 'cancelled'

export type ExperimentDurableState =
  | 'baseline-pending' | 'running' | 'accepted' | 'rejected' | 'crashed'
  | 'timed-out' | 'policy-violation' | 'cancelled'

export interface RunIdentity {
  readonly runId: RunId
  readonly repositoryId: string
  readonly repository: string
  readonly callerCwd: string
  readonly startCommit: FullCommitSha
  readonly branch: string
  readonly worktree: string
}

export interface ExperimentIdentity {
  readonly runId: RunId
  readonly experimentId: ExperimentId
  readonly ordinal: number
  readonly kind: 'baseline' | 'candidate'
  readonly parentCommit: FullCommitSha
  readonly candidateCommit?: FullCommitSha
}

export interface AttemptIdentity {
  readonly runId: RunId
  readonly experimentId: ExperimentId
  readonly attemptId: AttemptId
  readonly ordinal: number
}

export interface ArtifactIdentity {
  readonly runId: RunId
  readonly artifactId: ArtifactId
  readonly experimentId?: ExperimentId
  readonly attemptId?: AttemptId
}

export interface TransitionIdentity {
  readonly runId: RunId
  readonly transitionId: TransitionId
  readonly sequence: number
  readonly experimentId?: ExperimentId
}

export interface ProvenanceIdentity {
  readonly policySha256: string
  readonly evaluatorSha256: string
  readonly environmentSha256: string
  readonly datasetSha256?: string
}

export interface ArtifactReference {
  readonly artifactId: ArtifactId
  readonly kind: string
  readonly location: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface BestResult {
  readonly metric: number
  readonly commit: FullCommitSha
  readonly experimentId: ExperimentId
}

export interface BlockerEvidence {
  readonly code: string
  readonly message: string
  readonly artifacts: readonly ArtifactReference[]
}

export interface ResultCounts {
  readonly experimentsStarted: number
  readonly experimentsCompleted: number
  readonly attempts: number
}

interface RunResultBase {
  readonly runId: RunId
  readonly tracker: string
  readonly counts: ResultCounts
  readonly artifacts: readonly ArtifactReference[]
}

export interface TargetReachedRunResult extends RunResultBase {
  readonly status: 'target-reached'
  readonly target: number
  readonly best: BestResult
}

export interface BudgetLimitedRunResult extends RunResultBase {
  readonly status: 'budget-limited'
  readonly best: BestResult
}

export interface BaselineBlockedRunResult extends RunResultBase {
  readonly status: 'baseline-blocked'
  readonly baselineAttemptId: AttemptId
  readonly reason: string
  readonly exit: EvaluatorExitFacts
}

export interface BlockedRunResult extends RunResultBase {
  readonly status: 'blocked'
  readonly best: BestResult
  readonly evidence: readonly BlockerEvidence[]
}

export interface RoundFailedRunResult extends RunResultBase {
  readonly status: 'round-failed'
  readonly reason: string
  readonly evidence: readonly BlockerEvidence[]
  readonly best?: BestResult
}

export interface CancelledRunResult extends RunResultBase {
  readonly status: 'cancelled'
  readonly lastState: Exclude<RunDurableState, 'cancelled'>
  readonly reason: string
  readonly quiescent: true
  readonly best?: BestResult
}

export type AutoresearchRunResult =
  | TargetReachedRunResult | BudgetLimitedRunResult | BaselineBlockedRunResult
  | BlockedRunResult | RoundFailedRunResult | CancelledRunResult

export interface BackgroundReadyToolResult {
  readonly kind: 'background'
  readonly runId: RunId
  readonly jobId: string
  readonly tracker: string
  readonly branch: string
  readonly worktree: string
}

export interface BackgroundStartFailedToolResult {
  readonly kind: 'background-start-failed'
  readonly jobId: string
  readonly runId?: RunId
  readonly status: 'failed' | 'cancelled'
  readonly reason: string
  readonly evidence: readonly BlockerEvidence[]
}

export interface ForegroundToolResult {
  readonly kind: 'foreground'
  readonly run: AutoresearchRunResult
}

export type AutoresearchToolResult = BackgroundReadyToolResult | BackgroundStartFailedToolResult | ForegroundToolResult

export interface EvaluatorExitFacts {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly stdout: ArtifactReference
  readonly stderr: ArtifactReference
}

interface ExperimentResultBase {
  readonly experimentId: ExperimentId
  readonly attemptId: AttemptId
  readonly parentCommit: FullCommitSha
  readonly artifacts: readonly ArtifactReference[]
}

export interface BaselineMeasuredExperimentResult extends ExperimentResultBase {
  readonly kind: 'baseline-measured'
  readonly metric: number
  readonly commit: FullCommitSha
}
export interface AcceptedExperimentResult extends ExperimentResultBase {
  readonly kind: 'accepted'
  readonly metric: number
  readonly candidateCommit: FullCommitSha
  readonly previousBest: number
}
export interface RejectedExperimentResult extends ExperimentResultBase {
  readonly kind: 'rejected'
  readonly metric: number
  readonly candidateCommit: FullCommitSha
  readonly currentBest: number
}
export interface CrashedExperimentResult extends ExperimentResultBase {
  readonly kind: 'crashed'
  readonly candidateCommit?: FullCommitSha
  readonly exit: EvaluatorExitFacts
  readonly reason: string
}
export interface TimedOutExperimentResult extends ExperimentResultBase {
  readonly kind: 'timed-out'
  readonly candidateCommit?: FullCommitSha
  readonly exit: EvaluatorExitFacts & { readonly timedOut: true }
}
export interface PolicyViolationExperimentResult extends ExperimentResultBase {
  readonly kind: 'policy-violation'
  readonly candidateCommit: FullCommitSha
  readonly evidence: readonly BlockerEvidence[]
}
export interface CancelledExperimentResult extends ExperimentResultBase {
  readonly kind: 'cancelled'
  readonly candidateCommit?: FullCommitSha
  readonly quiescent: true
  readonly reason: string
}

export type AutoresearchExperimentResult =
  | BaselineMeasuredExperimentResult | AcceptedExperimentResult | RejectedExperimentResult
  | CrashedExperimentResult | TimedOutExperimentResult | PolicyViolationExperimentResult
  | CancelledExperimentResult

const FULL_SHA = /^[0-9a-f]{40}$/u

export function isTargetReached(direction: MetricDirection, metric: number, target: number): boolean {
  assertFinite(metric, 'metric')
  assertFinite(target, 'target')
  return direction === 'minimize' ? metric <= target : metric >= target
}
function isStrictImprovement(direction: MetricDirection, metric: number, reference: number): boolean {
  if (direction !== 'minimize' && direction !== 'maximize') throw new TypeError('metric direction must be minimize or maximize')
  return direction === 'minimize' ? metric < reference : metric > reference
}
/** Validate a complete canonical result; presentation limits belong to render and job adapters. */
export function decodeRunResult(value: unknown, direction: MetricDirection): AutoresearchRunResult {
  const record = exactRecord(value, 'run result')
  const status = record['status']
  const common = decodeRunBase(record)
  switch (status) {
    case 'target-reached': {
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'target', 'best'])
      const target = finite(record['target'], 'target')
      const best = decodeBest(record['best'])
      if (!isTargetReached(direction, best.metric, target)) throw new TypeError('target-reached best does not satisfy target')
      return { ...common, status, target, best }
    }
    case 'budget-limited':
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'best'])
      return { ...common, status, best: decodeBest(record['best']) }
    case 'baseline-blocked':
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'baselineAttemptId', 'reason', 'exit'])
      return { ...common, status, baselineAttemptId: text(record['baselineAttemptId'], 'baselineAttemptId'), reason: text(record['reason'], 'reason'), exit: decodeExit(record['exit']) }
    case 'blocked': {
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'best', 'evidence'])
      const evidence = decodeEvidence(record['evidence'])
      if (evidence.length === 0) throw new TypeError('blocked result requires evidence')
      return { ...common, status, best: decodeBest(record['best']), evidence }
    }
    case 'round-failed':
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'reason', 'evidence', ...(record['best'] === undefined ? [] : ['best'])])
      return { ...common, status, reason: text(record['reason'], 'reason'), evidence: decodeEvidence(record['evidence']), ...(record['best'] === undefined ? {} : { best: decodeBest(record['best']) }) }
    case 'cancelled':
      exactKeys(record, [...RUN_BASE_KEYS, 'status', 'lastState', 'reason', 'quiescent', ...(record['best'] === undefined ? [] : ['best'])])
      if (record['quiescent'] !== true || record['lastState'] === 'cancelled' || !RUN_STATES.includes(record['lastState'] as RunDurableState)) throw new TypeError('cancelled result must be quiescent and identify a valid prior state')
      return { ...common, status, lastState: text(record['lastState'], 'lastState') as CancelledRunResult['lastState'], reason: text(record['reason'], 'reason'), quiescent: true, ...(record['best'] === undefined ? {} : { best: decodeBest(record['best']) }) }
    default: throw new TypeError('unknown run result status')
  }
}

export function decodeExperimentResult(value: unknown, direction: MetricDirection, maxChars: number): AutoresearchExperimentResult {
  assertBoundedJson(value, maxChars, 'experiment result')
  const record = exactRecord(value, 'experiment result')
  const kind = record['kind']
  const base = decodeExperimentBase(record)
  const candidate = (): FullCommitSha => fullSha(record['candidateCommit'], 'candidateCommit')
  const decision = (referenceKey: 'previousBest' | 'currentBest'): { metric: number; reference: number } => ({
    metric: finite(record['metric'], 'metric'),
    reference: finite(record[referenceKey], referenceKey),
  })
  switch (kind) {
    case 'baseline-measured': {
      exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'metric', 'commit'])
      const commit = fullSha(record['commit'], 'commit')
      if (commit !== base.parentCommit) throw new TypeError('baseline-measured commit must equal parentCommit')
      return { ...base, kind, metric: finite(record['metric'], 'metric'), commit }
    }
    case 'accepted': {
      exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'metric', 'candidateCommit', 'previousBest'])
      const { metric, reference: previousBest } = decision('previousBest')
      if (!isStrictImprovement(direction, metric, previousBest)) throw new TypeError('accepted metric must strictly improve previousBest')
      return { ...base, kind, metric, candidateCommit: candidate(), previousBest }
    }
    case 'rejected': {
      exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'metric', 'candidateCommit', 'currentBest'])
      const { metric, reference: currentBest } = decision('currentBest')
      if (isStrictImprovement(direction, metric, currentBest)) throw new TypeError('rejected metric must not strictly improve currentBest')
      return { ...base, kind, metric, candidateCommit: candidate(), currentBest }
    }
    case 'crashed': exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'exit', 'reason', ...(record['candidateCommit'] === undefined ? [] : ['candidateCommit'])]); return { ...base, kind, exit: decodeExit(record['exit']), reason: text(record['reason'], 'reason'), ...(record['candidateCommit'] === undefined ? {} : { candidateCommit: candidate() }) }
    case 'timed-out': { exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'exit', ...(record['candidateCommit'] === undefined ? [] : ['candidateCommit'])]); const exit = decodeExit(record['exit']); if (!exit.timedOut) throw new TypeError('timed-out result requires timedOut exit'); return { ...base, kind, exit: { ...exit, timedOut: true }, ...(record['candidateCommit'] === undefined ? {} : { candidateCommit: candidate() }) } }
    case 'policy-violation': { exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'candidateCommit', 'evidence']); const evidence = decodeEvidence(record['evidence']); if (evidence.length === 0) throw new TypeError('policy violation requires evidence'); return { ...base, kind, candidateCommit: candidate(), evidence } }
    case 'cancelled': exactKeys(record, [...EXPERIMENT_BASE_KEYS, 'kind', 'quiescent', 'reason', ...(record['candidateCommit'] === undefined ? [] : ['candidateCommit'])]); if (record['quiescent'] !== true) throw new TypeError('cancelled experiment must be quiescent'); return { ...base, kind, quiescent: true, reason: text(record['reason'], 'reason'), ...(record['candidateCommit'] === undefined ? {} : { candidateCommit: candidate() }) }
    default: throw new TypeError('unknown experiment result kind')
  }
}

const RUN_BASE_KEYS = ['runId', 'tracker', 'counts', 'artifacts'] as const
const RUN_STATES: readonly RunDurableState[] = ['initializing', 'baseline-running', 'ready', 'candidate-prepared', 'candidate-running', 'deciding', 'completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled']
const EXPERIMENT_BASE_KEYS = ['experimentId', 'attemptId', 'parentCommit', 'artifacts'] as const
function decodeRunBase(r: Record<string, unknown>): RunResultBase { return { runId: text(r['runId'], 'runId'), tracker: text(r['tracker'], 'tracker'), counts: decodeCounts(r['counts']), artifacts: decodeArtifacts(r['artifacts']) } }
function decodeExperimentBase(r: Record<string, unknown>): ExperimentResultBase { return { experimentId: text(r['experimentId'], 'experimentId'), attemptId: text(r['attemptId'], 'attemptId'), parentCommit: fullSha(r['parentCommit'], 'parentCommit'), artifacts: decodeArtifacts(r['artifacts']) } }
function decodeBest(v: unknown): BestResult { const r = exactRecord(v, 'best'); exactKeys(r, ['metric', 'commit', 'experimentId']); return { metric: finite(r['metric'], 'best.metric'), commit: fullSha(r['commit'], 'best.commit'), experimentId: text(r['experimentId'], 'best.experimentId') } }
function decodeCounts(v: unknown): ResultCounts { const r = exactRecord(v, 'counts'); exactKeys(r, ['experimentsStarted', 'experimentsCompleted', 'attempts']); const counts = { experimentsStarted: nonNegative(r['experimentsStarted'], 'experimentsStarted'), experimentsCompleted: nonNegative(r['experimentsCompleted'], 'experimentsCompleted'), attempts: nonNegative(r['attempts'], 'attempts') }; if (counts.experimentsCompleted > counts.experimentsStarted || counts.attempts < counts.experimentsStarted) throw new TypeError('result counts are inconsistent'); return counts }
function decodeArtifacts(v: unknown): ArtifactReference[] { if (!Array.isArray(v)) throw new TypeError('artifacts must be an array'); return v.map((item) => { const r = exactRecord(item, 'artifact'); exactKeys(r, ['artifactId', 'kind', 'location', 'sizeBytes', 'sha256']); return { artifactId: text(r['artifactId'], 'artifactId'), kind: text(r['kind'], 'artifact.kind'), location: text(r['location'], 'artifact.location'), sizeBytes: nonNegative(r['sizeBytes'], 'artifact.sizeBytes'), sha256: hash(r['sha256'], 'artifact.sha256') } }) }
function decodeEvidence(v: unknown): BlockerEvidence[] { if (!Array.isArray(v)) throw new TypeError('evidence must be an array'); return v.map((item) => { const r = exactRecord(item, 'evidence'); exactKeys(r, ['code', 'message', 'artifacts']); return { code: text(r['code'], 'evidence.code'), message: text(r['message'], 'evidence.message'), artifacts: decodeArtifacts(r['artifacts']) } }) }
function decodeExit(v: unknown): EvaluatorExitFacts { const r = exactRecord(v, 'exit'); exactKeys(r, ['exitCode', 'signal', 'timedOut', 'stdout', 'stderr']); const exitCode = r['exitCode']; const signal = r['signal']; if (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) throw new TypeError('exitCode must be null or non-negative integer'); if (signal !== null && typeof signal !== 'string') throw new TypeError('signal must be null or string'); if (typeof r['timedOut'] !== 'boolean') throw new TypeError('timedOut must be boolean'); return { exitCode: exitCode as number | null, signal: signal as string | null, timedOut: r['timedOut'], stdout: decodeArtifacts([r['stdout']])[0]!, stderr: decodeArtifacts([r['stderr']])[0]! } }
function exactRecord(v: unknown, label: string): Record<string, unknown> { if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError(`${label} must be an object`); return v as Record<string, unknown> }
function exactKeys(r: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(r).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) throw new TypeError(`unexpected keys: expected ${wanted.join(', ')}`) }
function text(v: unknown, label: string): string { if (typeof v !== 'string' || v.length === 0 || v !== v.trim() || /[\0\r\n]/u.test(v)) throw new TypeError(`${label} must be normalized non-empty text`); return v }
function finite(v: unknown, label: string): number { if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${label} must be finite`); return v }
function nonNegative(v: unknown, label: string): number { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`); return v as number }
function fullSha(v: unknown, label: string): FullCommitSha { const value = text(v, label); if (!FULL_SHA.test(value)) throw new TypeError(`${label} must be a full lowercase commit SHA`); return value }
function hash(v: unknown, label: string): string { const value = text(v, label); if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`); return value }
function assertFinite(v: number, label: string): void { if (!Number.isFinite(v)) throw new TypeError(`${label} must be finite`) }
function assertBoundedJson(v: unknown, maxChars: number, label: string): void { if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be positive'); let json: string; try { json = JSON.stringify(v) } catch { throw new TypeError(`${label} must be JSON serializable`) } if (json === undefined || json.length > maxChars) throw new TypeError(`${label} exceeds ${maxChars} serialized characters`) }
