import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { constants } from 'node:fs'
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

export interface EvaluatorWorktreeIdentity {
  readonly canonical: string
  readonly dev: number
  readonly ino: number
}

export interface EvaluatorBoundaryIdentity {
  readonly worktree: EvaluatorWorktreeIdentity
  readonly normalizedEvaluation: EvaluatorArgv
  readonly normalizedPolicySha256: string
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
  readonly boundary: EvaluatorBoundaryIdentity
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

export function captureEvaluatorWorktreeIdentity(worktree: string): EvaluatorWorktreeIdentity {
  const canonical = canonicalWorktree(worktree)
  const stat = statSync(canonical)
  if (!stat.isDirectory()) throw new TypeError('evaluator worktree must be a directory')
  return Object.freeze({ canonical, dev: stat.dev, ino: stat.ino })
}

export function freezeEvaluatorProvenance(worktree: string, input: EvaluatorProvenanceInput): FrozenEvaluatorProvenance {
  const root = canonicalWorktree(worktree)
  const fileHashes: Record<string, string> = Object.create(null) as Record<string, string>
  for (const file of [...(input.evaluatorFiles ?? [])].sort()) {
    fileHashes[file] = sha256(readContainedFile(root, file, 'evaluator file'))
  }
  const value = {
    evaluation: { command: input.evaluation.command, args: [...input.evaluation.args], ...(input.evaluation.cwd === undefined ? {} : { cwd: input.evaluation.cwd }) },
    evaluatorFileHashes: fileHashes,
    dataset: sortedRecord(input.dataset ?? {}),
    environment: hashedEnvironment(input.environment ?? {}),
    metricName: input.metricName,
    metricDirection: input.metricDirection,
    parserVersion: EVALUATOR_PARSER_VERSION,
    policySha256: sha256(canonicalJson(input.policy ?? null)),
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
  const env = explicitEnvironment(options.environment ?? {})
  const secrets = Object.values(env)
  const root = assertBoundaryIdentity(options.worktree, options.boundary)
  assertNormalizedEvaluation(options.evaluation, options.boundary.normalizedEvaluation)
  const cwdIdentity = capturePathIdentity(root, options.evaluation.cwd ?? '.', 'evaluator cwd', true)
  const cwd = cwdIdentity.canonical
  const persistedEnv = hashedEnvironment(env)
  const provenance = freezeEvaluatorProvenance(root, {
    evaluation: options.evaluation,
    ...(options.evaluatorFiles === undefined ? {} : { evaluatorFiles: options.evaluatorFiles }),
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    environment: env,
    metricName: options.metricName,
    metricDirection: options.metricDirection,
    policy: { normalizedPolicySha256: options.boundary.normalizedPolicySha256, policy: options.policy ?? null },
  })
  const argv = Object.freeze([options.evaluation.command, ...options.evaluation.args])
  persistSafely(() => options.persistence.persistSpawnIntent({ argv, cwd, env: persistedEnv, provenanceSha256: provenance.sha256 }), secrets)
  const controller = new AbortController()
  let cause: 'timeout' | 'cancelled' | undefined
  const cancel = (): void => { if (cause === undefined) cause = 'cancelled'; controller.abort() }
  const callerSignal = options.signal
  callerSignal?.addEventListener('abort', cancel, { once: true })
  if (callerSignal?.aborted) cancel()
  if (controller.signal.aborted) {
    callerSignal?.removeEventListener('abort', cancel)
    const facts: EvaluatorAttemptFacts = {
      exitedAt: now().toISOString(), exitCode: null, signal: null, timedOut: false, cancelled: true, processTreeQuiescent: true,
    }
    const artifacts = persistArtifacts(options.artifactDirectory, options.artifactPrefix, undefined, undefined, Object.values(env))
    persistSafely(() => options.persistence.persistAttemptOutcome(facts, artifacts), secrets)
    return { kind: 'failed', code: 'cancelled', message: 'evaluator cancelled', provenanceSha256: provenance.sha256, exit: facts, artifacts }
  }
  const timeout = setTimeout(() => { if (cause === undefined) cause = 'timeout'; controller.abort() }, options.timeoutMs)
  let handle: SubprocessHandle | undefined
  let outcome: SubprocessOutcome = { exitCode: null, signal: null }
  let spawnedAt: string | undefined
  let spawnFailure: unknown
  let terminationRequested = false
  let terminateOnAbort: (() => void) | undefined
  try {
    assertPathIdentity(root, cwdIdentity, 'evaluator cwd')
    handle = options.subprocess.spawn({
      argv, cwd, env, signal: controller.signal, graceMs: options.terminationGraceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxStdoutBytes, spill: { maxBytes: options.maxStdoutBytes } },
        stderr: { maxBytes: options.maxStderrBytes, spill: { maxBytes: options.maxStderrBytes } },
      },
    })
    assertPathIdentity(root, cwdIdentity, 'evaluator cwd')
    terminateOnAbort = (): void => {
      if (!terminationRequested) { terminationRequested = true; handle?.terminate() }
    }
    controller.signal.addEventListener('abort', terminateOnAbort, { once: true })
    if (controller.signal.aborted) terminateOnAbort()
    spawnedAt = now().toISOString()
    persistSafely(() => options.persistence.persistSpawnObserved({ providerPid: handle!.pid, spawnedAt: spawnedAt! }), secrets)
    try { outcome = await handle.done } catch (error) { spawnFailure = error }
  } catch (error) {
    spawnFailure = error
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', cancel)
    if (terminateOnAbort !== undefined) controller.signal.removeEventListener('abort', terminateOnAbort)
  }

