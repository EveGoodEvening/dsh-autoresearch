import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobOutcome, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  controllers: [] as Array<{
    ready: Promise<{ runId: string; tracker: string; branch: string; worktree: string }>
    setJobId: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }>,
  runResult: {
    status: 'budget-limited', runId: 'run-1', tracker: '/tracker.sqlite',
    counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 },
    artifacts: [], best: { metric: 1, commit: 'a'.repeat(40), experimentId: 'baseline' },
  },
}))

vi.mock('../src/controller.js', () => ({
  AutoresearchRunController: class {
    readonly ready = Promise.resolve({ runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' })
    readonly setJobId = vi.fn()
    readonly cancel = vi.fn()
    readonly dispose = vi.fn(async () => undefined)
    readonly run = vi.fn(async () => state.runResult)
    constructor() { state.controllers.push(this) }
  },
}))

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
    systemPrompt: { section(section: Harness['prompt']) { prompt = section; return vi.fn() } },
    tools: { register(definition: ToolDefinition) { tool = definition; return vi.fn() } },
    jobs: { start(spec: JobStart) { thisJob = spec; thisHooks = spec.run(); return 'autoresearch-1' } },
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

  it('starts an owner-bound background job, assigns its id before running, and waits for readiness', async () => {
    const test = harness()
    const result = await test.tool.execute(input, execution())
    expect(test.job).toMatchObject({ kind: 'autoresearch', owner: parent })
    expect(state.controllers[0]?.setJobId).toHaveBeenCalledWith('autoresearch-1')
    expect(state.controllers[0]?.setJobId.mock.invocationCallOrder[0]).toBeLessThan(state.controllers[0]?.run.mock.invocationCallOrder[0] ?? 0)
    expect(result).toEqual({ kind: 'background', jobId: 'autoresearch-1', runId: 'run-1', tracker: '/tracker.sqlite', branch: 'autoresearch/run-1', worktree: '/worktree' })
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed', detail: 'budget-limited' })
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

  it('settles completed background resources before plugin unload', async () => {
    const test = harness()
    await test.tool.execute(input, execution())
    await expect(test.hooks?.done).resolves.toMatchObject({ status: 'completed' })
    await test.dispose()
    expect(state.controllers[0]?.dispose).toHaveBeenCalled()
  })
})
