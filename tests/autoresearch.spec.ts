import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { apply } from '../src/index.ts'

const baselineReport = {
  status: 'baseline',
  metric: 1.25,
  experimentCommit: 'abc1234',
  headCommit: 'abc1234',
  summary: 'Established the baseline.',
  evidence: ['evaluation printed score=1.25', 'HEAD is abc1234'],
  nextIdea: 'Try a smaller learning rate.',
  blocker: '',
} as const

function completedResult(value: unknown, agentsStarted = 1): WorkflowResult {
  return { value, stopReason: 'completed', agentsStarted }
}

function fakeRun(result: WorkflowResult): WorkflowRun & { dispose: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  return {
    id: 'workflow-1' as WorkflowRun['id'],
    meta: { name: 'autoresearch', description: 'test' },
    result: Promise.resolve(result),
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

interface Harness {
  readonly tool: ToolDefinition
  readonly prompt: { name: string; order: number; text: string }
  readonly starts: WorkflowStartRequest[]
  readonly jobs: JobStart[]
}

function harness(result: WorkflowResult, config: Parameters<typeof apply>[1] = {}): Harness {
  let tool: ToolDefinition | undefined
  let prompt: Harness['prompt'] | undefined
  const starts: WorkflowStartRequest[] = []
  const jobs: JobStart[] = []
  const ctx = {
    systemPrompt: {
      section(section: Harness['prompt']) {
        prompt = section
        return () => {}
      },
    },
    tools: {
      register(definition: ToolDefinition) {
        tool = definition
        return () => {}
      },
    },
    subagents: {
      getProvider() {
        return {
          name: 'spawn',
          capabilities: { outputSchema: true },
          inheritsParentContext: false,
        }
      },
    },
    workflowEngine: {
      start(request: WorkflowStartRequest) {
        starts.push(request)
        return fakeRun(result)
      },
    },
    jobs: {
      start(spec: JobStart) {
        jobs.push(spec)
        return 'autoresearch-1'
      },
    },
  }
  apply(ctx as unknown as Context, config)
  if (tool === undefined || prompt === undefined) throw new Error('plugin did not register its contributions')
  return { tool, prompt, starts, jobs }
}

const args = {
  objective: 'Reduce validation loss.',
  run_tag: 'aug14',
  mutable_files: ['train.py'],
  evaluation_command: 'uv run train.py',
  metric_name: 'val_loss',
  metric_direction: 'minimize',
  experiment_timeout_minutes: 10,
  max_experiments: 3,
  run_in_background: false,
} as const

const parent = { id: 'parent' }

function execution(signal = new AbortController().signal) {
  return { agent: parent, signal } as never
}

describe('dsh-autoresearch', () => {
  it('registers explicit policy and starts a bounded foreground workflow', async () => {
    const terminal = {
      status: 'budget-limited',
      experimentsStarted: 3,
      bestMetric: 1.25,
      bestCommit: 'abc1234',
      lastReport: baselineReport,
    }
    const test = harness(completedResult(terminal, 3), { maxExperiments: 5 })

    const value = await test.tool.execute(args, execution())

    expect(test.prompt.name).toBe('tool:autoresearch')
    expect(test.prompt.text).toContain('explicitly asks')
    expect(value).toEqual({
      kind: 'foreground',
      runId: 'workflow-1',
      agentsStarted: 3,
      result: terminal,
    })
    expect(test.starts).toHaveLength(1)
    expect(test.starts[0]).toMatchObject({
      subagentProvider: 'spawn',
      maxTotalAgents: 3,
      parent,
    })
    expect(test.starts[0]?.args).toMatchObject({
      objective: 'Reduce validation loss.',
      runTag: 'aug14',
      resultsFile: 'autoresearch-results.tsv',
      branchPrefix: 'autoresearch/',
      maxExperiments: 3,
    })
  })

  it('starts a generic background job and maps terminal workflow output', async () => {
    const terminal = {
      status: 'target-reached',
      experimentsStarted: 1,
      bestMetric: 1.25,
      bestCommit: 'abc1234',
      lastReport: baselineReport,
    }
    const test = harness(completedResult(terminal))

    const value = await test.tool.execute({ ...args, run_in_background: true }, execution())

    expect(value).toEqual({ kind: 'background', jobId: 'autoresearch-1' })
    expect(test.starts).toHaveLength(0)
    expect(test.jobs).toHaveLength(1)
    expect(test.jobs[0]).toMatchObject({ kind: 'autoresearch', owner: parent })

    const hooks = test.jobs[0]!.run()
    expect(test.starts).toHaveLength(1)
    expect(test.starts[0]?.signal).toBeInstanceOf(AbortSignal)
    await expect(hooks.done).resolves.toMatchObject({
      status: 'completed',
      detail: 'target-reached',
      output: expect.stringContaining('Best metric: 1.25'),
    })
  })

  it('accepts a concrete blocker before baseline creation', async () => {
    const blockedReport = {
      status: 'blocked',
      metric: null,
      experimentCommit: 'abc1234',
      headCommit: 'abc1234',
      summary: 'The requested branch already exists.',
      evidence: ['git branch --list returned autoresearch/aug14'],
      nextIdea: '',
      blocker: 'A fresh run requires a branch name that does not already exist.',
    }
    const terminal = {
      status: 'blocked',
      experimentsStarted: 1,
      bestMetric: null,
      bestCommit: 'abc1234',
      lastReport: blockedReport,
    }
    const test = harness(completedResult(terminal))

    await expect(test.tool.execute(args, execution())).resolves.toMatchObject({
      kind: 'foreground',
      result: terminal,
    })
  })

  it('rejects unsafe inputs and deployment-cap escalation before starting work', async () => {
    const test = harness(completedResult(null), { maxExperiments: 2 })

    await expect(test.tool.execute({ ...args, mutable_files: ['../train.py'] }, execution()))
      .rejects.toThrow('parent traversal')
    await expect(test.tool.execute({ ...args, max_experiments: 3 }, execution()))
      .rejects.toThrow('exceeds the deployment ceiling 2')
    expect(test.starts).toHaveLength(0)
    expect(test.jobs).toHaveLength(0)
  })
})
