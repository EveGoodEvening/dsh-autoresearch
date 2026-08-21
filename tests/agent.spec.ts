import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { PROPOSAL_INHERITED_TOOLS, PROPOSAL_REPORT_TOOL, ProposalAgentError, requestProposal, type ProposalAgentRequest } from '../src/agent.ts'

class TextReader implements SubprocessOutputReader {
  constructor(private readonly text: string) {}
  readFrom() { return { text: this.text, nextOffset: Buffer.byteLength(this.text), lossy: false } }
}

class SettledHandle implements SubprocessHandle {
  readonly pid = 1
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected
  readonly done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null })
  constructor(stdout: string) { this.collected = { stdout: new TextReader(stdout), stderr: new TextReader('') } }
  terminate(): void {}
  async waitForExit(): Promise<boolean> { return true }
}

class GitSubprocess {
  readonly calls: SubprocessSpawnSpec[] = []
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    const joined = spec.argv.join(' ')
    if (joined.includes('rev-parse --git-path config.worktree')) return new SettledHandle('.git/config.worktree\n')
    if (joined.includes('rev-parse --git-path config')) return new SettledHandle('.git/config\n')
    return new SettledHandle('')
  }
  async resolveExecutable(command: string): Promise<string> { return command }
}

type ResultListener = (execution: { name: string }, result: Readonly<ToolExecutionResult>) => void

interface HarnessFixture {
  readonly ctx: Context
  readonly parent: Agent
  readonly createOptions: CreateAgentOptions[]
  readonly childTools: Map<string, ToolDefinition>
  readonly restrictions: unknown[]
  readonly presentations: string[]
  readonly sections: Array<{ name: string; order: number; text: string }>
  readonly order: string[]
  readonly dispose: ReturnType<typeof vi.fn>
  readonly childId: { value?: ReturnType<typeof SessionId> }
  behavior: 'valid' | 'missing' | 'unknown' | 'duplicate' | 'stale' | 'wrong' | 'oversized' | 'normalized'
  disposeError?: Error
  liveJob?: boolean
  keepRegistered?: boolean
  ownerCleanup?: () => Promise<void>
  unloadDuringIdle?: boolean
  readonly liveCount: () => number
}

