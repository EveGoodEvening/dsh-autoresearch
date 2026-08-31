import { createHash } from 'node:crypto'

export type MetricDirection = 'minimize' | 'maximize'
export type RunMode = 'background' | 'foreground'

export type RunId = string
export type ExperimentId = string
export type AttemptId = string
export type ArtifactId = string
export type TransitionId = string
export type FullCommitSha = string
export const EVALUATOR_CONTRACT_GENERATION = 'host-registration-v1' as const
export type EvaluatorContractGeneration = typeof EVALUATOR_CONTRACT_GENERATION
export type AlgorithmQualifiedDigest = `sha256:${string}`
export type RegistrationManifest = Readonly<Record<string, string>>
export interface FrozenFileDeclarations {
  readonly evaluatorFiles: readonly string[]
  readonly datasetFiles: readonly string[]
}

export function normalizeRepositoryRelativePath(value: string, label = 'repository path'): string {
  return normalizedRepositoryRelativePath(value, label)
}

export function normalizeFrozenFileDeclarations(value: FrozenFileDeclarations): FrozenFileDeclarations {
  const evaluatorFiles = normalizedRegistrationPathList(value.evaluatorFiles, 'evaluatorFiles')
  const datasetFiles = normalizedRegistrationPathList(value.datasetFiles, 'datasetFiles')
  const evaluatorPaths = new Set(evaluatorFiles)
  const overlap = datasetFiles.filter(path => evaluatorPaths.has(path))
  if (overlap.length > 0) throw new RegistrationPathOverlapError(overlap)
  return { evaluatorFiles, datasetFiles }
}

export function normalizeAlgorithmQualifiedDigest(value: string, label = 'digest'): AlgorithmQualifiedDigest {
  if (!value.startsWith('sha256:')) throw new TypeError(`${label} must be algorithm-qualified`)
  return `sha256:${lowercaseSha256(value.slice('sha256:'.length), label)}`
}

export type DatasetRegistration =
  | { readonly kind: 'none' }
  | { readonly kind: 'local'; readonly files: readonly string[]; readonly identity?: string }
  | { readonly kind: 'external'; readonly digest: AlgorithmQualifiedDigest; readonly identity?: string }

export class RegistrationPathOverlapError extends TypeError {
  readonly paths: readonly string[]
  constructor(paths: readonly string[]) {
    super(`evaluatorFiles and dataset.files must not overlap: ${paths.join(', ')}`)
    this.name = 'RegistrationPathOverlapError'
    this.paths = [...paths]
  }
}

export interface EvaluatorRegistration {
  readonly evaluatorId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string>>
  readonly metricName: string
  readonly metricDirection: MetricDirection
  readonly evaluatorFiles: readonly string[]
  readonly dataset: DatasetRegistration
}

export interface DurableRegistrationIdentity {
  readonly contractGeneration: EvaluatorContractGeneration
  readonly evaluatorId: string
  readonly registration: EvaluatorRegistration
  readonly manifest: RegistrationManifest
  readonly registrationFingerprint: string
}

export type RegistrationBlockEvidence =
  | { readonly kind: 'legacy-run'; readonly code: 'legacy-contract'; readonly message: string }
  | { readonly kind: 'registration-blocked'; readonly code: 'evaluator-registration-mismatch' | 'registration-corrupt'; readonly message: string }

export function normalizeEvaluatorRegistration(value: EvaluatorRegistration): EvaluatorRegistration {
  const evaluatorId = normalizedRegistrationText(value.evaluatorId, 'evaluatorId')
  const command = normalizedRegistrationText(value.command, 'command')
  const args = value.args.map((item, index) => normalizedRegistrationText(item, `args[${index}]`, true))
  const cwd = value.cwd === undefined ? undefined : normalizedRepositoryRelativePath(value.cwd, 'cwd')
  const metricName = normalizedRegistrationText(value.metricName, 'metricName')
  if (value.metricDirection !== 'minimize' && value.metricDirection !== 'maximize') throw new TypeError('metricDirection must be minimize or maximize')
  const environment = normalizeRegistrationEnvironment(value.environment)
  const declarations = normalizeFrozenFileDeclarations({
    evaluatorFiles: value.evaluatorFiles,
    datasetFiles: value.dataset.kind === 'local' ? value.dataset.files : [],
  })
  const evaluatorFiles = declarations.evaluatorFiles
  const dataset = normalizeDatasetRegistration(value.dataset)
  return { evaluatorId, command, args, ...(cwd === undefined ? {} : { cwd }), environment, metricName, metricDirection: value.metricDirection, evaluatorFiles, dataset }
}

