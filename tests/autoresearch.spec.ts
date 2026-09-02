import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobOutcome, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  controllers: [] as Array<{
    ready: Promise<{ runId: string; tracker: string; branch: string; worktree: string }>
    prepare: ReturnType<typeof vi.fn>
    setJobId: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    constructorSignal: AbortSignal
    parent: unknown
  }>,
  preparePromise: undefined as Promise<unknown> | undefined,
  lifecyclePromise: undefined as Promise<unknown> | undefined,
  readyPromise: undefined as Promise<{ runId: string; tracker: string; branch: string; worktree: string }> | undefined,
  rejectReady: undefined as ((reason?: unknown) => void) | undefined,
  cancelPreparation: undefined as ((reason?: string) => void) | undefined,
  preflight: vi.fn(async () => ({
    discovery: { callerCwd: '/repo', repository: '/repo', gitCommonDir: '/repo/.git', startCommit: 'a'.repeat(40) },
    gitExecutable: '/usr/bin/git',
    gitOptions: { timeoutMs: 60_000, graceMs: 1_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 },
  })),
  releaseTool: vi.fn(),
  releasePrompt: vi.fn(),
  startError: undefined as Error | undefined,
  throwAfterRun: false,
  runResult: {
    status: 'budget-limited', runId: 'run-1', tracker: '/tracker.sqlite',
    counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 },
    artifacts: [], best: { metric: 1, commit: 'a'.repeat(40), experimentId: 'baseline' },
  },
}))

vi.mock('../src/controller.js', () => ({
  preflightAutoresearchRepository: state.preflight,
  validateAutoresearchRequest: (config: { evaluatorRegistry: { resolve(id: string): unknown } }, input: { resume_run_id?: string; evaluator_id?: string }) =>
    'resume_run_id' in input ? undefined : config.evaluatorRegistry.resolve(input.evaluator_id ?? ''),
  AutoresearchRunController: class {
    readonly ready: Promise<{ runId: string; tracker: string; branch: string; worktree: string }>
    readonly prepare = vi.fn((_jobId: string) => state.lifecyclePromise ?? state.preparePromise ?? Promise.resolve({ runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' }))
    readonly setJobId = vi.fn()
    readonly cancel = vi.fn((value?: string) => {
      state.rejectReady?.(new Error(value))
      const cancelPreparation = state.cancelPreparation
      state.cancelPreparation = undefined
      cancelPreparation?.(value)
    })
    readonly dispose = vi.fn(async () => { await state.lifecyclePromise?.catch(() => undefined) })
    readonly run = vi.fn(() => state.lifecyclePromise ?? Promise.resolve(state.runResult))
    readonly constructorSignal: AbortSignal
    readonly parent: unknown
    constructor(_ctx: unknown, options: { signal: AbortSignal; parent: unknown }) {
      this.constructorSignal = options.signal
      this.parent = options.parent
      this.ready = state.readyPromise ?? Promise.resolve({ runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' })
      state.controllers.push(this)
    }
  },
}))

import { createEvaluatorRegistry, normalizeRunPolicy, resolveConfig } from '../src/config.ts'
import { apply, inject } from '../src/index.ts'
import { ACTIVATION_AUTORESEARCH_TOOL_SCHEMA } from '../src/types.ts'

interface Harness {
  tool: ToolDefinition
  prompt?: { name: string; order: number; text: string }
  job?: JobStart
  hooks?: JobHooks
  dispose(): Promise<void>
}

function harness(): Harness {
  let tool: ToolDefinition | undefined
  let prompt: Harness['prompt']
  let cleanup: (() => Promise<void>) | undefined
  const value: Harness = {
    get tool() { if (!tool) throw new Error('tool missing'); return tool },
    get prompt() { return prompt },
    get job() { return thisJob },
    get hooks() { return thisHooks },
    async dispose() { await cleanup?.() },
  }
  let thisJob: JobStart | undefined
  let thisHooks: JobHooks | undefined
  const ctx = {
    agents: { create: vi.fn() },
    subprocess: {},
    systemPrompt: { section(section: Harness['prompt']) { prompt = section; return state.releasePrompt } },
    tools: { get: vi.fn(() => undefined), register(definition: ToolDefinition) { tool = definition; return state.releaseTool } },
    jobs: { start(spec: JobStart) { if (state.startError) throw state.startError; thisJob = spec; thisHooks = spec.run(); if (state.throwAfterRun) throw new Error('registry failed after run'); return 'autoresearch-1' } },
    effect(factory: () => () => Promise<void>) { cleanup = factory(); return cleanup },
  }
  apply(ctx as unknown as Context, { evaluatorRegistrations: [{ id: 'judge', command: 'node', args: ['score.mjs'], metricName: 'score', metricDirection: 'minimize', metricParserVersion: 'final-line-json-v1', evaluatorFiles: [] }] })
  return value
}

const input = {
  objective: 'reduce score', run_tag: 'trial', evaluator_id: 'judge', mutable_globs: ['src/**'],
} as const
const parent = { id: 'parent', session: { header: { id: 'session', cwd: '/repo' } } }

async function expectPrompt<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('operation did not settle promptly')), 100)),
  ])
}
const execution = (signal = new AbortController().signal) => ({ agent: parent, signal }) as never

