import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { EvaluatorArgv } from './types.js'
import { EvaluatorArtifactWriter, normalizeRedactionSecrets, type EvaluatorArtifactRecord } from './evaluator-artifacts.js'

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

export interface EvaluatorDeclaredFile {
  readonly path: string
  readonly sha256: string
  readonly dev: number
  readonly ino: number
}

export interface EvaluatorBoundaryIdentity {
  readonly worktree: EvaluatorWorktreeIdentity
  readonly normalizedEvaluation: EvaluatorArgv
  readonly evaluationSha256: string
  readonly normalizedPolicySha256: string
  readonly declaredFiles: readonly EvaluatorDeclaredFile[]
  readonly runId?: string
  readonly attemptId?: string
}

export interface FrozenEvaluatorProvenance {
  readonly parserVersion: typeof EVALUATOR_PARSER_VERSION
  readonly evaluatorFileHashes: Readonly<Record<string, string>>
  readonly canonical: string
  readonly sha256: string
}

export type EvaluatorArtifactInput = EvaluatorArtifactRecord

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
  readonly artifactWriterFactory: () => EvaluatorArtifactWriter
  readonly environment?: Readonly<Record<string, string>>
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

export interface EvaluatorBoundaryInput {
  readonly evaluation: EvaluatorArgv
  readonly normalizedPolicySha256: string
  readonly evaluatorFiles?: readonly string[]
  readonly runId?: string
  readonly attemptId?: string
}

/** Captures evaluator policy facts by value. The string-cwd stability guarantee assumes a trusted provider and no hostile same-UID racer. */
export function createEvaluatorBoundary(worktree: string, input: EvaluatorBoundaryInput): EvaluatorBoundaryIdentity {
  if (!/^[0-9a-f]{64}$/u.test(input.normalizedPolicySha256)) throw new TypeError('normalizedPolicySha256 must be a lowercase SHA-256')
  const root = canonicalWorktree(worktree)
  const evaluation = deepFreeze(structuredClone(input.evaluation))
  const declaredFiles = Object.freeze([...new Set(input.evaluatorFiles ?? [])].sort().map(path => captureDeclaredFile(root, path)))
  return Object.freeze({
    worktree: captureEvaluatorWorktreeIdentity(root),
    normalizedEvaluation: evaluation,
    evaluationSha256: evaluationDigest(evaluation),
    normalizedPolicySha256: input.normalizedPolicySha256,
    declaredFiles,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
  })
}

export function revalidateEvaluatorBoundary(worktree: string, boundary: EvaluatorBoundaryIdentity): void {
  const root = assertBoundaryIdentity(worktree, boundary)
  for (const file of boundary.declaredFiles) {
    const current = captureDeclaredFile(root, file.path)
    if (current.dev !== file.dev || current.ino !== file.ino || current.sha256 !== file.sha256) throw new TypeError(`declared evaluator file changed before spawn: ${file.path}`)
  }
}