function fixture(): HarnessFixture {
  const createOptions: CreateAgentOptions[] = []
  const childTools = new Map<string, ToolDefinition>()
  const restrictions: unknown[] = []
  const presentations: string[] = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const resultListeners: ResultListener[] = []
  const order: string[] = []
  const live = new Map<string, Agent>()
  const dispose = vi.fn(async () => { order.push('dispose'); if (harness.disposeError) throw harness.disposeError; if (!harness.keepRegistered && childId.value !== undefined) live.delete(childId.value) })
  const childId: { value?: SessionId } = {}
  const harness = { behavior: 'valid' as HarnessFixture['behavior'] } as HarnessFixture

  const parentSession = {
    header: { id: SessionId('parent-session'), cwd: '/parent', delegationDepth: 2 },
    append: vi.fn(),
  }
  const parentCtx = {
    get(name: string) {
      if (name === 'agentPresets') return { composedPreset: () => 'preset-generation-7' }
      if (name === 'sandboxPolicy') return { overrideOf: () => 'workspace-write' }
      if (name === 'approval') return {}
      return undefined
    },
    effect(execute: () => () => Promise<void>) {
      const cleanup = execute()
      let released = false
      const ownerCleanup = async () => { if (released) return; released = true; await cleanup() }
      harness.ownerCleanup = ownerCleanup
      return ownerCleanup
    },
  } as unknown as Context
  const parent = { id: parentSession.header.id, options: { provider: 'parent-provider', model: 'parent-model', maxTokens: 777, subagentDepth: 2 }, session: parentSession, ctx: parentCtx } as unknown as Agent

  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      order.push('create')
      createOptions.push(options)
      childId.value = options.sessionId
      const childSession = { header: { id: options.sessionId, ...options.meta }, append: vi.fn() }
      const childCtx = {
        agent: undefined as Agent | undefined,
        get(name: string) {
          if (name === 'agentPresets') return { composeFrom: vi.fn(() => order.push('preset')) }
          return undefined
        },
        tools: {
          restrict(value: unknown) { restrictions.push(value); order.push('restrict'); return () => undefined },
          presentAs(value: string) { presentations.push(value); order.push('present'); return () => undefined },
          register(tool: ToolDefinition) { childTools.set(tool.name, tool); order.push(`tool:${tool.name}`); return () => undefined },
          guard() { order.push('guard'); return () => undefined },
        },
        systemPrompt: {
          context() { order.push('delegation-context'); return () => undefined },
          section(value: { name: string; order: number; text: string }) { sections.push(value); order.push(`section:${value.order}`); return () => undefined },
        },
        on(name: string, listener: ResultListener) { if (name === 'tools/result') resultListeners.push(listener); return () => undefined },
      } as unknown as Context
      let prompt = ''
      const child = {
        id: options.sessionId,
        options: options.agentOptions ?? {},
        session: childSession,
        ctx: childCtx,
        status: 'idle',
        cancel: vi.fn(),
        followup(message: { content: Array<{ type: string; text?: string }> }) { prompt = message.content[0]?.text ?? ''; order.push('followup') },
        async whenIdle() {
          if (harness.unloadDuringIdle) await harness.ownerCleanup?.()
          order.push('whenIdle')
          const tool = childTools.get(PROPOSAL_REPORT_TOOL)
          if (tool === undefined || harness.behavior === 'missing') return
          const handoff = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { identity: { runId: string; experimentId: string; ordinal: number; nonce: string } }
          const report: Record<string, unknown> = {
            ...handoff.identity,
            hypothesis: 'Change the hot path',
            intendedEdits: ['src/hot.ts'],
            implementationSummary: 'Reduced duplicate work',
            blockerClaim: null,
          }
          if (harness.behavior === 'unknown') report.metric = 0
          if (harness.behavior === 'stale') report.runId = 'stale-run'
          if (harness.behavior === 'wrong') report.ordinal = handoff.identity.ordinal + 1
          if (harness.behavior === 'oversized') report.implementationSummary = 'x'.repeat(40_000)
          if (harness.behavior === 'normalized') report.hypothesis = ' not-normalized'
          const execute = async () => {
            try {
              const value = await tool.execute(report, { concludeTurn: vi.fn() } as never)
              const result = { isError: false, value, content: [] } as unknown as ToolExecutionResult
              for (const listener of resultListeners) listener({ name: PROPOSAL_REPORT_TOOL }, result)
            } catch {}
          }
          await execute()
          if (harness.behavior === 'duplicate') await execute()
        },
      } as unknown as Agent
      childCtx.agent = child
      await options.setup?.(childCtx)
      live.set(options.sessionId, child)
      return { agent: child, dispose }
    },
    get(id: SessionId) { return live.get(id) }
  }
  const subprocess = new GitSubprocess()
  const ctx = Object.assign(parentCtx as unknown as Record<string, unknown>, {
    agents,
    subprocess,
    jobs: { list: () => harness.liveJob ? [{ status: 'running' }] as JobSnapshot[] : [] as JobSnapshot[] },
  }) as unknown as Context
  Object.assign(harness, { ctx, parent, createOptions, childTools, restrictions, presentations, sections, order, dispose, childId, liveCount: () => live.size })
  return harness
}

