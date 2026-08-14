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
  AutoresearchRunController: class {
    readonly ready = Promise.resolve({ runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' })
    readonly prepare = vi.fn(async (_jobId: string) => ({ runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' }))
    readonly setJobId = vi.fn()
    readonly cancel = vi.fn()
    readonly dispose = vi.fn(async () => undefined)
    readonly run = vi.fn(async () => state.runResult)
    readonly constructorSignal: AbortSignal
    readonly parent: unknown
    constructor(_ctx: unknown, options: { signal: AbortSignal; parent: unknown }) { this.constructorSignal = options.signal; this.parent = options.parent; state.controllers.push(this) }
  },
}))

import { normalizeRunPolicy, resolveConfig } from '../src/config.ts'
import { apply, inject } from '../src/index.ts'

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
    tools: { register(definition: ToolDefinition) { tool = definition; return state.releaseTool } },
    jobs: { start(spec: JobStart) { if (state.startError) throw state.startError; thisJob = spec; thisHooks = spec.run(); if (state.throwAfterRun) throw new Error('registry failed after run'); return 'autoresearch-1' } },
    effect(factory: () => () => Promise<void>) { cleanup = factory(); return cleanup },
  }
  apply(ctx as unknown as Context, {})
  return value
}

const input = {
  objective: 'reduce score', run_tag: 'trial', mutable_globs: ['src/**'],
  evaluation: { command: 'node', args: ['score.mjs'] }, metric_name: 'score', metric_direction: 'minimize',
} as const
const parent = { id: 'parent', session: { header: { id: 'session', cwd: '/repo' } } }
const execution = (signal = new AbortController().signal) => ({ agent: parent, signal }) as never

beforeEach(() => {
  state.controllers.length = 0
  state.runResult = { status: 'budget-limited', runId: 'run-1', tracker: '/tracker.sqlite', counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 }, artifacts: [], best: { metric: 1, commit: 'a'.repeat(40), experimentId: 'baseline' } }
  state.releaseTool.mockClear()
  state.releasePrompt.mockClear()
  state.startError = undefined
  state.throwAfterRun = false
})

describe('autoresearch input object validation', () => {
  it.each(['exceptional_allowlists', 'provenance', 'environment'] as const)('requires %s to be a plain object', key => {
    for (const malformed of [7, false, 'value', [], null]) {
      expect(() => normalizeRunPolicy({ ...input, [key]: malformed } as never, resolveConfig(), '/repo')).toThrow(`${key} must be a plain object`)
    }
  })
})

describe('autoresearch production wiring', () => {
  it('injects only the controller production services and registers direct-human guidance', () => {
    expect(inject).toEqual(['agents', 'jobs', 'subprocess', 'systemPrompt', 'tools'])
    const test = harness()
    expect(test.tool.name).toBe('autoresearch')
    expect(test.prompt?.text).toContain('direct human')
    expect(JSON.stringify(test.tool.parameters)).not.toContain('evaluation_command')
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
    const test = harness()
    const result = await test.tool.execute(input, execution())
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

  it('keeps the background run independent from the outer tool signal', async () => {
    const outer = new AbortController()
    const test = harness()
    await test.tool.execute(input, execution(outer.signal))
    outer.abort(new Error('tool turn ended'))
    expect(state.controllers[0]?.constructorSignal.aborted).toBe(false)
    expect(state.controllers[0]?.cancel).not.toHaveBeenCalled()
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('returns a typed failure when job registration throws without orphaning a controller', async () => {
    state.startError = new Error('registry unavailable')
    const test = harness()
    await expect(test.tool.execute(input, execution())).resolves.toEqual({
      kind: 'background-start-failed', jobId: 'unregistered', status: 'failed', reason: 'registry unavailable',
      evidence: [{ code: 'startup-failed', message: 'registry unavailable', artifacts: [] }],
    })
    expect(state.controllers).toHaveLength(0)
  })

  it('settles partial registration without executing a controller when start throws after run()', async () => {
    state.throwAfterRun = true
    const test = harness()
    await expect(test.tool.execute(input, execution())).resolves.toMatchObject({ kind: 'background-start-failed', jobId: 'unregistered', status: 'failed' })
    expect(state.controllers).toHaveLength(1)
    expect(state.controllers[0]?.prepare).not.toHaveBeenCalled()
    expect(state.controllers[0]?.run).not.toHaveBeenCalled()
    expect(state.controllers[0]?.dispose).toHaveBeenCalledOnce()
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'killed' })
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
