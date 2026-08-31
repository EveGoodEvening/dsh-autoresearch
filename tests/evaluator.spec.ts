import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { captureFrozenFileAttempt, createEvaluatorBoundary, deriveRegistrationManifest, freezeEvaluatorProvenance, parseFinalLineMetric, recomputeRegistrationManifest, revalidateFrozenFileAttempt, runEvaluator } from '../src/evaluator.ts'
import type { EvaluatorPersistence } from '../src/evaluator.ts'
import { EvaluatorArtifactWriter } from '../src/evaluator-artifacts.ts'
import { StateLayout } from '../src/state-layout.ts'
import { normalizeEvaluatorRegistration } from '../src/types.ts'

interface FakeOptions {
  stdout?: SubprocessOutputRead
  stderr?: SubprocessOutputRead
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  waitQuiescent?: boolean
  settleOnAbort?: boolean
  spawnError?: Error
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { root: string; artifacts: string } {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-evaluator-')); roots.push(root)
  const artifacts = mkdtempSync(join(tmpdir(), 'autoresearch-artifacts-')); roots.push(artifacts)
  mkdirSync(join(root, 'bench'))
  writeFileSync(join(root, 'bench', 'evaluate.mjs'), 'fixture evaluator\n')
  return { root, artifacts }
}

function reader(text: string, lossy = false, spillPath?: string): SubprocessOutputRead {
  return { text, nextOffset: Buffer.byteLength(text), lossy, ...(spillPath === undefined ? {} : { spillPath }) }
}

function fakeRuntime(options: FakeOptions = {}) {
  let spec: SubprocessSpawnSpec | undefined
  let terminated = 0
  let waited = 0
  return {
    runtime: {
      spawn(next: SubprocessSpawnSpec): SubprocessHandle {
        spec = next
        if (options.spawnError !== undefined) throw options.spawnError
        let settle!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => { settle = resolve })
        const normal = (): void => settle({ exitCode: options.exitCode === undefined ? 0 : options.exitCode, signal: options.signal ?? null })
        if (options.settleOnAbort) next.signal?.addEventListener('abort', normal, { once: true })
        else queueMicrotask(normal)
        return {
          pid: 4242, stdin: undefined, stdout: undefined, stderr: undefined, done,
          collected: { stdout: { readFrom: () => options.stdout ?? reader('{"score":1.5}\n') }, stderr: { readFrom: () => options.stderr ?? reader('') } },
          terminate: () => { terminated += 1; normal() },
          waitForExit: async () => { waited += 1; return options.waitQuiescent ?? true },
        }
      },
    },
    get spec() { return spec },
    get terminated() { return terminated },
    get waited() { return waited },
  }
}

class LocalReader implements SubprocessOutputReader {
  constructor(private readonly chunks: Buffer[], private readonly maxBytes: number) {}
  readFrom(fromByte: number): SubprocessOutputRead {
    const whole = Buffer.concat(this.chunks)
    const retained = whole.subarray(Math.max(0, whole.length - this.maxBytes))
    return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length }
  }
}

class LocalHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly pid: number
  readonly collected
  readonly done: Promise<SubprocessOutcome>
  private exited = false
  private escalation: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], maxOut: number, maxErr: number, graceMs: number) {
    this.pid = child.pid ?? -1
    this.collected = { stdout: new LocalReader(stdout, maxOut), stderr: new LocalReader(stderr, maxErr) }
    this.done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        this.exited = true
        if (this.escalation !== undefined) clearTimeout(this.escalation)
        resolve({ exitCode, signal })
      })
    })
    this.escalation = undefined
    this.graceMs = graceMs
  }

  private readonly graceMs: number

  terminate(): void {
    if (this.exited || this.pid <= 0 || this.escalation !== undefined) return
    try { process.kill(-this.pid, 'SIGTERM') } catch { return }
    this.escalation = setTimeout(() => {
      if (!this.exited) try { process.kill(-this.pid, 'SIGKILL') } catch { /* tree already exited */ }
    }, this.graceMs)
  }

  async waitForExit(): Promise<boolean> { await this.done; return true }
}

class LocalSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const maxOut = typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0
    const maxErr = typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0
    const handle = new LocalHandle(child, stdout, stderr, maxOut, maxErr, spec.graceMs ?? 25)
    spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
    return handle
  }
}

function persistence(): EvaluatorPersistence & {
  events: string[]
  intent?: Parameters<EvaluatorPersistence['persistSpawnIntent']>[0]
  observed?: Parameters<EvaluatorPersistence['persistSpawnObserved']>[0]
  outcome?: Parameters<EvaluatorPersistence['persistAttemptOutcome']>
} {
  const state: EvaluatorPersistence & {
    events: string[]
    intent?: Parameters<EvaluatorPersistence['persistSpawnIntent']>[0]
    observed?: Parameters<EvaluatorPersistence['persistSpawnObserved']>[0]
    outcome?: Parameters<EvaluatorPersistence['persistAttemptOutcome']>
  } = {
    events: [],
    persistSpawnIntent: intent => { state.events.push('intent'); state.intent = intent },
    persistSpawnObserved: observed => { state.events.push('observed'); state.observed = observed },
    persistAttemptOutcome: (...facts) => { state.events.push('outcome'); state.outcome = facts },
  }
  return state
}