export function freezeEvaluatorProvenance(worktree: string, input: EvaluatorProvenanceInput): FrozenEvaluatorProvenance {
  const root = canonicalWorktree(worktree)
  const secrets = secretsOf(input.environment)
  const fileHashes: Record<string, string> = Object.create(null) as Record<string, string>
  for (const file of [...(input.evaluatorFiles ?? [])].sort()) {
    assignDurableKey(fileHashes, redact(file, secrets), sha256(readContainedFile(root, file, 'evaluator file')), 'evaluator file path')
  }
  const value = {
    evaluation: durableSerialize(input.evaluation, secrets),
    evaluatorFileHashes: fileHashes,
    dataset: durableSerialize(sortedRecord(input.dataset ?? {}), secrets, true),
    environment: hashedEnvironment(input.environment ?? {}),
    metricName: redact(input.metricName, secrets),
    metricDirection: input.metricDirection,
    parserVersion: EVALUATOR_PARSER_VERSION,
    policySha256: sha256(canonicalJson(durableSerialize(input.policy ?? null, secrets, true))),
  }
  const canonical = canonicalJson(value)
  return deepFreeze({ parserVersion: EVALUATOR_PARSER_VERSION, evaluatorFileHashes: fileHashes, canonical, sha256: sha256(canonical) })
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
  const secrets = secretsOf(env)
  const root = assertBoundaryIdentity(options.worktree, options.boundary)
  assertNormalizedEvaluation(options.evaluation, options.boundary.evaluationSha256)
  const cwdIdentity = capturePathIdentity(root, options.evaluation.cwd ?? '.', 'evaluator cwd', true)
  const cwd = cwdIdentity.canonical
  const persistedEnv = hashedEnvironment(env)
  revalidateEvaluatorBoundary(root, options.boundary)
  const provenance = freezeEvaluatorProvenance(root, {
    evaluation: options.boundary.normalizedEvaluation,
    evaluatorFiles: options.boundary.declaredFiles.map(file => file.path),
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    environment: env,
    metricName: options.metricName,
    metricDirection: options.metricDirection,
    policy: { normalizedPolicySha256: options.boundary.normalizedPolicySha256, evaluationSha256: options.boundary.evaluationSha256, policy: options.policy ?? null },
  })
  const argv = Object.freeze([options.evaluation.command, ...options.evaluation.args])
  const durableIntent = durableSerialize({ argv, cwd, env: persistedEnv, provenanceSha256: provenance.sha256 }, secrets) as Parameters<EvaluatorPersistence['persistSpawnIntent']>[0]
  persistSafely(() => options.persistence.persistSpawnIntent(durableIntent), secrets)
  const artifactWriter = options.artifactWriterFactory()
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
    const artifacts = artifactWriter.write(undefined, undefined, secrets)
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
    revalidateEvaluatorBoundary(root, options.boundary)
    handle = options.subprocess.spawn({
      argv, cwd, env, signal: controller.signal, graceMs: options.terminationGraceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxStdoutBytes, spill: { maxBytes: options.maxStdoutBytes } },
        stderr: { maxBytes: options.maxStderrBytes, spill: { maxBytes: options.maxStderrBytes } },
      },
    })
    assertPathIdentity(root, cwdIdentity, 'evaluator cwd')
    revalidateEvaluatorBoundary(root, options.boundary)
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
  const artifacts = artifactWriter.write(stdoutRead, stderrRead, secrets)
  const rawFacts: EvaluatorAttemptFacts = {
    ...(handle === undefined ? {} : { providerPid: handle.pid }), ...(spawnedAt === undefined ? {} : { spawnedAt }),
    exitedAt: now().toISOString(), exitCode: outcome.exitCode, signal: outcome.signal,
    timedOut: cause === 'timeout', cancelled: cause === 'cancelled', processTreeQuiescent: quiescent,
    ...(spawnFailure === undefined ? {} : { failureCode: 'spawn', failureMessage: safeErrorMessage(spawnFailure, secrets) }),
  }
  const facts = deepFreeze(durableSerialize(rawFacts, secrets)) as EvaluatorAttemptFacts
  persistSafely(() => options.persistence.persistAttemptOutcome(facts, artifacts), secrets)
  const base = deepFreeze({ provenanceSha256: provenance.sha256, exit: facts, artifacts })
  if (spawnFailure !== undefined) return { kind: 'failed', code: 'spawn', message: safeErrorMessage(spawnFailure, secrets), ...base }
  if (cause === 'cancelled') return { kind: 'failed', code: 'cancelled', message: 'evaluator cancelled', ...base }
  if (cause === 'timeout') return { kind: 'failed', code: 'timeout', message: 'evaluator timed out', ...base }
  if (!quiescent) return { kind: 'failed', code: 'signal', message: 'evaluator process tree did not become quiescent', ...base }
  if (outcome.signal !== null) return { kind: 'failed', code: 'signal', message: `evaluator terminated by ${outcome.signal}`, ...base }
  if (outcome.exitCode !== 0) return { kind: 'failed', code: 'exit', message: `evaluator exited with code ${outcome.exitCode}`, ...base }
  if (stdoutRead === undefined || stdoutRead.lossy) return { kind: 'failed', code: 'output-limit', message: 'evaluator stdout exceeded its authoritative parse limit', ...base }
  try { return { kind: 'measured', metric: parseFinalLineMetric(stdoutRead.text, options.metricName), ...base } }
  catch (error) { return { kind: 'failed', code: 'metric-protocol', message: safeErrorMessage(error, secrets), ...base } }
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

function assertNormalizedEvaluation(requested: EvaluatorArgv, capturedDigest: string): void {
  if (evaluationDigest(requested) !== capturedDigest) throw new TypeError('evaluator argv/cwd does not match the frozen normalized policy digest')
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
  const secrets = secretsOf(environment)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) assignDurableKey(result, redact(key, secrets), `sha256:${sha256(value)}`, 'environment key')
  return Object.freeze(result)
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
  return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
}
function safeErrorMessage(error: unknown, secrets: readonly string[]): string {
  return redact(error instanceof Error ? error.message : String(error), secrets)
}

function evaluationDigest(evaluation: EvaluatorArgv): string {
  return sha256(canonicalJson({ command: evaluation.command, args: [...evaluation.args], ...(evaluation.cwd === undefined ? {} : { cwd: evaluation.cwd }) }))
}

function captureDeclaredFile(root: string, path: string): EvaluatorDeclaredFile {
  const identity = capturePathIdentity(root, path, 'declared evaluator file', false)
  const bytes = readContainedFile(root, path, 'declared evaluator file')
  return Object.freeze({ path: normalizedRelativePath(root, identity.canonical), sha256: sha256(bytes), dev: identity.dev, ino: identity.ino })
}

function normalizedRelativePath(root: string, canonical: string): string {
  const path = relative(root, canonical).split(sep).join('/')
  if (path === '' || path.startsWith('../')) throw new TypeError('declared evaluator file must be beneath the worktree')
  return path
}

function durableSerialize<T>(value: T, secrets: readonly string[], redactKeys = false): T {
  if (typeof value === 'string') return redact(value, secrets) as T
  if (Array.isArray(value)) return value.map(item => durableSerialize(item, secrets, redactKeys)) as T
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) {
      const durableKey = redactKeys ? redact(key, secrets) : key
      assignDurableKey(result, durableKey, durableSerialize(item, secrets, redactKeys), redactKeys ? 'provenance metadata key' : 'durable key')
    }
    return result as T
  }
  return value
}

function secretsOf(environment: Readonly<Record<string, string>> | undefined): readonly string[] {
  return normalizeRedactionSecrets(Object.values(environment ?? {}))
}

function assignDurableKey<T>(target: Record<string, T>, key: string, value: T, label: string): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) throw new TypeError(`${label} aliases another key after secret redaction`)
  target[key] = value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
