import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { composeHarness, assembledPrompt, type RealHarness } from './fixtures/harness-composition.ts'
import { calls } from './fixtures/loader/model-provider.ts'

const run = promisify(execFile)
const active: RealHarness[] = []
const evaluator = new URL('./fixtures/loader/evaluator.mjs', import.meta.url).pathname

afterEach(async () => {
  calls.length = 0
  await Promise.allSettled(active.splice(0).map(harness => harness.dispose()))
})

async function repository(root: string): Promise<string> {
  const cwd = join(root, 'repository')
  await mkdir(cwd)
  await writeFile(join(cwd, 'score.txt'), '1\n')
  await run('git', ['init', '-q'], { cwd })
  await run('git', ['config', 'user.name', 'Loader Integration'], { cwd })
  await run('git', ['config', 'user.email', 'loader@example.invalid'], { cwd })
  await run('git', ['add', 'score.txt'], { cwd })
  await run('git', ['commit', '-qm', 'fixture'], { cwd })
  return cwd
}

async function parentAgent(harness: RealHarness, cwd: string, suffix = 'owner'): Promise<AgentHandle> {
  return harness.ctx.agents.create({
    sessionId: SessionId(`${suffix}-${crypto.randomUUID()}`),
    meta: { cwd },
    agentOptions: { provider: 'autoresearch-test', model: 'bounded-model', maxTokens: 512 },
  })
}

async function execute(harness: RealHarness, name: string, args: unknown, agent: Agent) {
  return harness.ctx.tools.execute({ callId: `call-${crypto.randomUUID()}` as never, name, arguments: args, agent, signal: new AbortController().signal })
}

function request(cwd: string, mode: 'background' | 'foreground' = 'background') {
  return {
    repository: cwd,
    run_tag: `loader-${crypto.randomUUID().slice(0, 8)}`,
    objective: 'Increase the strict fixture score',
    mutable_globs: ['score.txt'],
    evaluation: { command: process.execPath, args: [evaluator] },
    metric_name: 'score',
    metric_direction: 'maximize',
    max_experiments: 1,
    timeout_ms: 10_000,
    mode,
  }
}