function options(runtime = fakeRuntime(), overrides: Record<string, unknown> = {}) {
  const paths = fixture()
  let artifactWriter: EvaluatorArtifactWriter | undefined
  const evaluation = (overrides.evaluation ?? { command: 'node', args: ['evaluate.mjs'], cwd: 'bench' }) as { command: string; args: string[]; cwd?: string }
  const boundary = overrides.boundary ?? createEvaluatorBoundary(paths.root, {
    evaluation, normalizedPolicySha256: 'a'.repeat(64), evaluatorFiles: ['bench/evaluate.mjs'], runId: 'run', attemptId: 'attempt-1',
  })
  return {
    runtime,
    paths,
    value: {
      subprocess: runtime.runtime,
      worktree: paths.root,
      boundary,
      evaluation,
      metricName: 'score', metricDirection: 'minimize' as const,
      timeoutMs: 1_000, terminationGraceMs: 25, maxStdoutBytes: 128, maxStderrBytes: 64,
      artifactWriterFactory: () => artifactWriter ??= EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'attempt-1'), environment: { LANG: 'C' },
      dataset: { version: 'v1', name: 'fixture' }, policy: { tie: 'reject' },
      persistence: persistence(),
      ...overrides,
      boundary,
      evaluation,
    },
    get artifactWriter() { if (!artifactWriter) throw new Error('artifact writer has not been minted'); return artifactWriter },
  }
}

describe('strict evaluator metric protocol', () => {
  it('accepts exactly one final-line object with the configured finite metric', () => {
    expect(parseFinalLineMetric('diagnostic\n{"score":1.25}\n', 'score')).toBe(1.25)
  })

  it.each([
    ['', /missing/],
    ['{"other":1}\n', /exactly metric key/],
    ['{"score":1,"other":2}\n', /exactly metric key/],
    ['not json\n', /malformed JSON/],
    ['{"score":"1"}\n', /finite number/],
    ['{"score":1e999}\n', /finite number/],
    ['{"score":2}\nlog\n{"score":1}\n', /duplicate/],
    ['[1]\n', /JSON object/],
  ])('rejects malformed, missing, duplicate, or non-finite protocol %#', (text, message) => {
    expect(() => parseFinalLineMetric(text, 'score')).toThrow(message)
  })
})

describe('inert frozen registration files', () => {
  function registration(root: string) {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'train.json'), '{"rows":1}\n')
    return normalizeEvaluatorRegistration({
      evaluatorId: 'fixture', command: 'node', args: ['evaluate.mjs'], cwd: 'bench', environment: {}, metricName: 'score', metricDirection: 'minimize',
      evaluatorFiles: ['bench/evaluate.mjs'], dataset: { kind: 'local', files: ['data/train.json'] },
    })
  }

  it('derives and independently recomputes the exact evaluator/local-dataset manifest', () => {
    const paths = fixture(); const manifest = deriveRegistrationManifest(paths.root, registration(paths.root))
    expect(Object.keys(manifest)).toEqual(['bench/evaluate.mjs', 'data/train.json'])
    expect(Object.values(manifest).every(value => /^[0-9a-f]{64}$/u.test(value))).toBe(true)
    expect(recomputeRegistrationManifest(paths.root, manifest)).toEqual(manifest)
    writeFileSync(join(paths.root, 'data', 'train.json'), '{"rows":2}\n')
    expect(() => recomputeRegistrationManifest(paths.root, manifest)).toThrow(/run-creation manifest/)
    rmSync(join(paths.root, 'data', 'train.json'))
    expect(() => recomputeRegistrationManifest(paths.root, manifest)).toThrow()
  })

  it('rejects symlinks and detects attempt-local inode swaps even when bytes are unchanged', () => {
    const paths = fixture(); const normalized = registration(paths.root); const manifest = deriveRegistrationManifest(paths.root, normalized)
    const attempt = captureFrozenFileAttempt(paths.root, manifest)
    const dataset = join(paths.root, 'data', 'train.json'); renameSync(dataset, `${dataset}.old`); writeFileSync(dataset, '{"rows":1}\n')
    expect(() => revalidateFrozenFileAttempt(paths.root, attempt)).toThrow(/device\/inode/)

    rmSync(dataset); symlinkSync(`${dataset}.old`, dataset)
    expect(() => captureFrozenFileAttempt(paths.root, manifest)).toThrow(/symbolic link/)
  })

  it('never combines digest and inode from different descriptors during replacement', () => {
    const paths = fixture(); const normalized = registration(paths.root); const manifest = deriveRegistrationManifest(paths.root, normalized)
    const dataset = join(paths.root, 'data', 'train.json'); let replaced = false
    expect(() => captureFrozenFileAttempt(paths.root, manifest, { afterOpen(path) {
      if (replaced || path !== dataset) return
      replaced = true; renameSync(dataset, `${dataset}.old`); writeFileSync(dataset, '{"rows":1}\n')
    } })).toThrowError(expect.objectContaining({ name: 'TypeError', message: 'frozen registration file changed while it was read' }))
  })

  it('normalizes only algorithm-qualified external dataset identity without creating local manifest paths', () => {
    const paths = fixture()
    const normalized = normalizeEvaluatorRegistration({ evaluatorId: 'external', command: 'node', args: [], environment: {}, metricName: 'score', metricDirection: 'maximize', evaluatorFiles: ['bench/evaluate.mjs'], dataset: { kind: 'external', digest: `sha256:${'a'.repeat(64)}` } })
    expect(normalized.dataset).toEqual({ kind: 'external', digest: `sha256:${'a'.repeat(64)}` })
    expect(Object.keys(deriveRegistrationManifest(paths.root, normalized))).toEqual(['bench/evaluate.mjs'])
    expect(() => normalizeEvaluatorRegistration({ ...normalized, dataset: { kind: 'external', digest: 'a'.repeat(64) as never } })).toThrow(/algorithm-qualified/)
  })
  it('remains unreachable from production start, resume, controller, and recovery routes', () => {
    const inertSymbols = /EVALUATOR_CONTRACT_GENERATION|deriveRegistrationManifestAtStartCommit|deriveRegistrationManifest|captureFrozenFileAttempt|revalidateFrozenFileAttempt|recomputeRegistrationManifest|validateFrozenCandidatePaths/
    for (const path of ['src/index.ts', 'src/controller.ts', 'src/recovery.ts']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(inertSymbols)
    }
  })
})

