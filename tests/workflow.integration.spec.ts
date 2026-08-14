import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const reports = [
  {
    status: 'baseline',
    metric: 1.2,
    experimentCommit: 'base001',
    headCommit: 'base001',
    summary: 'Measured the unchanged baseline.',
    evidence: ['score=1.2', 'HEAD base001'],
    nextIdea: 'Try candidate one.',
    blocker: '',
  },
  {
    status: 'keep',
    metric: 1.0,
    experimentCommit: 'keep002',
    headCommit: 'keep002',
    summary: 'Candidate one improved the metric.',
    evidence: ['score=1.0', 'HEAD keep002'],
    nextIdea: 'Try candidate two.',
    blocker: '',
  },
  {
    status: 'discard',
    metric: 1.1,
    experimentCommit: 'drop003',
    headCommit: 'keep002',
    summary: 'Candidate two regressed and was reset.',
    evidence: ['score=1.1', 'HEAD keep002'],
    nextIdea: 'Try a different architecture.',
    blocker: '',
  },
] as const

class ReportProvider implements SubagentProvider {
  readonly name = 'research-stub'
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: false }
  readonly inheritsParentContext = false
  readonly prompts: string[] = []

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const report = reports[this.prompts.length]
    if (report === undefined) throw new Error('unexpected extra experiment')
    this.prompts.push(request.prompt.map(block => block.type === 'text' ? block.text : '').join(''))
    const result: SubagentResult = {
      output: [],
      structured: report,
      stopReason: 'completed',
    }
    return {
      id: SessionId(`research-child-${this.prompts.length}`),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: () => Promise.resolve(),
    }
  }
}

it('executes the fixed experiment loop through the real workflow engine', async () => {
  const ctx = new Context()
  const subagentFiber = await ctx.plugin(SubagentRuntime)
  const provider = new ReportProvider()
  ctx.subagents.registerProvider(provider)
  const engineFiber = await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: provider.name,
    maxConcurrentAgents: 1,
    maxTotalAgents: 3,
  })
  let tool: ToolDefinition | undefined
  const pluginCtx = {
    jobs: { start: () => { throw new Error('background path not expected') } },
    subagents: ctx.subagents,
    systemPrompt: { section: () => () => {} },
    tools: {
      register(definition: ToolDefinition) {
        tool = definition
        return () => {}
      },
    },
    workflowEngine: ctx.workflowEngine,
  }
  apply(pluginCtx as unknown as Context, {
    subagentProvider: provider.name,
    maxExperiments: 3,
  })
  if (tool === undefined) throw new Error('autoresearch tool was not registered')
  const parent = { id: SessionId('research-parent'), options: {} } as unknown as Agent
  const signal = new AbortController().signal

  try {
    const value = await tool.execute({
      objective: 'Lower the score.',
      run_tag: 'integration',
      mutable_files: ['train.py'],
      evaluation_command: 'python train.py',
      metric_name: 'score',
      metric_direction: 'minimize',
      experiment_timeout_minutes: 1,
      max_experiments: 3,
      run_in_background: false,
    }, { agent: parent, signal } as never)

    expect(value).toMatchObject({
      kind: 'foreground',
      agentsStarted: 3,
      result: {
        status: 'budget-limited',
        experimentsStarted: 3,
        bestMetric: 1.0,
        bestCommit: 'keep002',
        lastReport: reports[2],
      },
    })
    expect(provider.prompts).toHaveLength(3)
    expect(provider.prompts[0]).toContain('establish the baseline')
    expect(provider.prompts[1]).toContain('best metric 1.2')
    expect(provider.prompts[2]).toContain('best commit keep002')
  } finally {
    await engineFiber.dispose()
    await subagentFiber.dispose()
  }
})