  let quiescent = handle === undefined
  if (handle !== undefined) {
    if ((cause !== undefined || spawnFailure !== undefined) && !terminationRequested) { terminationRequested = true; handle.terminate() }
    quiescent = await handle.waitForExit()
  }
  const stdoutRead = handle?.collected.stdout?.readFrom(0)
  const stderrRead = handle?.collected.stderr?.readFrom(0)
  const artifacts = persistArtifacts(options.artifactDirectory, options.artifactPrefix, stdoutRead, stderrRead, Object.values(env))
  const facts: EvaluatorAttemptFacts = {
    ...(handle === undefined ? {} : { providerPid: handle.pid }), ...(spawnedAt === undefined ? {} : { spawnedAt }),
    exitedAt: now().toISOString(), exitCode: outcome.exitCode, signal: outcome.signal,
    timedOut: cause === 'timeout', cancelled: cause === 'cancelled', processTreeQuiescent: quiescent,
    ...(spawnFailure === undefined ? {} : { failureCode: 'spawn', failureMessage: safeErrorMessage(spawnFailure, Object.values(env)) }),
  }
  persistSafely(() => options.persistence.persistAttemptOutcome(facts, artifacts), secrets)
  const base = { provenanceSha256: provenance.sha256, exit: facts, artifacts } as const
  if (spawnFailure !== undefined) return { kind: 'failed', code: 'spawn', message: safeErrorMessage(spawnFailure, Object.values(env)), ...base }
  if (cause === 'cancelled') return { kind: 'failed', code: 'cancelled', message: 'evaluator cancelled', ...base }
  if (cause === 'timeout') return { kind: 'failed', code: 'timeout', message: 'evaluator timed out', ...base }
  if (!quiescent) return { kind: 'failed', code: 'signal', message: 'evaluator process tree did not become quiescent', ...base }
  if (outcome.signal !== null) return { kind: 'failed', code: 'signal', message: `evaluator terminated by ${outcome.signal}`, ...base }
  if (outcome.exitCode !== 0) return { kind: 'failed', code: 'exit', message: `evaluator exited with code ${outcome.exitCode}`, ...base }
  if (stdoutRead === undefined || stdoutRead.lossy) return { kind: 'failed', code: 'output-limit', message: 'evaluator stdout exceeded its authoritative parse limit', ...base }
  try { return { kind: 'measured', metric: parseFinalLineMetric(stdoutRead.text, options.metricName), ...base } }
  catch (error) { return { kind: 'failed', code: 'metric-protocol', message: safeErrorMessage(error, Object.values(env)), ...base } }
}