function request(parent: Agent, persistTrustedGitConfig: ProposalAgentRequest['persistTrustedGitConfig']): ProposalAgentRequest {
  return {
    parent,
    runId: 'run-1',
    experimentId: 'experiment-1',
    ordinal: 1,
    workspace: { repositoryId: 'repo-1', branch: 'autoresearch/run-1', worktree: '/tmp/proposal-worktree', startCommit: 'a'.repeat(40), acceptedCommit: 'b'.repeat(40) },
    policy: {
      repository: '/repo', objective: 'Make it faster', constraints: ['Keep behavior'], mutableGlobs: ['src/**'],
      exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], submodules: [], gitConfig: [] },
      evaluation: { command: 'bench.js', args: [] }, metricName: 'time', metricDirection: 'minimize', timeoutMs: 1_000,
      maxExperiments: 3, runTag: 'tag', provenance: {}, environment: {},
    },
    policySha256: 'c'.repeat(64), provenanceSha256: 'd'.repeat(64),
    best: { metric: 10, commit: 'b'.repeat(40), experimentId: 'baseline' }, history: [],
    config: { provider: 'override-provider', model: 'override-model', maxTokens: 999, maxHandoffChars: 32_768 },
    gitExecutable: 'git', gitOptions: { timeoutMs: 1_000, graceMs: 10, maxStdoutBytes: 10_000, maxStderrBytes: 10_000 },
    persistTrustedGitConfig,
    signal: new AbortController().signal,
  }
}