/** Normalize an explicit, closed evaluator environment into stable key order. */
export function normalizeRegistrationEnvironment(value: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareRegistrationText(a, b)).map(([name, item]) => [normalizedEnvironmentName(name), normalizedRegistrationText(item, `environment.${name}`, true)]))
}

export function normalizeRegistrationManifest(value: RegistrationManifest): RegistrationManifest {
  const entries = Object.entries(value).map(([path, digest]) => [normalizedRepositoryRelativePath(path, 'manifest path'), lowercaseSha256(digest, `manifest ${path}`)] as const).sort(([a], [b]) => compareRegistrationText(a, b))
  if (new Set(entries.map(([path]) => path)).size !== entries.length) throw new TypeError('manifest paths must be unique')
  return Object.fromEntries(entries)
}

export function registrationFingerprint(registration: EvaluatorRegistration, manifest: RegistrationManifest): string {
  const normalized = normalizeEvaluatorRegistration(registration)
  const normalizedManifest = normalizeRegistrationManifest(manifest)
  const expectedPaths = [...normalized.evaluatorFiles, ...(normalized.dataset.kind === 'local' ? normalized.dataset.files : [])].sort(compareRegistrationText)
  const actualPaths = Object.keys(normalizedManifest)
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) throw new TypeError('registration manifest must contain exactly every declared local file')
  const fields = [EVALUATOR_CONTRACT_GENERATION, normalized.evaluatorId, serializeRegistrationJson(normalized), serializeRegistrationJson(normalizedManifest)]
  const hash = createHash('sha256')
  for (const field of fields) { const bytes = Buffer.from(field, 'utf8'); hash.update(String(bytes.length)); hash.update(':'); hash.update(bytes) }
  return hash.digest('hex')
}

function normalizeDatasetRegistration(value: DatasetRegistration): DatasetRegistration {
  if (value.kind === 'none') return { kind: 'none' }
  const identity = value.identity === undefined ? undefined : normalizedRegistrationText(value.identity, 'dataset.identity')
  if (value.kind === 'local') return { kind: 'local', files: normalizedRegistrationPathList(value.files, 'dataset.files'), ...(identity === undefined ? {} : { identity }) }
  if (value.kind === 'external') return { kind: 'external', digest: normalizeAlgorithmQualifiedDigest(value.digest, 'dataset.digest'), ...(identity === undefined ? {} : { identity }) }
  throw new TypeError('unknown dataset registration kind')
}