describe('host-owned evaluator execution', () => {
  it('spawns exact argv/cwd/env, freezes provenance, persists facts in order, and retains bounded artifacts', async () => {
    const setup = options()
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'measured', metric: 1.5, exit: { providerPid: 4242, exitCode: 0, timedOut: false, cancelled: false, processTreeQuiescent: true } })
    expect(setup.runtime.spec).toMatchObject({
      argv: ['node', 'evaluate.mjs'], cwd: join(setup.paths.root, 'bench'), env: { LANG: 'C' }, graceMs: 25,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 128, spill: { maxBytes: 128 } }, stderr: { maxBytes: 64, spill: { maxBytes: 64 } } },
    })
    expect(result.artifacts.map(item => [item.kind, readFileSync(setup.artifactWriter.internalPath(item.kind), 'utf8')])).toEqual([['stdout', '{"score":1.5}\n'], ['stderr', '']])
    expect(setup.runtime.waited).toBe(1)
  })
  it('mints the artifact writer only after durable spawn intent succeeds', async () => {
    const setup = options()
    const factory = vi.fn(setup.value.artifactWriterFactory)
    setup.value.artifactWriterFactory = factory
    setup.value.persistence.persistSpawnIntent = () => { throw new Error('intent failed') }
    await expect(runEvaluator(setup.value)).rejects.toThrow('intent failed')
    expect(factory).not.toHaveBeenCalled()

    const successful = options()
    const events: string[] = []
    successful.value.persistence.persistSpawnIntent = () => { events.push('intent') }
    const mint = successful.value.artifactWriterFactory
    successful.value.artifactWriterFactory = () => { events.push('mint'); return mint() }
    await runEvaluator(successful.value)
    expect(events.slice(0, 2)).toEqual(['intent', 'mint'])
  })


  it('passes raw environment only to spawn and hashes or redacts every durable and returned surface', async () => {
    const secret = 'innocuous-name-secret-value'
    const runtime = fakeRuntime({ stdout: reader(`log ${secret}\n{"score":2}\n`), stderr: reader(`warning ${secret}\n`) })
    const setup = options(runtime, { environment: { ORDINARY: secret } })
    const result = await runEvaluator(setup.value)
    expect(runtime.spec?.env).toEqual({ ORDINARY: secret })
    expect(setup.value.persistence.intent?.env.ORDINARY).toMatch(/^sha256:/)
    expect(setup.value.persistence.intent?.env.ORDINARY).not.toContain(secret)
    expect(result.artifacts.map(item => readFileSync(setup.artifactWriter.internalPath(item.kind), 'utf8')).join('\n')).not.toContain(secret)
    expect(readFileSync(setup.artifactWriter.internalPath('stdout'), 'utf8')).toContain('[REDACTED]')
    const frozen = freezeEvaluatorProvenance(setup.paths.root, { evaluation: setup.value.evaluation, environment: { ORDINARY: secret }, metricName: 'score', metricDirection: 'minimize' })
    expect(frozen.canonical).not.toContain(secret)

    const failing = options(fakeRuntime({ spawnError: new Error(`cannot launch ${secret}`) }), { environment: { ORDINARY: secret } })
    const failure = await runEvaluator(failing.value)
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(JSON.stringify(failing.value.persistence.outcome)).not.toContain(secret)
  })

  it('redacts overlapping secrets longest-first across provenance, artifacts, and persisted failures', async () => {
    const environment = { SHORT: 'abc', LONG: 'abcdef', EMPTY: '', DUPLICATE: 'abc' }
    const paths = fixture()
    const frozen = freezeEvaluatorProvenance(paths.root, {
      evaluation: { command: 'node', args: ['value-abcdef'], cwd: 'bench' },
      dataset: { 'key-abcdef': 'value-abcdef' },
      environment,
      metricName: 'score',
      metricDirection: 'minimize',
      policy: { 'policy-abcdef': 'value-abcdef' },
    })
    const provenance = JSON.parse(frozen.canonical) as { evaluation: { args: string[] }; dataset: Record<string, string> }
    expect(provenance.evaluation.args).toEqual(['value-[REDACTED]'])
    expect(provenance.dataset).toEqual({ 'key-[REDACTED]': 'value-[REDACTED]' })
    expect(frozen.canonical).not.toContain('[REDACTED]def')

    const runtime = fakeRuntime({ stdout: reader('artifact abcdef abc\n{"score":2}\n'), stderr: reader('error abcdef abc\n') })
    const measured = options(runtime, { environment })
    const result = await runEvaluator(measured.value)
    const artifactText = result.artifacts.map(item => readFileSync(measured.artifactWriter.internalPath(item.kind), 'utf8')).join('\n')
    expect(artifactText).toContain('artifact [REDACTED] [REDACTED]')
    expect(artifactText).not.toContain('[REDACTED]def')
    expect(JSON.stringify(result)).not.toContain('[REDACTED]def')

    const failing = options(fakeRuntime({ spawnError: new Error('cannot launch abcdef abc') }), { environment })
    const failure = await runEvaluator(failing.value)
    expect(failure).toMatchObject({ kind: 'failed', message: 'cannot launch [REDACTED] [REDACTED]' })
    expect(failing.value.persistence.outcome?.[0]).toMatchObject({ kind: 'failed', message: 'cannot launch [REDACTED] [REDACTED]', exit: { failureMessage: 'cannot launch [REDACTED] [REDACTED]' } })
    expect(JSON.stringify(failing.value.persistence.intent)).not.toContain('[REDACTED]def')
    expect(JSON.stringify(failing.value.persistence.outcome)).not.toContain('[REDACTED]def')
  })

  it('hashes argv, files, dataset, environment, parser, metric, direction, and policy deterministically', () => {
    const paths = fixture()
    const first = freezeEvaluatorProvenance(paths.root, { evaluation: { command: 'node', args: ['x'], cwd: 'bench' }, evaluatorFiles: ['bench/evaluate.mjs'], dataset: { z: '2', a: '1' }, environment: { B: '2', A: '1' }, metricName: 'score', metricDirection: 'maximize', policy: { tie: 'reject' } })
    const reordered = freezeEvaluatorProvenance(paths.root, { evaluation: { command: 'node', args: ['x'], cwd: 'bench' }, evaluatorFiles: ['bench/evaluate.mjs'], dataset: { a: '1', z: '2' }, environment: { A: '1', B: '2' }, metricName: 'score', metricDirection: 'maximize', policy: { tie: 'reject' } })
    expect(first.sha256).toBe(reordered.sha256)
    writeFileSync(join(paths.root, 'bench', 'evaluate.mjs'), 'changed\n')
    expect(freezeEvaluatorProvenance(paths.root, { evaluation: { command: 'node', args: ['x'], cwd: 'bench' }, evaluatorFiles: ['bench/evaluate.mjs'], metricName: 'score', metricDirection: 'maximize' }).sha256).not.toBe(first.sha256)
  })

  it('uses an independent wall clock, terminates the provider-owned tree, awaits quiescence, and classifies timeout', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime({ settleOnAbort: true })
      const setup = options(runtime, { timeoutMs: 50 })
      const pending = runEvaluator(setup.value)
      await vi.advanceTimersByTimeAsync(50)
      const result = await pending
      expect(result).toMatchObject({ kind: 'failed', code: 'timeout', exit: { timedOut: true, cancelled: false, processTreeQuiescent: true } })
      expect(runtime.terminated).toBe(1)
      expect(runtime.waited).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('classifies caller cancellation separately and does not call the shell', async () => {
    const controller = new AbortController()
    const runtime = fakeRuntime({ settleOnAbort: true })
    const setup = options(runtime, { signal: controller.signal })
    const pending = runEvaluator(setup.value)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ kind: 'failed', code: 'cancelled', exit: { timedOut: false, cancelled: true } })
    expect(runtime.spec?.argv).toEqual(['node', 'evaluate.mjs'])
    expect(runtime.terminated).toBe(1)
  })

  it('records a durable cancelled no-spawn outcome for an already-aborted caller', async () => {
    const controller = new AbortController(); controller.abort()
    const runtime = fakeRuntime()
    const setup = options(runtime, { signal: controller.signal })
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'failed', code: 'cancelled', exit: { cancelled: true, processTreeQuiescent: true } })
    expect(result.exit).not.toHaveProperty('providerPid')
    expect(runtime.spec).toBeUndefined()
    expect(setup.value.persistence.events).toEqual(['intent', 'outcome'])
    expect(setup.value.persistence.observed).toBeUndefined()
    expect(setup.value.persistence.outcome?.[0]).toMatchObject({ kind: 'failed', code: 'cancelled', exit: { cancelled: true, exitCode: null, signal: null } })
  })

  it('atomically observes cancellation that races listener registration without spawning', async () => {
    const controller = new AbortController()
    const racingSignal = {
      get aborted() { return controller.signal.aborted },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        controller.abort()
        controller.signal.addEventListener(type, listener, options)
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
        controller.signal.removeEventListener(type, listener, options)
      },
    } as AbortSignal
    const runtime = fakeRuntime()
    const setup = options(runtime, { signal: racingSignal })

    const result = await runEvaluator(setup.value)

    expect(result).toMatchObject({ kind: 'failed', code: 'cancelled', exit: { cancelled: true, processTreeQuiescent: true } })
    expect(result.exit).not.toHaveProperty('providerPid')
    expect(runtime.spec).toBeUndefined()
    expect(setup.value.persistence.events).toEqual(['intent', 'outcome'])
  })

  it.each(['timeout', 'repeated-cancellation'] as const)('kills a real evaluator descendant tree before persisting %s', async mode => {
    const paths = fixture()
    const childPidPath = join(paths.root, 'child.pid')
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))`,
      "setInterval(() => {}, 1000)",
    ].join(';')
    const controller = new AbortController()
    const durable = persistence()
    const evaluation = { command: process.execPath, args: ['-e', script], cwd: 'bench' }
    const pending = runEvaluator({
      subprocess: new LocalSubprocess(), worktree: paths.root,
      boundary: createEvaluatorBoundary(paths.root, { evaluation, normalizedPolicySha256: 'b'.repeat(64) }),
      evaluation,
      metricName: 'score', metricDirection: 'minimize', timeoutMs: mode === 'timeout' ? 150 : 5_000,
      terminationGraceMs: 30, maxStdoutBytes: 128, maxStderrBytes: 64,
      artifactWriterFactory: () => EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', mode), persistence: durable,
      ...(mode === 'repeated-cancellation' ? { signal: controller.signal } : {}),
    })
    while (!readFileExists(childPidPath)) await new Promise(resolve => setTimeout(resolve, 5))
    const childPid = Number(readFileSync(childPidPath, 'utf8'))
    if (mode === 'repeated-cancellation') { controller.abort(); controller.abort() }
    const result = await pending
    expect(result).toMatchObject({ kind: 'failed', code: mode === 'timeout' ? 'timeout' : 'cancelled', exit: { processTreeQuiescent: true } })
    expect(durable.events.at(-1)).toBe('outcome')
    await expectProcessTerminated(childPid)
  }, 10_000)

  it('rejects lossy stdout as non-authoritative while persisting its bounded tail', async () => {
    const setup = options(fakeRuntime({ stdout: reader('tail without full metric', true) }))
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'failed', code: 'output-limit' })
    expect(result.artifacts[0]).toMatchObject({ kind: 'stdout', truncated: true, sizeBytes: 24 })
  })

  it('marks and persists lossy stderr while preserving authoritative stdout', async () => {
    const setup = options(fakeRuntime({ stderr: reader('bounded stderr tail', true) }))
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'measured', metric: 1.5 })
    expect(result.artifacts[1]).toMatchObject({ kind: 'stderr', truncated: true, sizeBytes: 19 })
    expect(setup.value.persistence.outcome?.[1][1]).toMatchObject({ kind: 'stderr', truncated: true })
  })

  it('persists a parsed numeric metric before secret redaction destroys artifact JSON', async () => {
    const setup = options(fakeRuntime({ stdout: reader('{"score":1}\n') }), { environment: { ORDINARY: '1' } })
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'measured', metric: 1 })
    expect(readFileSync(setup.artifactWriter.internalPath('stdout'), 'utf8')).toBe('{"score":[REDACTED]}\n')
    expect(setup.value.persistence.outcome?.[0]).toMatchObject({ kind: 'measured', metric: 1 })
  })

  it('persists a bounded complete spill artifact and parses it when the in-memory read is lossless', async () => {
    const paths = fixture()
    const spill = join(paths.root, 'spill.log')
    writeFileSync(spill, 'log\n{"score":4}\n')
    const runtime = fakeRuntime({ stdout: reader('log\n{"score":4}\n', false, spill) })
    const setup = options(runtime)
    const result = await runEvaluator(setup.value)
    expect(readFileSync(setup.artifactWriter.internalPath('stdout'), 'utf8')).toBe('log\n{"score":4}\n')
  })

  it.each([
    [{ exitCode: 7 }, 'exit', { exitCode: 7, signal: null }],
    [{ signal: 'SIGTERM' as NodeJS.Signals, exitCode: null }, 'signal', { exitCode: null, signal: 'SIGTERM' }],
    [{ waitQuiescent: false }, 'signal', { exitCode: 0, signal: null }],
    [{ spawnError: new Error('ENOENT') }, 'spawn', { exitCode: null, signal: null }],
    [{ stdout: reader('{"wrong":1}\n') }, 'metric-protocol', { exitCode: 0, signal: null }],
  ])('classifies and persists exit, signal, quiescence, spawn, and parse failures %#', async (fake, code, persisted) => {
    const setup = options(fakeRuntime(fake))
    await expect(runEvaluator(setup.value)).resolves.toMatchObject({ kind: 'failed', code })
    expect(setup.value.persistence.events[0]).toBe('intent')
    expect(setup.value.persistence.events.at(-1)).toBe('outcome')
    expect(setup.value.persistence.outcome?.[0]).toMatchObject({ kind: 'failed', code, exit: persisted })
  })

  it('rejects lexical and symlink cwd/file escapes before spawn', async () => {
    const escaping = options(fakeRuntime(), { evaluation: { command: 'node', args: [], cwd: '../outside' } })
    await expect(runEvaluator(escaping.value)).rejects.toThrow(/escapes/)
    expect(escaping.runtime.spec).toBeUndefined()

    const outside = mkdtempSync(join(tmpdir(), 'autoresearch-outside-')); roots.push(outside)
    writeFileSync(join(outside, 'evaluate.mjs'), 'outside\n')
    const cwdLink = options()
    rmSync(join(cwdLink.paths.root, 'bench'), { recursive: true })
    symlinkSync(outside, join(cwdLink.paths.root, 'bench'), 'dir')
    await expect(runEvaluator(cwdLink.value)).rejects.toThrow(/symbolic link/)
    expect(cwdLink.runtime.spec).toBeUndefined()

    const fileLink = options()
    rmSync(join(fileLink.paths.root, 'bench', 'evaluate.mjs'))
    symlinkSync(join(outside, 'evaluate.mjs'), join(fileLink.paths.root, 'bench', 'evaluate.mjs'))
    expect(() => freezeEvaluatorProvenance(fileLink.paths.root, { evaluation: fileLink.value.evaluation, evaluatorFiles: ['bench/evaluate.mjs'], metricName: 'score', metricDirection: 'minimize' })).toThrow(/symbolic link/)

    const intermediate = options()
    mkdirSync(join(intermediate.paths.root, 'inside'))
    writeFileSync(join(intermediate.paths.root, 'inside', 'evaluate.mjs'), 'inside\n')
    symlinkSync(join(intermediate.paths.root, 'inside'), join(intermediate.paths.root, 'linked'), 'dir')
    expect(() => freezeEvaluatorProvenance(intermediate.paths.root, { evaluation: intermediate.value.evaluation, evaluatorFiles: ['linked/evaluate.mjs'], metricName: 'score', metricDirection: 'minimize' })).toThrow(/symbolic link/)
  })

  it('terminates a spawn when the validated cwd is replaced during startup', async () => {
    const setup = options()
    const originalSpawn = setup.runtime.runtime.spawn
    setup.runtime.runtime.spawn = spec => {
      const handle = originalSpawn(spec)
      rmSync(join(setup.paths.root, 'bench'), { recursive: true })
      symlinkSync(tmpdir(), join(setup.paths.root, 'bench'), 'dir')
      return handle
    }
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'failed', code: 'spawn', exit: { processTreeQuiescent: true } })
    expect(setup.runtime.terminated).toBe(1)
  })

  it('binds cwd and argv to the frozen normalized policy and immutable controller worktree identity', async () => {
    const mismatchedPolicy = options(fakeRuntime(), { evaluation: { command: 'node', args: ['evaluate.mjs'], cwd: 'bench' } })
    mismatchedPolicy.value.boundary = createEvaluatorBoundary(mismatchedPolicy.paths.root, { evaluation: { command: 'node', args: ['other.mjs'], cwd: 'bench' }, normalizedPolicySha256: 'a'.repeat(64), evaluatorFiles: ['bench/evaluate.mjs'] })
    await expect(runEvaluator(mismatchedPolicy.value)).rejects.toThrow(/frozen normalized policy/)
    expect(mismatchedPolicy.runtime.spec).toBeUndefined()

    const replaced = options()
    const displaced = `${replaced.paths.root}-displaced`
    roots.push(displaced)
    renameSync(replaced.paths.root, displaced)
    mkdirSync(replaced.paths.root)
    mkdirSync(join(replaced.paths.root, 'bench'))
    writeFileSync(join(replaced.paths.root, 'bench', 'evaluate.mjs'), 'replacement\n')
    await expect(runEvaluator(replaced.value)).rejects.toThrow(/worktree identity changed/)
    expect(replaced.runtime.spec).toBeUndefined()

    const alias = options()
    const link = `${alias.paths.root}-alias`; roots.push(link)
    symlinkSync(alias.paths.root, link, 'dir')
    alias.value.worktree = link
    await expect(runEvaluator(alias.value)).rejects.toThrow(/controller-supplied canonical worktree/)
    expect(alias.runtime.spec).toBeUndefined()
  })

  it('binds provenance to the normalized policy hash and hashes canonical file bytes independent of input ordering', async () => {
    const setup = options()
    writeFileSync(join(setup.paths.root, 'bench', 'second.mjs'), 'second\n')
    const input = { evaluation: setup.value.evaluation, evaluatorFiles: ['bench/second.mjs', 'bench/evaluate.mjs'], metricName: 'score', metricDirection: 'minimize' as const, policy: { normalizedPolicySha256: 'a'.repeat(64) } }
    const first = freezeEvaluatorProvenance(setup.paths.root, input)
    const reordered = freezeEvaluatorProvenance(realpathSync(setup.paths.root), { ...input, evaluatorFiles: [...input.evaluatorFiles].reverse() })
    expect(first).toEqual(reordered)
    expect(freezeEvaluatorProvenance(setup.paths.root, { ...input, policy: { normalizedPolicySha256: 'b'.repeat(64) } }).sha256).not.toBe(first.sha256)
    expect(() => freezeEvaluatorProvenance(setup.paths.root, { ...input, evaluatorFiles: ['/etc/passwd'] })).toThrow(/relative/)
    expect(() => freezeEvaluatorProvenance(setup.paths.root, { ...input, evaluatorFiles: ['../outside'] })).toThrow(/escapes/)

    const original = join(setup.paths.root, 'bench', 'evaluate.mjs')
    const moved = join(setup.paths.root, 'bench', 'old.mjs')
    const before = freezeEvaluatorProvenance(setup.paths.root, { ...input, evaluatorFiles: ['bench/evaluate.mjs'] })
    renameSync(original, moved)
    writeFileSync(original, 'replacement bytes\n')
    const after = freezeEvaluatorProvenance(setup.paths.root, { ...input, evaluatorFiles: ['bench/evaluate.mjs'] })
    expect(after.sha256).not.toBe(before.sha256)
    expect(after.evaluatorFileHashes['bench/evaluate.mjs']).not.toBe(before.evaluatorFileHashes['bench/evaluate.mjs'])
  })

  it('redacts environment values from every failure, persistence error, and spill surface', async () => {
    const secret = 'raw-environment-value-never-durable'
    const failures: FakeOptions[] = [
      { exitCode: 9, stdout: reader(`${secret}\n`) },
      { signal: 'SIGTERM', exitCode: null, stderr: reader(secret) },
      { waitQuiescent: false, stdout: reader(secret) },
      { spawnError: new Error(secret) },
      { stdout: reader(`${secret}\n{"wrong":1}\n`) },
      { stdout: reader(secret, true) },
    ]
    for (const fake of failures) {
      const setup = options(fakeRuntime(fake), { environment: { ORDINARY: secret }, policy: { note: secret } })
      const result = await runEvaluator(setup.value)
      expect(result.artifacts.map(item => readFileSync(setup.artifactWriter.internalPath(item.kind), 'utf8')).join('\n')).not.toContain(secret)
    }

    const spillSetup = options(fakeRuntime())
    const spill = join(spillSetup.paths.root, 'secret-spill.log')
    writeFileSync(spill, `${secret}\n{"score":3}\n`)
    const spillRuntime = fakeRuntime({ stdout: reader(`${secret}\n{"score":3}\n`, false, spill), stderr: reader(secret) })
    const spilled = options(spillRuntime, { environment: { ORDINARY: secret } })
    const spillResult = await runEvaluator(spilled.value)
    expect(spillResult.artifacts.map(item => readFileSync(spilled.artifactWriter.internalPath(item.kind), 'utf8')).join('\n')).not.toContain(secret)

    const throwing = options(fakeRuntime(), { environment: { ORDINARY: secret } })
    throwing.value.persistence.persistSpawnObserved = () => { throw new Error(secret) }
    await expect(runEvaluator(throwing.value)).resolves.toMatchObject({ kind: 'failed', code: 'spawn', message: '[REDACTED]' })
    const outcomeThrowing = options(fakeRuntime(), { environment: { ORDINARY: secret } })
    outcomeThrowing.value.persistence.persistAttemptOutcome = () => { throw new Error(secret) }
    await expect(runEvaluator(outcomeThrowing.value)).rejects.toThrow('[REDACTED]')
    await expect(runEvaluator(outcomeThrowing.value)).rejects.not.toThrow(secret)
  })

  it.each([
    [{ exitCode: 23 }, { exitCode: 23, signal: null }],
    [{ exitCode: null, signal: 'SIGINT' as NodeJS.Signals }, { exitCode: null, signal: 'SIGINT' }],
  ])('returns and durably persists exact exit facts %#', async (fake, expected) => {
    const setup = options(fakeRuntime(fake))
    const result = await runEvaluator(setup.value)
    expect(result.exit).toMatchObject(expected)
    expect(setup.value.persistence.outcome?.[0]).toMatchObject({ exit: expected })
  })

  it.each(['stdout', 'stderr'] as const)('enforces a real subprocess %s cap with bounded artifacts', async stream => {
    const paths = fixture()
    const payload = 'x'.repeat(512)
    const script = stream === 'stdout'
      ? `process.stdout.write(${JSON.stringify(payload + '\n{"score":5}\n')})`
      : `process.stderr.write(${JSON.stringify(payload)});process.stdout.write('{"score":5}\\n')`
    const evaluation = { command: process.execPath, args: ['-e', script], cwd: 'bench' }
    const durable = persistence()
    const result = await runEvaluator({
      subprocess: new LocalSubprocess(), worktree: paths.root,
      boundary: createEvaluatorBoundary(paths.root, { evaluation, normalizedPolicySha256: 'c'.repeat(64) }),
      evaluation, metricName: 'score', metricDirection: 'minimize', timeoutMs: 2_000, terminationGraceMs: 25,
      maxStdoutBytes: 64, maxStderrBytes: 48, artifactWriterFactory: () => EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', stream), persistence: durable,
    })
    expect(result).toMatchObject(stream === 'stdout' ? { kind: 'failed', code: 'output-limit' } : { kind: 'measured', metric: 5 })
    const artifact = result.artifacts.find(item => item.kind === stream)!
    expect(artifact.truncated).toBe(true)
    expect(artifact.sizeBytes).toBeLessThanOrEqual(stream === 'stdout' ? 64 : 48)
    expect(durable.outcome?.[1].find(item => item.kind === stream)).toMatchObject({ truncated: true })
  })


  it('owns a deeply frozen evaluation snapshot and detects original alias mutation by digest', async () => {
    const setup = options()
    const original = { command: 'node', args: ['evaluate.mjs'], cwd: 'bench' }
    const boundary = createEvaluatorBoundary(setup.paths.root, { evaluation: original, normalizedPolicySha256: 'd'.repeat(64), evaluatorFiles: ['bench/evaluate.mjs'] })
    original.args[0] = 'mutated.mjs'
    original.cwd = '.'
    expect(boundary.normalizedEvaluation).toEqual({ command: 'node', args: ['evaluate.mjs'], cwd: 'bench' })
    expect(Object.isFrozen(boundary.normalizedEvaluation)).toBe(true)
    expect(Object.isFrozen(boundary.normalizedEvaluation.args)).toBe(true)
    setup.value.evaluation = original
    setup.value.boundary = boundary
    await expect(runEvaluator(setup.value)).rejects.toThrow(/policy digest/)
    expect(setup.runtime.spec).toBeUndefined()
  })

  it('exposes and immediately revalidates an immutable declared-file manifest before spawn', async () => {
    const setup = options()
    expect(setup.value.boundary.declaredFiles).toEqual([expect.objectContaining({ path: 'bench/evaluate.mjs', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })])
    expect(Object.isFrozen(setup.value.boundary.declaredFiles)).toBe(true)
    writeFileSync(join(setup.paths.root, 'bench', 'evaluate.mjs'), 'changed after boundary\n')
    await expect(runEvaluator(setup.value)).rejects.toThrow(/declared evaluator file changed/)
    expect(setup.runtime.spec).toBeUndefined()
  })

  it('redacts secret aliases in argv, cwd, nested policy, persistence errors, results, logs, and artifact metadata', async () => {
    const secret = 'secret-cwd-token'
    const paths = fixture()
    mkdirSync(join(paths.root, secret))
    writeFileSync(join(paths.root, secret, 'evaluate.mjs'), 'fixture\n')
    const evaluation = { command: 'node', args: [secret], cwd: secret }
    const boundary = createEvaluatorBoundary(paths.root, { evaluation, normalizedPolicySha256: 'e'.repeat(64), evaluatorFiles: [`${secret}/evaluate.mjs`] })
    const durable = persistence()
    const result = await runEvaluator({ subprocess: fakeRuntime({ stdout: reader(`${secret}\n{"score":1}\n`) }).runtime, worktree: paths.root, boundary, evaluation,
      metricName: 'score', metricDirection: 'minimize', timeoutMs: 1000, terminationGraceMs: 25, maxStdoutBytes: 128, maxStderrBytes: 64,
      artifactWriterFactory: () => EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'secret-test'), environment: { TOKEN: secret }, policy: { nested: [secret] }, persistence: durable })
    expect(JSON.stringify({ result, intent: durable.intent, outcome: durable.outcome })).not.toContain(secret)
    expect(durable.intent?.argv).toEqual(['node', '[REDACTED]'])
    expect(durable.intent?.cwd).toContain('[REDACTED]')
    expect(result.artifacts.every(item => !item.location.includes(secret))).toBe(true)
  })

  it('redacts nested provenance keys and evaluator path keys, including secrets embedded in temp paths', async () => {
    const secret = 'secret-temp-alias'
    const root = mkdtempSync(join(tmpdir(), `${secret}-worktree-`)); roots.push(root)
    const artifacts = mkdtempSync(join(tmpdir(), `${secret}-artifacts-`)); roots.push(artifacts)
    mkdirSync(join(root, secret))
    writeFileSync(join(root, secret, 'evaluate.mjs'), 'fixture\n')
    const evaluation = { command: 'node', args: ['evaluate.mjs'], cwd: secret }
    const frozen = freezeEvaluatorProvenance(root, {
      evaluation, evaluatorFiles: [`${secret}/evaluate.mjs`], environment: { TOKEN: secret },
      dataset: { [`dataset-${secret}`]: 'value' }, metricName: 'score', metricDirection: 'minimize',
      policy: { outer: { [`path-${secret}`]: { [`${secret}-leaf`]: 'value' } } },
    })
    expect(frozen.canonical).not.toContain(secret)
    expect(Object.keys(frozen.evaluatorFileHashes)).toEqual(['[REDACTED]/evaluate.mjs'])

    const writer = EvaluatorArtifactWriter.mint(StateLayout.open(artifacts), 'run', 'experiment', 'opaque')
    const records = writer.write(reader('ok'), reader(''), [secret])
    expect(records.every(record => /^artifact:sha256:[0-9a-f]{64}$/u.test(record.location))).toBe(true)
    expect(JSON.stringify(records)).not.toContain(secret)
    expect(readFileSync(writer.internalPath('stdout'), 'utf8')).toBe('ok')
  })

  it('terminates and persists failure when a declared file is replaced during spawn', async () => {
    const setup = options()
    const originalSpawn = setup.runtime.runtime.spawn
    setup.runtime.runtime.spawn = spec => {
      const handle = originalSpawn(spec)
      const evaluator = join(setup.paths.root, 'bench', 'evaluate.mjs')
      renameSync(evaluator, `${evaluator}.old`)
      writeFileSync(evaluator, 'replacement after spawn\n')
      return handle
    }
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'failed', code: 'spawn', exit: { processTreeQuiescent: true } })
    expect(setup.runtime.terminated).toBe(1)
    expect(setup.runtime.waited).toBe(1)
    expect(setup.value.persistence.events).toEqual(['intent', 'outcome'])
    expect(setup.value.persistence.outcome?.[0]).toMatchObject({ kind: 'failed', code: 'spawn', exit: { failureCode: 'spawn', processTreeQuiescent: true } })
  })

  it('writes artifacts exclusively under an owner-only StateLayout capability', async () => {
    const paths = fixture()
    const writer = EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'secure')
    const result = writer.write(reader('ok'), reader('err'), [])
    expect(result.every(item => /^artifact:sha256:[0-9a-f]{64}$/u.test(item.location))).toBe(true)
    expect(statSync(writer.attemptDirectory).mode & 0o077).toBe(0)
    expect((statSync(writer.internalPath('stdout')).mode & 0o077) === 0).toBe(true)
    expect((statSync(writer.internalPath('stderr')).mode & 0o077) === 0).toBe(true)
    expect(() => writer.write(reader('again'), reader('again'), [])).toThrow(/single-use/)

    const collision = EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'collision')
    writeFileSync(join(collision.attemptDirectory, 'stdout.log'), 'occupied')
    expect(() => collision.write(reader('outside'), reader(''), [])).toThrow()
    expect(readFileSync(join(collision.attemptDirectory, 'stdout.log'), 'utf8')).toBe('occupied')

    const linked = EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'linked')
    const outside = mkdtempSync(join(tmpdir(), 'autoresearch-artifact-outside-')); roots.push(outside)
    symlinkSync(join(outside, 'captured'), join(linked.attemptDirectory, 'stdout.log'))
    expect(() => linked.write(reader('escape'), reader(''), [])).toThrow()
    expect(() => lstatSync(join(outside, 'captured'))).toThrow()

    const replaced = EvaluatorArtifactWriter.mint(StateLayout.open(paths.artifacts), 'run', 'experiment', 'replaced-parent')
    const displaced = `${replaced.attemptDirectory}-old`
    renameSync(replaced.attemptDirectory, displaced)
    symlinkSync(outside, replaced.attemptDirectory, 'dir')
    expect(() => replaced.write(reader('escape'), reader(''), [])).toThrow(/directory identity changed/)
    expect(() => lstatSync(join(outside, 'stdout.log'))).toThrow()
  })

  it('rejects symlinked provider spills without copying them', async () => {
    const setup = options()
    const outside = join(setup.paths.root, 'outside-spill')
    writeFileSync(outside, 'unsafe')
    const spill = join(setup.paths.root, 'spill-link')
    symlinkSync(outside, spill)
    setup.runtime.runtime.spawn = () => fakeRuntime({ stdout: reader('unsafe', false, spill) }).runtime.spawn({ argv: ['x'], cwd: setup.paths.root, env: {}, stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' } })
    await expect(runEvaluator(setup.value)).rejects.toThrow(/spill.*symlink/)
  })

  it('supports arbitrary override names but rejects managed environment keys', async () => {
    const supported = options(fakeRuntime(), { environment: { API_TOKEN: 'supported-secret' } })
    await expect(runEvaluator(supported.value)).resolves.toMatchObject({ kind: 'measured' })
    const managed = options(fakeRuntime(), { environment: { DSH_TOKEN: 'secret' } })
    await expect(runEvaluator(managed.value)).rejects.toThrow(/unsafe evaluator environment key/)
  })
})

function readFileExists(path: string): boolean {
  try { readFileSync(path); return true } catch { return false }
}

async function expectProcessTerminated(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let linuxState: string | undefined
  do {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    linuxState = process.platform === 'linux' ? readLinuxProcessState(pid) : undefined
    if (process.platform === 'linux' && linuxState === undefined) return
    await delay(10)
  } while (Date.now() < deadline)

  if (linuxState === 'Z') return
  throw new Error(`evaluator descendant ${pid} remained alive${linuxState === undefined ? '' : ` in Linux process state ${linuxState}`}`)
}

function readLinuxProcessState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return undefined
    throw error
  }
}
