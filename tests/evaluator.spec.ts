import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { freezeEvaluatorProvenance, parseFinalLineMetric, runEvaluator } from '../src/evaluator.ts'
import type { EvaluatorPersistence } from '../src/evaluator.ts'

interface FakeOptions {
  stdout?: SubprocessOutputRead
  stderr?: SubprocessOutputRead
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  waitQuiescent?: boolean
  settleOnAbort?: boolean
  spawnError?: Error
}

function fixture(): { root: string; artifacts: string } {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-evaluator-'))
  const artifacts = join(root, '.artifacts')
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
        const normal = (): void => settle({ exitCode: options.exitCode ?? 0, signal: options.signal ?? null })
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

function persistence(): EvaluatorPersistence & { events: string[]; outcome?: Parameters<EvaluatorPersistence['persistAttemptOutcome']> } {
  const state: EvaluatorPersistence & { events: string[]; outcome?: Parameters<EvaluatorPersistence['persistAttemptOutcome']> } = {
    events: [],
    persistSpawnIntent: () => { state.events.push('intent') },
    persistSpawnObserved: () => { state.events.push('observed') },
    persistAttemptOutcome: (...facts) => { state.events.push('outcome'); state.outcome = facts },
  }
  return state
}

function options(runtime = fakeRuntime(), overrides: Record<string, unknown> = {}) {
  const paths = fixture()
  return {
    runtime,
    paths,
    value: {
      subprocess: runtime.runtime,
      worktree: paths.root,
      evaluation: { command: 'node', args: ['evaluate.mjs'], cwd: 'bench' },
      metricName: 'score', metricDirection: 'minimize' as const,
      timeoutMs: 1_000, terminationGraceMs: 25, maxStdoutBytes: 128, maxStderrBytes: 64,
      artifactDirectory: paths.artifacts, artifactPrefix: 'attempt-1', environment: { LANG: 'C' },
      evaluatorFiles: ['bench/evaluate.mjs'], dataset: { version: 'v1', name: 'fixture' }, policy: { tie: 'reject' },
      persistence: persistence(),
      ...overrides,
    },
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

describe('host-owned evaluator execution', () => {
  it('spawns exact argv/cwd/env, freezes provenance, persists facts in order, and retains bounded artifacts', async () => {
    const setup = options()
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'measured', metric: 1.5, exit: { providerPid: 4242, exitCode: 0, timedOut: false, cancelled: false, processTreeQuiescent: true } })
    expect(setup.runtime.spec).toMatchObject({
      argv: ['node', 'evaluate.mjs'], cwd: join(setup.paths.root, 'bench'), env: { LANG: 'C' }, graceMs: 25,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 128, spill: { maxBytes: 128 } }, stderr: { maxBytes: 64, spill: { maxBytes: 64 } } },
    })
    expect(setup.value.persistence.events).toEqual(['intent', 'observed', 'outcome'])
    expect(result.artifacts.map(item => [item.kind, readFileSync(item.location, 'utf8')])).toEqual([['stdout', '{"score":1.5}\n'], ['stderr', '']])
    expect(setup.runtime.waited).toBe(1)
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

  it('rejects lossy stdout as non-authoritative while persisting its bounded tail', async () => {
    const setup = options(fakeRuntime({ stdout: reader('tail without full metric', true) }))
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'failed', code: 'output-limit' })
    expect(result.artifacts[0]).toMatchObject({ kind: 'stdout', truncated: true, sizeBytes: 24 })
  })

  it('persists a bounded complete spill artifact and parses it when the in-memory read is lossless', async () => {
    const paths = fixture()
    const spill = join(paths.root, 'spill.log')
    writeFileSync(spill, 'log\n{"score":4}\n')
    const runtime = fakeRuntime({ stdout: reader('log\n{"score":4}\n', false, spill) })
    const setup = options(runtime, { artifactDirectory: paths.artifacts })
    const result = await runEvaluator(setup.value)
    expect(result).toMatchObject({ kind: 'measured', metric: 4 })
    expect(readFileSync(result.artifacts[0]!.location, 'utf8')).toBe('log\n{"score":4}\n')
  })

  it.each([
    [{ exitCode: 7 }, 'exit'],
    [{ signal: 'SIGTERM' as NodeJS.Signals, exitCode: null }, 'signal'],
    [{ waitQuiescent: false }, 'signal'],
    [{ spawnError: new Error('ENOENT') }, 'spawn'],
    [{ stdout: reader('{"wrong":1}\n') }, 'metric-protocol'],
  ])('classifies exit, signal, quiescence, spawn, and parse failures %#', async (fake, code) => {
    const setup = options(fakeRuntime(fake))
    await expect(runEvaluator(setup.value)).resolves.toMatchObject({ kind: 'failed', code })
    expect(setup.value.persistence.events[0]).toBe('intent')
    expect(setup.value.persistence.events.at(-1)).toBe('outcome')
  })

  it('rejects escaping cwd and credential-shaped or managed environment overrides before spawn', async () => {
    const escaping = options(fakeRuntime(), { evaluation: { command: 'node', args: [], cwd: '../outside' } })
    await expect(runEvaluator(escaping.value)).rejects.toThrow(/escapes/)
    const secret = options(fakeRuntime(), { environment: { API_TOKEN: 'secret' } })
    await expect(runEvaluator(secret.value)).rejects.toThrow(/unsafe evaluator environment key/)
  })
})