function compareRegistrationText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function normalizedRegistrationList(values: readonly string[], label: string): string[] { return [...new Set(values.map((item, index) => normalizedRegistrationText(item, `${label}[${index}]`)))].sort(compareRegistrationText) }
function normalizedRegistrationPathList(values: readonly string[], label: string): string[] { return [...new Set(values.map((item, index) => normalizedRepositoryRelativePath(item, `${label}[${index}]`)))].sort(compareRegistrationText) }
function normalizedRepositoryRelativePath(value: string, label: string): string {
  const path = normalizedRegistrationText(value, label)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)) throw new TypeError(`${label} must be a repository-relative path`)
  if (path.includes('\\')) throw new TypeError(`${label} must use canonical forward-slash separators`)
  if (path.split('/').some(component => component === '' || component === '.' || component === '..')) throw new TypeError(`${label} must not contain empty, dot, or parent components`)
  return path
}
function normalizedEnvironmentName(value: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError(`invalid environment name ${value}`); return value }
function normalizedRegistrationText(value: string, label: string, allowEmpty = false): string { if (typeof value !== 'string' || value !== value.trim() || (!allowEmpty && value.length === 0) || /[\0\r\n]/u.test(value)) throw new TypeError(`${label} must be normalized text`); return value }
function lowercaseSha256(value: string, label: string): string { if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`); return value }
export function serializeRegistrationJson(value: unknown): string { return JSON.stringify(sortRegistrationJson(value)) }
function sortRegistrationJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortRegistrationJson); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareRegistrationText(a, b)).map(([key, item]) => [key, sortRegistrationJson(item)])); return value }


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

export interface ActivationToolInputBase {
  readonly repository?: string
  readonly objective: string
  readonly constraints?: readonly string[]
  readonly mutable_globs: readonly string[]
  readonly timeout_ms?: number
  readonly max_experiments?: number
  readonly target?: number
  readonly mode?: RunMode
}

export interface ActivationNewStartToolInput extends ActivationToolInputBase {
  readonly run_tag: string
  readonly evaluator_id: string
  readonly resume_run_id?: never
}

export interface ActivationResumeToolInput extends ActivationToolInputBase {
  readonly resume_run_id: RunId
  readonly run_tag?: never
  readonly evaluator_id?: never
}

export type ActivationAutoresearchToolInput = ActivationNewStartToolInput | ActivationResumeToolInput

const ACTIVATION_COMMON_PARAMETERS = {
  repository: { type: 'string', description: 'Repository or cwd; defaults to the initiating agent cwd.' },
  objective: { type: 'string', required: true, description: 'Immutable optimization objective.' },
  constraints: { type: 'array', items: { type: 'string' }, description: 'Immutable advisory proposal constraints.' },
  mutable_globs: { type: 'array', required: true, items: { type: 'string' }, description: 'Narrow relative mutable paths or globs.' },
  timeout_ms: { type: 'number', description: 'Per-attempt positive safe integer bounded by deployment policy.' },
  max_experiments: { type: 'number', description: 'Positive safe integer candidate experiment cap; baseline is separate.' },
  target: { type: 'number', description: 'Optional finite stopping threshold.' },
  mode: { type: 'string', enum: ['background', 'foreground'], description: 'Defaults to background.' },
} as const

/** Activation parameter map for the tool runtime's implicit object root. The decoder enforces the exact start/resume union. */
export const ACTIVATION_AUTORESEARCH_TOOL_SCHEMA = {
  ...ACTIVATION_COMMON_PARAMETERS,
  run_tag: { type: 'string', description: 'Required with evaluator_id for a new run; forbidden when resume_run_id is present.' },
  evaluator_id: { type: 'string', description: 'Required with run_tag for a new run; forbidden when resume_run_id is present.' },
  resume_run_id: { type: 'string', description: 'Required to resume a durable run; mutually exclusive with run_tag and evaluator_id.' },
} as const

const ACTIVATION_COMMON_KEYS = new Set(['repository', 'objective', 'constraints', 'mutable_globs', 'timeout_ms', 'max_experiments', 'target', 'mode'])

/** Strict testable decoder for the inert activation contract; it performs no registry or repository lookup. */
export function decodeActivationToolInput(value: unknown): ActivationAutoresearchToolInput {
  const source = exactRecord(value, 'autoresearch input')
  const hasResume = Object.hasOwn(source, 'resume_run_id')
  const allowed = new Set(ACTIVATION_COMMON_KEYS)
  if (hasResume) allowed.add('resume_run_id')
  else { allowed.add('run_tag'); allowed.add('evaluator_id') }
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new TypeError(`autoresearch input: unknown key "${key}"`)
  const common = {
    ...(source['repository'] === undefined ? {} : { repository: text(source['repository'], 'repository') }),
    objective: text(source['objective'], 'objective'),
    ...(source['constraints'] === undefined ? {} : { constraints: activationStringArray(source['constraints'], 'constraints') }),
    mutable_globs: activationStringArray(source['mutable_globs'], 'mutable_globs', true),
    ...(source['timeout_ms'] === undefined ? {} : { timeout_ms: activationPositiveInteger(source['timeout_ms'], 'timeout_ms') }),
    ...(source['max_experiments'] === undefined ? {} : { max_experiments: activationPositiveInteger(source['max_experiments'], 'max_experiments') }),
    ...(source['target'] === undefined ? {} : { target: finite(source['target'], 'target') }),
    ...(source['mode'] === undefined ? {} : { mode: activationMode(source['mode']) }),
  }
  const decoded: ActivationAutoresearchToolInput = hasResume
    ? { ...common, resume_run_id: text(source['resume_run_id'], 'resume_run_id') }
    : { ...common, run_tag: activationRunTag(source['run_tag']), evaluator_id: text(source['evaluator_id'], 'evaluator_id') }
  return deepFreezeActivation(decoded)
}

function activationStringArray(value: unknown, label: string, requireNonEmpty = false): string[] {
  if (!Array.isArray(value) || requireNonEmpty && value.length === 0) throw new TypeError(`${label} must be${requireNonEmpty ? ' a non-empty' : ' an'} array`)
  const normalized = value.map((item, index) => requireNonEmpty ? activationRelativePath(item, `${label}[${index}]`) : text(item, `${label}[${index}]`))
  return [...new Set(normalized)]
}
function activationRelativePath(value: unknown, label: string): string { const result = text(value, label); if (result.startsWith('/') || result.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(result) || result.split(/[\\/]/u).includes('..')) throw new TypeError(`${label} must be a relative path without parent traversal`); return result }
function activationPositiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive safe integer`); return value as number }
function activationMode(value: unknown): RunMode { if (value !== 'background' && value !== 'foreground') throw new TypeError('mode must be background or foreground'); return value }
function activationRunTag(value: unknown): string { const result = text(value, 'run_tag'); if (!/^[a-z0-9][a-z0-9._-]*$/u.test(result) || result.endsWith('.') || result.includes('..')) throw new TypeError('run_tag must be lower-case Git-safe text'); return result }
function deepFreezeActivation<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreezeActivation(item); Object.freeze(value) } return value }


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
