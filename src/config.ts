import z from '@deepseek-ai/schemastery'
import { normalizeEvaluatorRegistration, type AutoresearchToolInput, type EvaluatorRegistration, type ExceptionalPathPolicy, type NormalizedRunPolicy } from './types.js'

export interface EvaluatorRegistrationConfig {
  id: string
  command: string
  args: string[]
  cwd?: string
  environment?: Record<string, string>
  metricName: string
  metricDirection: 'minimize' | 'maximize'
  metricParserVersion: 'final-line-json-v1'
  evaluatorFiles: string[]
  dataset?:
    | { kind: 'none' }
    | { kind: 'local'; files: string[]; identity?: string }
    | { kind: 'external'; digest: string; identity?: string }
}

export interface HostEvaluatorRegistration extends EvaluatorRegistration {
  readonly metricParserVersion: 'final-line-json-v1'
}

export interface EvaluatorRegistry {
  readonly registrations: readonly HostEvaluatorRegistration[]
  resolve(evaluatorId: string): HostEvaluatorRegistration
}
export interface Config {
  provider?: string
  model?: string
  maxTokens?: number
  gitExecutable?: string
  stateRoot?: string
  branchPrefix?: string
  defaultMaxExperiments?: number
  maxExperiments?: number
  maxHandoffChars?: number
  maxResultChars?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  terminationGraceMs?: number
  maxActiveRunsPerRepository?: number
  artifactRetentionDays?: number
  retainFailedArtifacts?: boolean
  retainWorktrees?: boolean
  cleanupWorktreesOnSuccess?: boolean
  exportTsv?: boolean
  tsvRetentionDays?: number
  evaluatorRegistrations?: EvaluatorRegistrationConfig[]
}

export interface ResolvedConfig {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  readonly gitExecutable: string
  readonly stateRoot: string
  readonly branchPrefix: string
  readonly defaultMaxExperiments: number
  readonly maxExperiments: number
  readonly maxHandoffChars: number
  readonly maxResultChars: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
  readonly terminationGraceMs: number
  readonly maxActiveRunsPerRepository: number
  readonly artifactRetentionDays: number
  readonly retainFailedArtifacts: boolean
  readonly retainWorktrees: boolean
  readonly cleanupWorktreesOnSuccess: boolean
  readonly exportTsv: boolean
  readonly tsvRetentionDays: number
  readonly evaluatorRegistry: EvaluatorRegistry
}

export const DEFAULT_CONFIG: ResolvedConfig = deepFreeze({
  gitExecutable: 'git',
  stateRoot: 'dsh-autoresearch',
  branchPrefix: 'autoresearch/',
  defaultMaxExperiments: 20,
  maxExperiments: 100,
  maxHandoffChars: 16_384,
  maxResultChars: 16_384,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 1_048_576,
  defaultTimeoutMs: 900_000,
  maxTimeoutMs: 3_600_000,
  terminationGraceMs: 5_000,
  maxActiveRunsPerRepository: 1,
  artifactRetentionDays: 30,
  retainFailedArtifacts: true,
  retainWorktrees: true,
  cleanupWorktreesOnSuccess: false,
  exportTsv: true,
  tsvRetentionDays: 30,
  evaluatorRegistry: createEvaluatorRegistry([]),
})

const positive = () => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)