beforeEach(() => {
  state.controllers.length = 0
  state.runResult = { status: 'budget-limited', runId: 'run-1', tracker: '/tracker.sqlite', counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 }, artifacts: [], best: { metric: 1, commit: 'a'.repeat(40), experimentId: 'baseline' } }
  state.preflight.mockClear()
  state.releaseTool.mockClear()
  state.releasePrompt.mockClear()
  state.startError = undefined
  state.throwAfterRun = false
  state.preparePromise = undefined
  state.lifecyclePromise = undefined
  state.readyPromise = undefined
  state.rejectReady = undefined
  state.cancelPreparation = undefined
})

describe('autoresearch Host authority normalization', () => {
  it('derives evaluator argv, metric, environment, and provenance only from the selected registration', () => {
    const registration = createEvaluatorRegistry([{ id: 'judge', command: 'node', args: ['score.mjs'], environment: { SAFE: '1' }, metricName: 'score', metricDirection: 'minimize', metricParserVersion: 'final-line-json-v1', evaluatorFiles: [] }]).resolve('judge')
    expect(normalizeRunPolicy(input, resolveConfig(), '/repo', registration)).toMatchObject({ evaluation: { command: 'node', args: ['score.mjs'] }, metricName: 'score', metricDirection: 'minimize', environment: { SAFE: '1' }, provenance: { evaluator: 'judge' } })
  })
})

