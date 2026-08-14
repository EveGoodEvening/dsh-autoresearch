import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { EvaluatorArgv } from './types.ts'

export const EVALUATOR_PARSER_VERSION = 'final-line-json-v1' as const

export interface EvaluatorProvenanceInput {
  readonly evaluation: EvaluatorArgv
  readonly evaluatorFiles?: readonly string[]
  readonly dataset?: Readonly<Record<string, string>>
  readonly environment?: Readonly<Record<string, string>>
  readonly metricName: string
  readonly metricDirection: 'minimize' | 'maximize'
  readonly policy?: unknown
}

export interface FrozenEvaluatorProvenance {
  readonly parserVersion: typeof EVALUATOR_PARSER_VERSION
  readonly evaluatorFileHashes: Readonly<Record<string, string>>
  readonly canonical: string
  readonly sha256: string
}

export interface EvaluatorArtifactInput {
  readonly kind: 'stdout' | 'stderr'
  readonly location: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly truncated: boolean
}

export interface EvaluatorAttemptFacts {
  readonly providerPid?: number
  readonly spawnedAt?: string
  readonly exitedAt: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly processTreeQuiescent: boolean
  readonly failureCode?: string
  readonly failureMessage?: string
}

export type EvaluatorResult =
  | { readonly kind: 'measured'; readonly metric: number; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly EvaluatorArtifactInput[] }
  | { readonly kind: 'failed'; readonly code: 'spawn' | 'timeout' | 'cancelled' | 'exit' | 'signal' | 'output-limit' | 'metric-protocol'; readonly message: string; readonly provenanceSha256: string; readonly exit: EvaluatorAttemptFacts; readonly artifacts: readonly EvaluatorArtifactInput[] }

export interface EvaluatorPersistence {
  persistSpawnIntent(intent: Readonly<{ argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; provenanceSha256: string }>): void
  persistSpawnObserved(facts: Readonly<{ providerPid: number; spawnedAt: string }>): void
  persistAttemptOutcome(facts: EvaluatorAttemptFacts, artifacts: readonly EvaluatorArtifactInput[]): void
}

export interface EvaluatorRunOptions {
  readonly subprocess: { spawn(spec: SubprocessSpawnSpec): SubprocessHandle }
  readonly worktree: string
  readonly evaluation: EvaluatorArgv
  readonly metricName: string
  readonly metricDirection: 'minimize' | 'maximize'
  readonly timeoutMs: number
  readonly terminationGraceMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly artifactDirectory: string
  readonly artifactPrefix: string
  readonly environment?: Readonly<Record<string, string>>
  readonly evaluatorFiles?: readonly string[]
  readonly dataset?: Readonly<Record<string, string>>
  readonly policy?: unknown
  readonly signal?: AbortSignal
  readonly persistence: EvaluatorPersistence
  readonly now?: () => Date
}

export function freezeEvaluatorProvenance(worktree: string, input: EvaluatorProvenanceInput): FrozenEvaluatorProvenance {
  const root = resolve(worktree)
  const fileHashes: Record<string, string> = Object.create(null) as Record<string, string>
  for (const file of [...(input.evaluatorFiles ?? [])].sort()) {
    const absolute = containedPath(root, file, 'evaluator file')
    fileHashes[file] = sha256(readFileSync(absolute))
  }
  const value = {
    evaluation: { command: input.evaluation.command, args: [...input.evaluation.args], ...(input.evaluation.cwd === undefined ? {} : { cwd: input.evaluation.cwd }) },
    evaluatorFileHashes: fileHashes,
    dataset: sortedRecord(input.dataset ?? {}),
    environment: sortedRecord(input.environment ?? {}),
    metricName: input.metricName,
    metricDirection: input.metricDirection,
    parserVersion: EVALUATOR_PARSER_VERSION,
    policy: input.policy ?? null,
  }
  const canonical = canonicalJson(value)
  return { parserVersion: EVALUATOR_PARSER_VERSION, evaluatorFileHashes: fileHashes, canonical, sha256: sha256(canonical) }
}

export function parseFinalLineMetric(stdout: string, metricName: string): number {
  const lines = stdout.replace(/\r\n?/gu, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const finalLine = lines.at(-1)
  if (finalLine === undefined || finalLine.trim() === '') throw new EvaluatorMetricError('missing final-line metric object')
  let value: unknown
  try { value = JSON.parse(finalLine) } catch { throw new EvaluatorMetricError('final line is malformed JSON') }
  if (!isPlainRecord(value)) throw new EvaluatorMetricError('final line must be one JSON object')
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== metricName) throw new EvaluatorMetricError(`final object must contain exactly metric key ${JSON.stringify(metricName)}`)
  const metric = value[metricName]
  if (typeof metric !== 'number' || !Number.isFinite(metric)) throw new EvaluatorMetricError('metric must be a finite number')
  for (const line of lines.slice(0, -1)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const earlier = JSON.parse(trimmed) as unknown
      if (isPlainRecord(earlier) && Object.prototype.hasOwnProperty.call(earlier, metricName)) throw new EvaluatorMetricError('duplicate metric result object')
    } catch (error) { if (error instanceof EvaluatorMetricError) throw error }
  }
  return metric
}

export class EvaluatorMetricError extends Error {
  constructor(message: string) { super(message); this.name = 'EvaluatorMetricError' }
}