/** Loader-time deployment schema. Independent defaults are explicit because patch rows replace whole configs. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: positive(),
  gitExecutable: z.string().default(DEFAULT_CONFIG.gitExecutable),
  stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot),
  branchPrefix: z.string().default(DEFAULT_CONFIG.branchPrefix),
  defaultMaxExperiments: positive(),
  maxExperiments: positive().default(DEFAULT_CONFIG.maxExperiments),
  maxHandoffChars: positive().default(DEFAULT_CONFIG.maxHandoffChars),
  maxResultChars: positive().default(DEFAULT_CONFIG.maxResultChars),
  maxStdoutBytes: positive().default(DEFAULT_CONFIG.maxStdoutBytes),
  maxStderrBytes: positive().default(DEFAULT_CONFIG.maxStderrBytes),
  defaultTimeoutMs: positive(),
  maxTimeoutMs: positive().default(DEFAULT_CONFIG.maxTimeoutMs),
  terminationGraceMs: positive().default(DEFAULT_CONFIG.terminationGraceMs),
  maxActiveRunsPerRepository: positive().default(DEFAULT_CONFIG.maxActiveRunsPerRepository),
  artifactRetentionDays: positive().default(DEFAULT_CONFIG.artifactRetentionDays),
  retainFailedArtifacts: z.boolean().default(DEFAULT_CONFIG.retainFailedArtifacts),
  retainWorktrees: z.boolean().default(DEFAULT_CONFIG.retainWorktrees),
  cleanupWorktreesOnSuccess: z.boolean().default(DEFAULT_CONFIG.cleanupWorktreesOnSuccess),
  exportTsv: z.boolean().default(DEFAULT_CONFIG.exportTsv),
  tsvRetentionDays: positive().default(DEFAULT_CONFIG.tsvRetentionDays),
  evaluatorRegistrations: z.array(z.object({
    id: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()).required(),
    cwd: z.string(),
    environment: z.dict(z.string()),
    metricName: z.string().required(),
    metricDirection: z.union(['minimize', 'maximize']).required(),
    metricParserVersion: z.const('final-line-json-v1').required(),
    evaluatorFiles: z.array(z.string()).required(),
    dataset: z.union([
      z.object({ kind: z.const('none').required() }),
      z.object({ kind: z.const('local').required(), files: z.array(z.string()).required(), identity: z.string() }),
      z.object({ kind: z.const('external').required(), digest: z.string().required(), identity: z.string() }),
    ]).default({ kind: 'none' }),
  })).default([]),
})

const CONFIG_KEYS = new Set([
  'provider', 'model', 'maxTokens', 'gitExecutable', 'stateRoot', 'branchPrefix',
  'defaultMaxExperiments', 'maxExperiments', 'maxHandoffChars', 'maxResultChars',
  'maxStdoutBytes', 'maxStderrBytes', 'defaultTimeoutMs', 'maxTimeoutMs',
  'terminationGraceMs', 'maxActiveRunsPerRepository', 'artifactRetentionDays',
  'retainFailedArtifacts', 'retainWorktrees', 'cleanupWorktreesOnSuccess',
  'exportTsv', 'tsvRetentionDays', 'evaluatorRegistrations',
])

export function resolveConfig(config: Config = {}): ResolvedConfig {
  rejectUnknown(config as Record<string, unknown>, CONFIG_KEYS, 'Config')
  const maxExperiments = positiveInteger(config.maxExperiments ?? DEFAULT_CONFIG.maxExperiments, 'maxExperiments')
  const maxTimeoutMs = positiveInteger(config.maxTimeoutMs ?? DEFAULT_CONFIG.maxTimeoutMs, 'maxTimeoutMs')
  const resolved: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...optionalText(config.provider, 'provider', 'provider'),
    ...optionalText(config.model, 'model', 'model'),
    ...optionalPositive(config.maxTokens, 'maxTokens', 'maxTokens'),
    gitExecutable: normalizedText(config.gitExecutable ?? DEFAULT_CONFIG.gitExecutable, 'gitExecutable'),
    stateRoot: safeRelativePath(config.stateRoot ?? DEFAULT_CONFIG.stateRoot, 'stateRoot'),
    branchPrefix: branchPrefix(config.branchPrefix ?? DEFAULT_CONFIG.branchPrefix),
    defaultMaxExperiments: positiveInteger(config.defaultMaxExperiments ?? Math.min(DEFAULT_CONFIG.defaultMaxExperiments, maxExperiments), 'defaultMaxExperiments'),
    maxExperiments,
    maxHandoffChars: positiveInteger(config.maxHandoffChars ?? DEFAULT_CONFIG.maxHandoffChars, 'maxHandoffChars'),
    maxResultChars: positiveInteger(config.maxResultChars ?? DEFAULT_CONFIG.maxResultChars, 'maxResultChars'),
    maxStdoutBytes: positiveInteger(config.maxStdoutBytes ?? DEFAULT_CONFIG.maxStdoutBytes, 'maxStdoutBytes'),
    maxStderrBytes: positiveInteger(config.maxStderrBytes ?? DEFAULT_CONFIG.maxStderrBytes, 'maxStderrBytes'),
    defaultTimeoutMs: positiveInteger(config.defaultTimeoutMs ?? Math.min(DEFAULT_CONFIG.defaultTimeoutMs, maxTimeoutMs), 'defaultTimeoutMs'),
    maxTimeoutMs,
    terminationGraceMs: positiveInteger(config.terminationGraceMs ?? DEFAULT_CONFIG.terminationGraceMs, 'terminationGraceMs'),
    maxActiveRunsPerRepository: positiveInteger(config.maxActiveRunsPerRepository ?? DEFAULT_CONFIG.maxActiveRunsPerRepository, 'maxActiveRunsPerRepository'),
    artifactRetentionDays: positiveInteger(config.artifactRetentionDays ?? DEFAULT_CONFIG.artifactRetentionDays, 'artifactRetentionDays'),
    retainFailedArtifacts: boolean(config.retainFailedArtifacts ?? DEFAULT_CONFIG.retainFailedArtifacts, 'retainFailedArtifacts'),
    retainWorktrees: boolean(config.retainWorktrees ?? DEFAULT_CONFIG.retainWorktrees, 'retainWorktrees'),
    cleanupWorktreesOnSuccess: boolean(config.cleanupWorktreesOnSuccess ?? DEFAULT_CONFIG.cleanupWorktreesOnSuccess, 'cleanupWorktreesOnSuccess'),
    exportTsv: boolean(config.exportTsv ?? DEFAULT_CONFIG.exportTsv, 'exportTsv'),
    tsvRetentionDays: positiveInteger(config.tsvRetentionDays ?? DEFAULT_CONFIG.tsvRetentionDays, 'tsvRetentionDays'),
    evaluatorRegistry: createEvaluatorRegistry(config.evaluatorRegistrations ?? []),
  }
  if (resolved.defaultMaxExperiments > resolved.maxExperiments) throw new TypeError('defaultMaxExperiments must not exceed maxExperiments')
  if (resolved.defaultTimeoutMs > resolved.maxTimeoutMs) throw new TypeError('defaultTimeoutMs must not exceed maxTimeoutMs')
  if (resolved.cleanupWorktreesOnSuccess && resolved.retainWorktrees) throw new TypeError('cleanupWorktreesOnSuccess and retainWorktrees cannot both be true')
  return deepFreeze(resolved)
}

export function createEvaluatorRegistry(values: readonly EvaluatorRegistrationConfig[]): EvaluatorRegistry {
  if (!Array.isArray(values)) throw new TypeError('evaluatorRegistrations must be an array')
  const registrations = values.map((value, index) => normalizeEvaluatorConfig(value, index))
    .sort((left, right) => left.evaluatorId < right.evaluatorId ? -1 : left.evaluatorId > right.evaluatorId ? 1 : 0)
  for (let index = 1; index < registrations.length; index += 1) {
    if (registrations[index - 1]!.evaluatorId === registrations[index]!.evaluatorId) throw new TypeError(`duplicate evaluator registration id "${registrations[index]!.evaluatorId}"`)
  }
  const byId: Record<string, HostEvaluatorRegistration> = Object.create(null) as Record<string, HostEvaluatorRegistration>
  for (const registration of registrations) byId[registration.evaluatorId] = registration
  return deepFreeze({
    registrations,
    resolve(evaluatorId: string): HostEvaluatorRegistration {
      const normalizedId = normalizedText(evaluatorId, 'evaluator_id')
      const registration = byId[normalizedId]
      if (!registration) throw new TypeError(`unknown evaluator registration id "${normalizedId}"`)
      return registration
    },
  })
}

function normalizeEvaluatorConfig(value: EvaluatorRegistrationConfig, index: number): HostEvaluatorRegistration {
  const source = optionalPlainObject(value, `evaluatorRegistrations[${index}]`)
  rejectUnknown(source, new Set(['id', 'command', 'args', 'cwd', 'environment', 'metricName', 'metricDirection', 'metricParserVersion', 'evaluatorFiles', 'dataset']), `evaluatorRegistrations[${index}]`)
  if (!Array.isArray(value.args)) throw new TypeError(`evaluatorRegistrations[${index}].args must be an array`)
  if (!Array.isArray(value.evaluatorFiles)) throw new TypeError(`evaluatorRegistrations[${index}].evaluatorFiles must be an array`)
  const dataset = value.dataset === undefined ? { kind: 'none' as const } : normalizeConfiguredDataset(value.dataset, index)
  const registration = normalizeEvaluatorRegistration({
    evaluatorId: value.id,
    command: value.command,
    args: value.args,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    environment: normalizeEnvironment(value.environment),
    metricName: value.metricName,
    metricDirection: value.metricDirection,
    evaluatorFiles: value.evaluatorFiles,
    dataset,
  })
  if (value.metricParserVersion !== 'final-line-json-v1') throw new TypeError(`evaluatorRegistrations[${index}].metricParserVersion is unsupported`)
  return { ...registration, metricParserVersion: value.metricParserVersion }
}

function normalizeConfiguredDataset(value: NonNullable<EvaluatorRegistrationConfig['dataset']>, index: number): EvaluatorRegistration['dataset'] {
  const label = `evaluatorRegistrations[${index}].dataset`
  const source = optionalPlainObject(value, label)
  if (typeof source['kind'] !== 'string') throw new TypeError(`${label}.kind must be a string`)
  if (source['kind'] === 'none') {
    rejectUnknown(source, new Set(['kind']), label)
    return { kind: 'none' }
  }
  if (source['kind'] === 'local') {
    rejectUnknown(source, new Set(['kind', 'files', 'identity']), label)
    if (!Array.isArray(source['files'])) throw new TypeError(`${label}.files must be an array`)
    for (const [fileIndex, file] of source['files'].entries()) if (typeof file !== 'string') throw new TypeError(`${label}.files[${fileIndex}] must be a string`)
    if (source['identity'] !== undefined && typeof source['identity'] !== 'string') throw new TypeError(`${label}.identity must be a string`)
    return { kind: 'local', files: source['files'], ...(source['identity'] === undefined ? {} : { identity: source['identity'] }) }
  }
  if (source['kind'] === 'external') {
    rejectUnknown(source, new Set(['kind', 'digest', 'identity']), label)
    if (typeof source['digest'] !== 'string') throw new TypeError(`${label}.digest must be a string`)
    if (source['identity'] !== undefined && typeof source['identity'] !== 'string') throw new TypeError(`${label}.identity must be a string`)
    return { kind: 'external', digest: source['digest'] as `sha256:${string}`, ...(source['identity'] === undefined ? {} : { identity: source['identity'] }) }
  }
  throw new TypeError(`${label} has unknown kind`)
}

export function normalizeRunPolicy(input: AutoresearchToolInput, config: ResolvedConfig, callerCwd: string): NormalizedRunPolicy {
  rejectUnknown(input as unknown as Record<string, unknown>, new Set([
    'repository', 'run_tag', 'resume_run_id', 'objective', 'constraints', 'mutable_globs',
    'exceptional_allowlists', 'evaluation', 'metric_name', 'metric_direction', 'timeout_ms',
    'max_experiments', 'target', 'provenance', 'environment', 'mode',
  ]), 'autoresearch input')
  if ((input.run_tag === undefined) === (input.resume_run_id === undefined)) throw new TypeError('exactly one of run_tag or resume_run_id is required')
  const maxExperiments = positiveInteger(input.max_experiments ?? config.defaultMaxExperiments, 'max_experiments')
  if (maxExperiments > config.maxExperiments) throw new TypeError('max_experiments exceeds deployment maximum')
  const timeoutMs = positiveInteger(input.timeout_ms ?? config.defaultTimeoutMs, 'timeout_ms')
  if (timeoutMs > config.maxTimeoutMs) throw new TypeError('timeout_ms exceeds deployment maximum')
  if (input.metric_direction !== 'minimize' && input.metric_direction !== 'maximize') throw new TypeError('metric_direction must be minimize or maximize')
  if (input.target !== undefined && !Number.isFinite(input.target)) throw new TypeError('target must be finite')
  if (!Array.isArray(input.mutable_globs) || input.mutable_globs.length === 0) throw new TypeError('mutable_globs must not be empty')
  const evaluation = exactEvaluation(input.evaluation)
  const policy: NormalizedRunPolicy = {
    repository: normalizedPath(input.repository ?? callerCwd, 'repository'),
    ...(input.run_tag === undefined ? {} : { runTag: runTag(input.run_tag) }),
    ...(input.resume_run_id === undefined ? {} : { resumeRunId: normalizedText(input.resume_run_id, 'resume_run_id') }),
    objective: normalizedText(input.objective, 'objective'),
    constraints: normalizedList(input.constraints ?? [], 'constraints'),
    mutableGlobs: normalizedList(input.mutable_globs, 'mutable_globs', true),
    exceptionalAllowlists: normalizeAllowlists(input.exceptional_allowlists),
    evaluation,
    metricName: metricName(input.metric_name),
    metricDirection: input.metric_direction,
    timeoutMs,
    maxExperiments,
    ...(input.target === undefined ? {} : { target: input.target }),
    provenance: normalizeProvenance(input.provenance),
    environment: normalizeEnvironment(input.environment),
    mode: input.mode ?? 'background',
  }
  if (policy.mode !== 'background' && policy.mode !== 'foreground') throw new TypeError('mode must be background or foreground')
  return deepFreeze(structuredClone(policy))
}

function exactEvaluation(value: AutoresearchToolInput['evaluation']): NormalizedRunPolicy['evaluation'] {
  const record = value as unknown as Record<string, unknown>
  rejectUnknown(record, new Set(['command', 'args', 'cwd']), 'evaluation')
  if (!Array.isArray(value.args)) throw new TypeError('evaluation.args must be an array')
  return { command: normalizedText(value.command, 'evaluation.command'), args: normalizedList(value.args, 'evaluation.args', false, true), ...(value.cwd === undefined ? {} : { cwd: safeRelativePath(value.cwd, 'evaluation.cwd') }) }
}

function normalizeAllowlists(value: AutoresearchToolInput['exceptional_allowlists']): ExceptionalPathPolicy {
  const source = optionalPlainObject(value, 'exceptional_allowlists') as Partial<ExceptionalPathPolicy>
  rejectUnknown(source as Record<string, unknown>, new Set(['dependencies', 'evaluators', 'datasets', 'submodules', 'gitConfig']), 'exceptional_allowlists')
  return {
    dependencies: normalizedList(source.dependencies ?? [], 'exceptional_allowlists.dependencies', true),
    evaluators: normalizedList(source.evaluators ?? [], 'exceptional_allowlists.evaluators', true),
    datasets: normalizedList(source.datasets ?? [], 'exceptional_allowlists.datasets', true),
    submodules: normalizedList(source.submodules ?? [], 'exceptional_allowlists.submodules', true),
    gitConfig: normalizedList(source.gitConfig ?? [], 'exceptional_allowlists.gitConfig', true),
  }
}
function normalizeProvenance(value: AutoresearchToolInput['provenance']): NormalizedRunPolicy['provenance'] { const source = optionalPlainObject(value, 'provenance') as Record<string, unknown>; rejectUnknown(source, new Set(['evaluator', 'dataset']), 'provenance'); return { ...optionalText(source['evaluator'], 'evaluator', 'provenance.evaluator'), ...optionalText(source['dataset'], 'dataset', 'provenance.dataset') } }
function normalizeEnvironment(value: AutoresearchToolInput['environment']): Readonly<Record<string, string>> { const source = optionalPlainObject(value, 'environment'); const output: Record<string, string> = {}; for (const [key, item] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new TypeError(`invalid environment key ${key}`); if (key.startsWith('DSH_')) throw new TypeError(`environment key ${key} uses the reserved DSH_ prefix`); if (typeof item !== 'string' || /\0/u.test(item)) throw new TypeError(`environment.${key} must be a NUL-free string`); output[key] = item } return output }
function optionalPlainObject(value: unknown, label: string): Record<string, unknown> { if (value === undefined) return {}; if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); return value as Record<string, unknown> }
function normalizedList(values: readonly unknown[], label: string, paths = false, allowEmpty = false): string[] { const result = values.map((value, index) => paths ? safeRelativePath(value, `${label}[${index}]`) : normalizedText(value, `${label}[${index}]`, allowEmpty)); return [...new Set(result)] }
function normalizedText(value: unknown, label: string, allowEmpty = false): string { if (typeof value !== 'string' || value !== value.trim() || (!allowEmpty && value.length === 0) || /[\0\r\n]/u.test(value)) throw new TypeError(`${label} must be normalized text`); return value }
function normalizedPath(value: unknown, label: string): string { const result = normalizedText(value, label); if (/\0/u.test(result)) throw new TypeError(`${label} contains NUL`); return result }
function safeRelativePath(value: unknown, label: string): string { const result = normalizedText(value, label); if (result.startsWith('/') || result.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(result) || result.split(/[\\/]/u).includes('..')) throw new TypeError(`${label} must be a relative path without parent traversal`); return result }
function runTag(value: unknown): string { const result = normalizedText(value, 'run_tag'); if (!/^[a-z0-9][a-z0-9._-]*$/u.test(result) || result.endsWith('.') || result.includes('..')) throw new TypeError('run_tag must be lower-case Git-safe text'); return result }
function metricName(value: unknown): string { const result = normalizedText(value, 'metric_name'); if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(result)) throw new TypeError('metric_name must be a scalar JSON key'); return result }
function branchPrefix(value: unknown): string { const result = normalizedText(value, 'branchPrefix'); if (!result.endsWith('/') || /[\s~^:?*[\\]/u.test(result) || result.includes('..')) throw new TypeError('branchPrefix must be a valid Git prefix ending in /'); return result }
function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive safe integer`); return value as number }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`); return value }
function optionalText(value: unknown, key: string, label: string): Record<string, string> { return value === undefined ? {} : { [key]: normalizedText(value, label) } }
function optionalPositive(value: unknown, key: string, label: string): Record<string, number> { return value === undefined ? {} : { [key]: positiveInteger(value, label) } }
function rejectUnknown(record: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void { for (const key of Object.keys(record)) if (!keys.has(key)) throw new TypeError(`${label}: unknown key "${key}"`) }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item) } return value }