describe('real Loader/profile production composition', () => {
  it('boots the shipped base profile keylessly with the opt-in stable autoresearch row and providers', async () => {
    const without = await composeHarness({ autoresearch: false })
    active.push(without)
    expect(without.entries.some(entry => entry.id === 'autoresearch')).toBe(false)

    const harness = await composeHarness()
    active.push(harness)
    const row = harness.entries.find(entry => entry.id === 'autoresearch')
    expect(row).toMatchObject({ id: 'autoresearch', name: 'dsh-autoresearch', config: { defaultMaxExperiments: 20 } })
    expect(harness.profile.layers.map(layer => layer.packageName)).toEqual(['@deepseek-ai/dsh-base', 'dsh-autoresearch'])
    expect(harness.entries.map(entry => entry.id)).toEqual(expect.arrayContaining(['agent', 'jobs', 'subprocess', 'system-prompt', 'tools', 'tool-jobs']))
    expect(harness.ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining(['autoresearch', 'job_output', 'job_list', 'job_kill']))
    expect(await assembledPrompt(harness.ctx)).toContain('Use autoresearch only when the direct human explicitly requests')
    expect(harness.ctx.llm.listProviders().map(provider => provider.id)).toContain('autoresearch-test')
  }, 30_000)

  it('invokes production autoresearch through ToolRuntime with the exact real parent, child setup, evaluator, durable job, and generic controls', async () => {
    const harness = await composeHarness()
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd)
    const created: Agent[] = []
    const release = harness.ctx.on('agent/created', ({ agent }) => { created.push(agent) })
    try {
      const started = await execute(harness, 'autoresearch', request(cwd), parent.agent)
      expect(started.isError).toBe(false)
      if (started.value && typeof started.value === 'object' && 'kind' in started.value && started.value.kind === 'background-start-failed') throw new Error(JSON.stringify(started.value))
      expect(started.value).toMatchObject({ kind: 'background', jobId: expect.stringMatching(/^autoresearch-/), runId: expect.any(String), worktree: expect.any(String) })
      const value = started.value as { jobId: string; runId: string }
      expect(harness.ctx.jobs.get(value.jobId as never, parent.agent)).toMatchObject({ id: value.jobId, kind: 'autoresearch', status: 'running' })
      const foreign = await parentAgent(harness, cwd, 'foreign')
      await expect(Promise.resolve().then(() => harness.ctx.jobs.get(value.jobId as never, foreign.agent))).rejects.toThrow(/access|owner|unknown|session/i)
      await foreign.dispose()

      const listed = await execute(harness, 'job_list', {}, parent.agent)
      expect(listed.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: value.jobId, kind: 'autoresearch' })]))
      const output = await execute(harness, 'job_output', { job_id: value.jobId, wait: true, timeout_ms: 20_000 }, parent.agent)
      expect(output.isError).toBe(false)
      const text = (output.value as { text: string }).text
      const completed = JSON.parse(text) as unknown
      if (!completed || typeof completed !== 'object' || !('best' in completed)) throw new Error(text)
      const runResult = completed as { best: { metric: number }; status: string }
      if (runResult.best.metric !== 1) throw new Error(JSON.stringify({ completed: runResult, calls }))
      expect(runResult.best.metric).toBe(1)
      expect(runResult.status).toBe('round-failed')
      expect(calls).toHaveLength(2)
      expect(calls).toEqual(calls.map(call => expect.objectContaining({ provider: 'autoresearch-test', model: 'bounded-model', tools: expect.arrayContaining(['read', 'autoresearch_report']) })))
      const child = created.find(agent => agent.session.header.cwd.includes(value.runId))
      expect(child?.session.header).toMatchObject({ parentSession: parent.agent.session.header.id, cwd: expect.stringContaining(value.runId) })
      expect(child).toBeDefined()
      expect(harness.ctx.agents.get(child!.id)).toBeUndefined()
    } finally {
      release()
      await parent.dispose()
    }
  }, 30_000)

  it('kills a published production run through generic controls and unloads only after quiescence', async () => {
    const harness = await composeHarness()
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd)
    try {
      const started = await execute(harness, 'autoresearch', { ...request(cwd), max_experiments: 20 }, parent.agent)
      const jobId = (started.value as { jobId: string }).jobId
      const killed = await execute(harness, 'job_kill', { job_id: jobId, reason: 'loader lifecycle test' }, parent.agent)
      expect(killed.isError).toBe(false)
      await harness.setAutoresearchEnabled(false)
      const settled = await harness.ctx.jobs.wait(jobId as never, 20_000, parent.agent)
      expect(settled.status).toBe('killed')
      expect(harness.ctx.tools.get('autoresearch')).toBeUndefined()
      expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([parent.agent.id])
    } finally {
      await parent.dispose()
    }
  }, 30_000)

  it('supports dispose-reapply HMR without duplicate tool or prompt registrations', async () => {
    const harness = await composeHarness()
    active.push(harness)
    await harness.setAutoresearchEnabled(false)
    expect(harness.ctx.tools.get('autoresearch')).toBeUndefined()
    expect(await assembledPrompt(harness.ctx)).not.toContain('Use autoresearch only')
    await harness.setAutoresearchEnabled(true)
    expect(harness.ctx.tools.schemas().filter(tool => tool.name === 'autoresearch')).toHaveLength(1)
    expect((await assembledPrompt(harness.ctx)).match(/Use autoresearch only/g)).toHaveLength(1)
  }, 30_000)
})

describe('Loader activation failures', () => {
  it.each([
    ['tools', 'tools'],
    ['system-prompt', 'systemPrompt'],
    ['jobs', 'jobs'],
    ['subprocess', 'subprocess'],
    ['agent', 'agents'],
  ])('fails clearly when the shipped profile omits %s', async (entry, service) => {
    await expect(composeHarness({ omitEntry: entry })).rejects.toThrow(new RegExp(service, 'i'))
  }, 30_000)

  it('fails clearly when dsh-tool-jobs is absent even though the jobs registry exists', async () => {
    await expect(composeHarness({ omitEntry: 'tool-jobs' })).rejects.toThrow(/dsh-tool-jobs/)
  }, 30_000)
})