describe('autoresearch production wiring', () => {
  it('injects only the controller production services and registers direct-human guidance', () => {
    expect(inject).toEqual(['agents', 'jobs', 'subprocess', 'systemPrompt', 'tools'])
    const test = harness()
    expect(test.tool.name).toBe('autoresearch')
    expect(test.prompt?.text).toBe('Use autoresearch only when the direct human explicitly requests autonomous metric-driven experimentation. For a new run, select a Host-provided evaluator_id and provide a narrow mutable path set. To resume, provide resume_run_id instead; never supply evaluator_id or any other evaluator authority on resume. Runs are background jobs by default and can be inspected or stopped with the generic job tools. Do not invoke it for ordinary coding or open-ended research.')
    expect(JSON.stringify(test.tool.parameters)).not.toContain('evaluation_command')
  })

  it('registers the activated discriminated Host-authority schema', () => {
    const { parameters } = harness().tool
    expect(parameters).toMatchObject({
      type: 'object',
      properties: {
        objective: expect.objectContaining({ type: 'string' }),
        mutable_globs: expect.objectContaining({ type: 'array', items: { type: 'string' } }),
        evaluator_id: expect.objectContaining({ type: 'string' }),
        resume_run_id: expect.objectContaining({ type: 'string' }),
      },
    })
    expect([...parameters.required].sort()).toEqual(['mutable_globs', 'objective'])
    expect(parameters).not.toBe(ACTIVATION_AUTORESEARCH_TOOL_SCHEMA)
    const compiled = JSON.stringify(parameters)
    expect(compiled).not.toContain('evaluation')
    expect(compiled).not.toContain('evaluation_command')
    expect(compiled).not.toContain('environment')
    expect(compiled).not.toContain('metric_direction')
    expect(compiled).not.toContain('metric_name')
    expect(compiled).not.toContain('provenance')
  })

  it('returns the canonical foreground controller result', async () => {
    const test = harness()
    const result = await test.tool.execute({ ...input, mode: 'foreground' }, execution())
    expect(result).toEqual({ kind: 'foreground', run: state.runResult })
    expect(state.controllers[0]?.run).toHaveBeenCalledOnce()
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
    expect(test.job).toBeUndefined()
  })

  it('durably binds the owner job before releasing controller execution and preserves agent identity', async () => {
    const signal = new AbortController().signal
    const test = harness()
    const result = await test.tool.execute(input, execution(signal))
    expect(state.preflight).toHaveBeenCalledOnce()
    expect(state.preflight).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ input, parent, signal }))
    expect(test.job).toMatchObject({ kind: 'autoresearch', owner: parent })
    expect(state.controllers[0]?.parent).toBe(parent)
    expect(state.controllers[0]?.prepare).toHaveBeenCalledWith('autoresearch-1')
    expect(state.controllers[0]?.prepare.mock.invocationCallOrder[0]).toBeLessThan(state.controllers[0]?.run.mock.invocationCallOrder[0] ?? 0)
    expect(result).toEqual({ kind: 'background', jobId: 'autoresearch-1', runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' })
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed', detail: 'budget-limited' })
  })

  it.each([
    ['target-reached', 'completed'],
    ['budget-limited', 'completed'],
    ['baseline-blocked', 'failed'],
    ['blocked', 'failed'],
    ['round-failed', 'failed'],
    ['cancelled', 'killed'],
  ] as const)('maps %s to the generic %s job status', async (status, expected) => {
    state.runResult = { ...state.runResult, status } as never
    const test = harness()
    await test.tool.execute(input, execution())
    await expect(test.hooks?.done).resolves.toMatchObject({ status: expected, detail: status })
  })

  it('does not register a background job when repository preflight rejects the target', async () => {
    state.preflight.mockRejectedValueOnce(new Error('repository target rejected'))
    const test = harness()
    await expect(test.tool.execute(input, execution())).rejects.toThrow('repository target rejected')
    expect(test.job).toBeUndefined()
    expect(state.controllers).toHaveLength(0)
  })

  it('does not register a background job when repository preflight aborts before resolving', async () => {
    const outer = new AbortController()
    const cancellation = new Error('tool turn ended during preflight')
    state.preflight.mockImplementationOnce(async () => {
      outer.abort(cancellation)
      return {
        discovery: { callerCwd: '/repo', repository: '/repo', gitCommonDir: '/repo/.git', startCommit: 'a'.repeat(40) },
        gitExecutable: '/usr/bin/git',
        gitOptions: { timeoutMs: 60_000, graceMs: 1_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 },
      }
    })
    const test = harness()
    await expect(test.tool.execute(input, execution(outer.signal))).rejects.toBe(cancellation)
    expect(test.job).toBeUndefined()
    expect(state.controllers).toHaveLength(0)
  })

  it('does not register a job when the outer signal aborts immediately after preflight', async () => {
    const outer = new AbortController()
    const cancellation = new Error('tool turn ended after preflight')
    state.preflight.mockImplementationOnce(async () => {
      queueMicrotask(() => outer.abort(cancellation))
      return {
        discovery: { callerCwd: '/repo', repository: '/repo', gitCommonDir: '/repo/.git', startCommit: 'a'.repeat(40) },
        gitExecutable: '/usr/bin/git',
        gitOptions: { timeoutMs: 60_000, graceMs: 1_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 },
      }
    })
    const test = harness()
    await expect(test.tool.execute(input, execution(outer.signal))).rejects.toBe(cancellation)
    expect(test.job).toBeUndefined()
    expect(state.controllers).toHaveLength(0)
  })

  it('cancels and settles registration when abort occurs while readiness is pending', async () => {
    const outer = new AbortController()
    const cancellation = new Error('tool turn ended during readiness')
    const pending = Promise.withResolvers<{ runId: string; tracker: string; branch: string; worktree: string }>()
    state.readyPromise = pending.promise
    state.rejectReady = pending.reject
    const test = harness()
    const result = test.tool.execute(input, execution(outer.signal))
    await vi.waitFor(() => expect(state.controllers[0]?.run).toHaveBeenCalledOnce())
    outer.abort(cancellation)
    await expect(result).resolves.toMatchObject({ kind: 'background-start-failed', jobId: 'autoresearch-1', status: 'cancelled', reason: cancellation.message })
    expect(state.controllers[0]?.cancel).toHaveBeenCalledWith(cancellation.message)
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'killed' })
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['generic cancellation', undefined, 'operator stopped startup'],
    ['outer abort', new AbortController(), 'tool turn abandoned startup'],
  ] as const)('returns prompt cancellation during abortable preparation but keeps %s cleanup pending', async (_label, outer, cancellationReason) => {
    const preparation = Promise.withResolvers<never>()
    const cleanup = Promise.withResolvers<void>()
    const preparationCleanupComplete = vi.fn()
    state.lifecyclePromise = preparation.promise
    state.cancelPreparation = reason => {
      void cleanup.promise.then(() => {
        preparationCleanupComplete()
        preparation.reject(new Error(reason))
      })
    }
    const test = harness()
    const result = test.tool.execute(input, execution(outer?.signal))
    await vi.waitFor(() => expect(state.controllers[0]?.prepare).toHaveBeenCalledOnce())

    if (outer) outer.abort(new Error(cancellationReason))
    else test.hooks?.cancel(cancellationReason)

    await expect(expectPrompt(result)).resolves.toMatchObject({
      kind: 'background-start-failed', jobId: 'autoresearch-1', status: 'cancelled', reason: cancellationReason,
    })
    await vi.waitFor(() => expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce())
    let doneSettled = false
    void test.hooks!.done.finally(() => { doneSettled = true })
    const teardown = test.dispose()
    let teardownSettled = false
    void teardown.then(() => { teardownSettled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(doneSettled).toBe(false)
    expect(teardownSettled).toBe(false)
    expect(state.controllers[0]?.run).not.toHaveBeenCalled()

    cleanup.resolve()
    await expect(test.hooks!.done).resolves.toMatchObject({ status: 'killed', detail: cancellationReason })
    await teardown
    expect(preparationCleanupComplete).toHaveBeenCalledOnce()
  })

  it('rejects an unknown background evaluator before repository preflight or job registration', async () => {
    const test = harness()
    await expect(test.tool.execute({ ...input, evaluator_id: 'unknown' }, execution())).rejects.toThrow('unknown evaluator registration id "unknown"')
    expect(state.preflight).not.toHaveBeenCalled()
    expect(test.job).toBeUndefined()
    expect(state.controllers).toHaveLength(0)
  })

  it.each(['../escape', '/absolute', 'nested/component', 'nested\\component', '00000000-0000-4000-0000-000000000000/child'])(
    'rejects unsafe resume id %s before repository preflight or job registration',
    async resumeRunId => {
      const test = harness()
      await expect(test.tool.execute({ objective: input.objective, mutable_globs: input.mutable_globs, resume_run_id: resumeRunId }, execution())).rejects.toThrow(/canonical UUID v4/)
      expect(state.preflight).not.toHaveBeenCalled()
      expect(test.job).toBeUndefined()
      expect(state.controllers).toHaveLength(0)
    },
  )

  it('rejects an unsafe foreground resume id before controller construction or repository preflight', async () => {
    const test = harness()
    await expect(test.tool.execute({ objective: input.objective, mutable_globs: input.mutable_globs, resume_run_id: '../escape', mode: 'foreground' }, execution())).rejects.toThrow(/canonical UUID v4/)
    expect(state.preflight).not.toHaveBeenCalled()
    expect(test.job).toBeUndefined()
    expect(state.controllers).toHaveLength(0)
  })

  it('keeps the background run independent from the outer tool signal', async () => {
    const outer = new AbortController()
    const test = harness()
    await test.tool.execute(input, execution(outer.signal))
    outer.abort(new Error('tool turn ended'))
    expect(state.controllers[0]?.constructorSignal.aborted).toBe(false)
    expect(state.controllers[0]?.cancel).not.toHaveBeenCalled()
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('returns the owner-relative registry failure without constructing a controller', async () => {
    state.startError = new Error('no attached job controller serves owner session')
    const test = harness()
    await expect(test.tool.execute(input, execution())).resolves.toEqual({
      kind: 'background-start-failed', jobId: 'unregistered', status: 'failed', reason: 'no attached job controller serves owner session',
      evidence: [{ code: 'startup-failed', message: 'no attached job controller serves owner session', artifacts: [] }],
    })
    expect(state.controllers).toHaveLength(0)
  })

  it('settles rejecting preparation as failed while still cleaning up the controller', async () => {
    const preparationFailure = new Error('controller preparation failed')
    state.preparePromise = Promise.reject(preparationFailure)
    const test = harness()

    await expect(test.tool.execute(input, execution())).resolves.toMatchObject({
      kind: 'background-start-failed', jobId: 'autoresearch-1', status: 'failed', reason: preparationFailure.message,
    })
    expect(state.controllers[0]?.run).not.toHaveBeenCalled()
    expect(state.controllers[0]?.cancel).toHaveBeenCalledWith(preparationFailure.message)
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'failed', detail: preparationFailure.message })
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('settles partial registration without executing a controller when start throws after run()', async () => {
    state.throwAfterRun = true
    const test = harness()
    await expect(test.tool.execute(input, execution())).resolves.toMatchObject({ kind: 'background-start-failed', jobId: 'unregistered', status: 'failed' })
    expect(state.controllers).toHaveLength(1)
    expect(state.controllers[0]?.prepare).not.toHaveBeenCalled()
    expect(state.controllers[0]?.run).not.toHaveBeenCalled()
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'failed' })
  })

  it('uses synchronous idempotent cancellation and maps settled cancellation to killed', async () => {
    state.runResult = { ...state.runResult, status: 'cancelled', lastState: 'ready', reason: 'stop', quiescent: true } as never
    const test = harness()
    await test.tool.execute(input, execution())
    test.hooks?.cancel('stop')
    test.hooks?.cancel('again')
    expect(state.controllers[0]?.cancel).toHaveBeenCalledTimes(1)
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'killed', detail: 'cancelled' })
  })

  it('unregisters once and repeatedly unloads without duplicate cancellation or release', async () => {
    const test = harness()
    await test.tool.execute(input, execution())
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed' })
    await test.dispose()
    await test.dispose()
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
    expect(state.releaseTool).toHaveBeenCalledOnce()
    expect(state.releasePrompt).toHaveBeenCalledOnce()
  })
})