function assertBoundaryIdentity(worktree: string, boundary: EvaluatorBoundaryIdentity): string {
  if (!/^[0-9a-f]{64}$/u.test(boundary.normalizedPolicySha256)) throw new TypeError('normalizedPolicySha256 must be a lowercase SHA-256')
  const requested = resolve(worktree)
  if (requested !== boundary.worktree.canonical) throw new TypeError('evaluator worktree does not match the controller-supplied canonical worktree')
  const canonical = canonicalWorktree(requested)
  const stat = statSync(canonical)
  if (canonical !== boundary.worktree.canonical || stat.dev !== boundary.worktree.dev || stat.ino !== boundary.worktree.ino) {
    throw new TypeError('evaluator worktree identity changed before evaluation')
  }
  return canonical
}

function assertNormalizedEvaluation(requested: EvaluatorArgv, normalized: EvaluatorArgv): void {
  if (canonicalJson(requested) !== canonicalJson(normalized)) throw new TypeError('evaluator argv/cwd does not match the frozen normalized policy')
}

function persistSafely(action: () => void, secrets: readonly string[]): void {
  try { action() } catch (error) { throw new Error(safeErrorMessage(error, secrets)) }
}

interface PathIdentity { readonly canonical: string; readonly dev: number; readonly ino: number }

function canonicalWorktree(worktree: string): string {
  return realpathSync(resolve(worktree))
}

function capturePathIdentity(root: string, path: string, label: string, directory: boolean): PathIdentity {
  const lexical = lexicalContainedPath(root, path, label)
  rejectSymlinkComponents(root, lexical, label)
  const canonical = realpathSync(lexical)
  requireContained(root, canonical, label)
  const stat = statSync(canonical)
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new TypeError(`${label} must be ${directory ? 'a directory' : 'a regular file'}`)
  return { canonical, dev: stat.dev, ino: stat.ino }
}

function assertPathIdentity(root: string, expected: PathIdentity, label: string): void {
  const canonical = realpathSync(expected.canonical)
  requireContained(root, canonical, label)
  const stat = statSync(canonical)
  if (canonical !== expected.canonical || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new TypeError(`${label} changed during evaluator startup`)
}

function readContainedFile(root: string, path: string, label: string): Buffer {
  const identity = capturePathIdentity(root, path, label, false)
  const fd = openSync(identity.canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new TypeError(`${label} changed before it could be read`)
    const bytes = readFileSync(fd)
    assertPathIdentity(root, identity, label)
    return bytes
  } finally { closeSync(fd) }
}

function lexicalContainedPath(root: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new TypeError(`${label} must be relative to the worktree`)
  const absolute = resolve(root, path)
  requireContained(root, absolute, label)
  return absolute
}

function requireContained(root: string, path: string, label: string): void {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new TypeError(`${label} escapes the worktree`)
}

function rejectSymlinkComponents(root: string, target: string, label: string): void {
  const rel = relative(root, target)
  let current = root
  for (const component of rel.split(sep).filter(Boolean)) {
    current = resolve(current, component)
    if (lstatSync(current).isSymbolicLink()) throw new TypeError(`${label} must not traverse a symbolic link`)
  }
}

function explicitEnvironment(overrides: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.startsWith('DSH_')) throw new TypeError(`unsafe evaluator environment key ${JSON.stringify(key)}`)
    env[key] = value
  }
  return Object.freeze(env)
}

function hashedEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, `sha256:${sha256(value)}`])))
}

function persistArtifacts(directory: string, prefix: string, stdout: SubprocessOutputRead | undefined, stderr: SubprocessOutputRead | undefined, secrets: readonly string[]): readonly EvaluatorArtifactInput[] {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  return ([['stdout', stdout], ['stderr', stderr]] as const).map(([kind, read]) => {
    const destination = resolve(directory, `${safeName(prefix)}.${kind}.log`)
    const source = read?.spillPath === undefined ? read?.text ?? '' : readFileSync(read.spillPath, 'utf8')
    writeFileSync(destination, redact(source, secrets), { mode: 0o600 })
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
function redact(value: string, secrets: readonly string[]): string {
  return secrets.filter(secret => secret.length > 0).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
}
function safeErrorMessage(error: unknown, secrets: readonly string[]): string {
  return redact(error instanceof Error ? error.message : String(error), secrets)
}