describe('proposal-agent adapter', () => {
  it('creates a fresh isolated child, composes the restricted native scope, captures one report, and disposes before returning', async () => {
    const f = fixture()
    const persist = vi.fn(() => f.order.push('persist'))
    const first = await requestProposal(f.ctx, request(f.parent, persist))
    const second = await requestProposal(f.ctx, request(f.parent, persist))

    expect(first).toEqual({ hypothesis: 'Change the hot path', intendedEdits: ['src/hot.ts'], implementationSummary: 'Reduced duplicate work', blockerClaim: null })
    expect(second).toEqual(first)
    expect(f.createOptions[0]?.sessionId).not.toBe(f.createOptions[1]?.sessionId)
    expect(f.createOptions[0]).toMatchObject({
      meta: { cwd: '/tmp/proposal-worktree', parentSession: SessionId('parent-session'), origin: 'subagent', delegationDepth: 3, agentPreset: 'preset-generation-7' },
      agentOptions: { provider: 'override-provider', model: 'override-model', maxTokens: 999, subagentDepth: 3 },
    })
    expect(f.createOptions[0]).not.toHaveProperty('seed')
    expect(f.restrictions).toEqual([{ allow: PROPOSAL_INHERITED_TOOLS }, { allow: PROPOSAL_INHERITED_TOOLS }])
    expect(f.presentations).toEqual(['native', 'native'])
    expect(f.sections).toContainEqual(expect.objectContaining({ name: 'tool:autoresearch_report', order: 190 }))
    expect(f.childTools.has(PROPOSAL_REPORT_TOOL)).toBe(true)
    expect(f.order.indexOf('persist')).toBeLessThan(f.order.indexOf('create'))
    expect(f.order.indexOf('followup')).toBeLessThan(f.order.indexOf('whenIdle'))
    expect(f.order.indexOf('whenIdle')).toBeLessThan(f.order.indexOf('dispose'))
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing', 'report-missing'],
    ['unknown', 'report-malformed'],
    ['duplicate', 'report-duplicate'],
  ] as const)('rejects %s reports and still awaits disposal', async (behavior, code) => {
    const f = fixture(); f.behavior = behavior
    const outcome = requestProposal(f.ctx, request(f.parent, vi.fn()))
    await expect(outcome).rejects.toMatchObject({ code })
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })

  it('publishes no child when trusted Git config persistence fails', async () => {
    const f = fixture()
    await expect(requestProposal(f.ctx, request(f.parent, () => { throw new Error('tracker unavailable') }))).rejects.toThrow('tracker unavailable')
    expect(f.createOptions).toHaveLength(0)
    expect(f.dispose).not.toHaveBeenCalled()
  })

  it('requires an explicit provider/model route before Git capture or child creation', async () => {
    const f = fixture()
    const parent = { ...f.parent, options: {} } as Agent
    const input = request(parent, vi.fn())
    const withoutRoute = { ...input, config: { maxHandoffChars: input.config.maxHandoffChars } }
    await expect(requestProposal(f.ctx, withoutRoute)).rejects.toEqual(expect.objectContaining<Partial<ProposalAgentError>>({ code: 'route-unavailable' }))
    expect(f.createOptions).toHaveLength(0)
  })
  it('rejects split Context authorities before publishing a child', async () => {
    const f = fixture()
    const foreign = { ...f.parent, ctx: {} as Context } as Agent
    await expect(requestProposal(f.ctx, request(foreign, vi.fn()))).rejects.toMatchObject({ code: 'capability-unavailable' })
    expect(f.createOptions).toHaveLength(0)
  })

  it('inherits the initiating route and omits optional maxTokens when neither layer supplies it', async () => {
    const f = fixture()
    const parent = { ...f.parent, options: { provider: 'inherited-provider', model: 'inherited-model', subagentDepth: 2 } } as Agent
    const input = request(parent, vi.fn())
    await requestProposal(f.ctx, { ...input, config: { maxHandoffChars: input.config.maxHandoffChars } })
    expect(f.createOptions[0]).toMatchObject({ agentOptions: { provider: 'inherited-provider', model: 'inherited-model', subagentDepth: 3 } })
    expect(f.createOptions[0]?.agentOptions).not.toHaveProperty('maxTokens')
  })

  it.each([
    ['stale', 'report-stale'],
    ['wrong', 'report-wrong-experiment'],
    ['oversized', 'report-too-large'],
    ['normalized', 'report-malformed'],
  ] as const)('classifies %s report identity and size failures and disposes once', async (behavior, code) => {
    const f = fixture(); f.behavior = behavior
    await expect(requestProposal(f.ctx, request(f.parent, vi.fn()))).rejects.toMatchObject({ code })
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized handoff before Git capture or child creation', async () => {
    const f = fixture(); const input = request(f.parent, vi.fn())
    await expect(requestProposal(f.ctx, { ...input, config: { ...input.config, maxHandoffChars: 16 } })).rejects.toMatchObject({ code: 'handoff-too-large' })
    expect(f.createOptions).toHaveLength(0)
  })

  it.each([
    ['dispose failure', (f: HarnessFixture) => { f.disposeError = new Error('dispose rejected') }, 'dispose-failed'],
    ['registered child', (f: HarnessFixture) => { f.keepRegistered = true }, 'not-quiescent'],
    ['live child job', (f: HarnessFixture) => { f.liveJob = true }, 'not-quiescent'],
  ] as const)('refuses quiescence after %s and invokes disposal exactly once', async (_label, arrange, code) => {
    const f = fixture(); arrange(f)
    await expect(requestProposal(f.ctx, request(f.parent, vi.fn()))).rejects.toMatchObject({ code })
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels during child execution and awaits the same disposal exactly once', async () => {
    const f = fixture(); const aborter = new AbortController(); const input = request(f.parent, vi.fn())
    const originalCreate = (f.ctx.agents as unknown as { create: (options: CreateAgentOptions) => Promise<AgentHandle> }).create.bind(f.ctx.agents)
    ;(f.ctx.agents as unknown as { create: (options: CreateAgentOptions) => Promise<AgentHandle> }).create = async options => {
      const handle = await originalCreate(options)
      const idle = handle.agent.whenIdle.bind(handle.agent)
      handle.agent.whenIdle = async () => { aborter.abort(new Error('stop')); await idle() }
      return handle
    }
    await expect(requestProposal(f.ctx, { ...input, signal: aborter.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })
  it('awaits owner-effect unload disposal exactly once and leaves no registered child or live job', async () => {
    const f = fixture(); f.unloadDuringIdle = true
    await expect(requestProposal(f.ctx, request(f.parent, vi.fn()))).resolves.toMatchObject({ hypothesis: 'Change the hot path' })
    expect(f.dispose).toHaveBeenCalledTimes(1)
    expect(f.liveCount()).toBe(0)
    expect(f.ctx.jobs.list()).toEqual([])
  })

})