export async function runEvaluator(options: EvaluatorRunOptions): Promise<EvaluatorResult> {
  validatePositive(options.timeoutMs, 'timeoutMs')
  validatePositive(options.terminationGraceMs, 'terminationGraceMs')
  validatePositive(options.maxStdoutBytes, 'maxStdoutBytes')
  validatePositive(options.maxStderrBytes, 'maxStderrBytes')
  const now = options.now ?? (() => new Date())
  const cwd = evaluatorCwd(options.worktree, options.evaluation.cwd)
  const env = explicitEnvironment(options.environment ?? {})
  const provenance = freezeEvaluatorProvenance(options.worktree, {
    evaluation: options.evaluation,
    ...(options.evaluatorFiles === undefined ? {} : { evaluatorFiles: options.evaluatorFiles }),
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    environment: env,
    metricName: options.metricName,
    metricDirection: options.metricDirection,
    policy: options.policy,
  })
  const argv = Object.freeze([options.evaluation.command, ...options.evaluation.args])
  options.persistence.persistSpawnIntent({ argv, cwd, env, provenanceSha256: provenance.sha256 })

  const controller = new AbortController()
  let cause: 'timeout' | 'cancelled' | undefined
  const cancel = (): void => { if (cause === undefined) cause = 'cancelled'; controller.abort() }
  if (options.signal?.aborted) cancel()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => { if (cause === undefined) cause = 'timeout'; controller.abort() }, options.timeoutMs)
  let handle: SubprocessHandle | undefined
  let outcome: SubprocessOutcome = { exitCode: null, signal: null }
  let spawnedAt: string | undefined
  let spawnFailure: unknown
  try {
    handle = options.subprocess.spawn({
      argv, cwd, env, signal: controller.signal, graceMs: options.terminationGraceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxStdoutBytes, spill: { maxBytes: options.maxStdoutBytes } },
        stderr: { maxBytes: options.maxStderrBytes, spill: { maxBytes: options.maxStderrBytes } },
      },
    })
    spawnedAt = now().toISOString()
    options.persistence.persistSpawnObserved({ providerPid: handle.pid, spawnedAt })
    try { outcome = await handle.done } catch (error) { spawnFailure = error }
  } catch (error) {
    spawnFailure = error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }

  let quiescent = handle === undefined
  if (handle !== undefined) {
    if (cause !== undefined || spawnFailure !== undefined) handle.terminate()
    quiescent = await handle.waitForExit()
  }
  const stdoutRead = handle?.collected.stdout?.readFrom(0)
  const stderrRead = handle?.collected.stderr?.readFrom(0)
  const artifacts = persistArtifacts(options.artifactDirectory, options.artifactPrefix, stdoutRead, stderrRead)
  const facts: EvaluatorAttemptFacts = {
    ...(handle === undefined ? {} : { providerPid: handle.pid }), ...(spawnedAt === undefined ? {} : { spawnedAt }),
    exitedAt: now().toISOString(), exitCode: outcome.exitCode, signal: outcome.signal,
    timedOut: cause === 'timeout', cancelled: cause === 'cancelled', processTreeQuiescent: quiescent,
    ...(spawnFailure === undefined ? {} : { failureCode: 'spawn', failureMessage: errorMessage(spawnFailure) }),
  }
  options.persistence.persistAttemptOutcome(facts, artifacts)
  const base = { provenanceSha256: provenance.sha256, exit: facts, artifacts } as const
  if (spawnFailure !== undefined) return { kind: 'failed', code: 'spawn', message: errorMessage(spawnFailure), ...base }
  if (cause === 'cancelled') return { kind: 'failed', code: 'cancelled', message: 'evaluator cancelled', ...base }
  if (cause === 'timeout') return { kind: 'failed', code: 'timeout', message: 'evaluator timed out', ...base }
  if (!quiescent) return { kind: 'failed', code: 'signal', message: 'evaluator process tree did not become quiescent', ...base }
  if (outcome.signal !== null) return { kind: 'failed', code: 'signal', message: `evaluator terminated by ${outcome.signal}`, ...base }
  if (outcome.exitCode !== 0) return { kind: 'failed', code: 'exit', message: `evaluator exited with code ${outcome.exitCode}`, ...base }
  if (stdoutRead === undefined || stdoutRead.lossy) return { kind: 'failed', code: 'output-limit', message: 'evaluator stdout exceeded its authoritative parse limit', ...base }
  try { return { kind: 'measured', metric: parseFinalLineMetric(stdoutRead.text, options.metricName), ...base } }
  catch (error) { return { kind: 'failed', code: 'metric-protocol', message: errorMessage(error), ...base } }
}

function evaluatorCwd(worktree: string, configured?: string): string {
  const root = resolve(worktree)
  return configured === undefined ? root : containedPath(root, configured, 'evaluator cwd')
}

function containedPath(root: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new TypeError(`${label} must be relative to the worktree`)
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new TypeError(`${label} escapes the worktree`)
  return absolute
}

function explicitEnvironment(overrides: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.startsWith('DSH_')) throw new TypeError(`unsafe evaluator environment key ${JSON.stringify(key)}`)
    env[key] = value
  }
  return Object.freeze(env)
}

function persistArtifacts(directory: string, prefix: string, stdout: SubprocessOutputRead | undefined, stderr: SubprocessOutputRead | undefined): readonly EvaluatorArtifactInput[] {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  return ([['stdout', stdout], ['stderr', stderr]] as const).map(([kind, read]) => {
    const destination = resolve(directory, `${safeName(prefix)}.${kind}.log`)
    if (read?.spillPath !== undefined) copyFileSync(read.spillPath, destination)
    else writeFileSync(destination, read?.text ?? '', { mode: 0o600 })
    chmodSync(destination, 0o600)
    const bytes = readFileSync(destination)
    return { kind, location: destination, sizeBytes: statSync(destination).size, sha256: sha256(bytes), truncated: read?.lossy ?? false }
  })
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') throw new TypeError('artifactPrefix contains unsafe characters')
  return value
}

function validatePositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
}

function sortedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
