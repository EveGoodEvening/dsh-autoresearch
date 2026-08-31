import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPOSITION_TERMINATION_GRACE_MS, composeHarness, assembledPrompt, type RealHarness } from './fixtures/harness-composition.ts'
import { calls, holdModel, releaseModel } from './fixtures/loader/model-provider.ts'

const run = promisify(execFile)
const active: RealHarness[] = []
const evaluator = new URL('./fixtures/loader/evaluator.mjs', import.meta.url).pathname
const holdingEvaluator = new URL('./fixtures/loader/evaluator-hold.mjs', import.meta.url).pathname
async function evaluatorMarker(prefix: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  return { path: join(directory, 'evaluator.pid'), dispose: () => rm(directory, { recursive: true, force: true }) }
}


function evaluatorConfig(commandArgs: string[], direction: 'minimize' | 'maximize' = 'maximize') {
  return { evaluatorRegistrations: [{ id: 'judge', command: process.execPath, args: commandArgs, metricName: 'score', metricDirection: direction, metricParserVersion: 'final-line-json-v1', evaluatorFiles: [] }] }
}
afterEach(async () => {
  calls.length = 0
  releaseModel()
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

async function parentAgent(harness: RealHarness, cwd: string, suffix = 'owner', preset?: 'standard'): Promise<AgentHandle> {
  return harness.ctx.agents.create({
    sessionId: SessionId(`${suffix}-${crypto.randomUUID()}`),
    meta: { cwd },
    agentOptions: { provider: 'autoresearch-test', model: 'bounded-model', maxTokens: 512 },
    ...(preset === undefined ? {} : {
      setup: async agentCtx => { await harness.ctx.agentPresets.mount(agentCtx, preset) },
    }),
  })
}

function stringProperty(value: unknown, property: string): string {
  if (value === null || typeof value !== 'object' || !(property in value)) throw new Error(`tool result is missing ${property}`)
  const field = value[property]
  if (typeof field !== 'string') throw new Error(`tool result ${property} must be a string`)
  return field
}

async function execute(harness: RealHarness, name: string, args: unknown, agent: Agent) {
  return harness.ctx.tools.execute({ callId: `call-${crypto.randomUUID()}` as never, name, arguments: args, agent, signal: new AbortController().signal })
}

function request(cwd: string, mode: 'background' | 'foreground' = 'background') {
  return {
    repository: cwd,
    run_tag: `loader-${crypto.randomUUID().slice(0, 8)}`,
    evaluator_id: 'judge',
    objective: 'Increase the strict fixture score',
    mutable_globs: ['score.txt'],
    max_experiments: 1,
    timeout_ms: 10_000,
    mode,
  }
}
async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string | (() => string), timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(typeof message === 'function' ? message() : message)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 10)
    await promise
  }
}

async function evaluatorPid(marker: string): Promise<number> {
  let text = ''
  await waitUntil(async () => {
    try { text = await readFile(marker, 'utf8'); return true } catch { return false }
  }, 'evaluator did not publish its pid')
  return Number(text.trim())
}

async function processState(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0]
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return undefined
    throw error
  }
}

function persistedBackgroundJobIds(cwd: string): string[] {
  const runs = join(cwd, '.git', 'dsh-autoresearch', 'runs')
  let files: string[]
  try { files = readdirSync(runs, { recursive: true, encoding: 'utf8' }) } catch { return [] }
  const ids: string[] = []
  for (const file of files.filter(file => file.endsWith('tracker.sqlite'))) {
    const database = new DatabaseSync(join(runs, file), { readOnly: true })
    try {
      const rows = database.prepare("SELECT outcome_json FROM transitions WHERE outcome_json LIKE '%background-job-registered%'").all() as { outcome_json: string }[]
      for (const row of rows) {
        const outcome = JSON.parse(row.outcome_json) as { jobId?: unknown }
        if (typeof outcome.jobId === 'string') ids.push(outcome.jobId)
      }
    } finally { database.close() }
  }
  return ids
}

const COVERAGE_SETTLEMENT_OVERHEAD_MS = 10_000
const CANCELLATION_SETTLEMENT_TIMEOUT_MS = COMPOSITION_TERMINATION_GRACE_MS * 2 + COVERAGE_SETTLEMENT_OVERHEAD_MS

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

  it('runs through the Web standard Agent preset while job controls remain absent from the Host tool layer', async () => {
    const harness = await composeHarness({ standardPreset: true })
    active.push(harness)
    expect(harness.entries.find(entry => entry.id === 'tool-jobs')).toMatchObject({ disabled: true })
    expect(harness.ctx.tools.schemas().map(tool => tool.name)).not.toEqual(expect.arrayContaining(['job_output', 'job_list', 'job_kill']))

    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd, 'web-standard', 'standard')
    try {
      expect(harness.ctx.tools.schemas(parent.agent).map(tool => tool.name)).toEqual(expect.arrayContaining(['autoresearch', 'job_output', 'job_list', 'job_kill']))
      const started = await execute(harness, 'autoresearch', request(cwd), parent.agent)
      expect(started.isError).toBe(false)
      expect(started.value).toMatchObject({ kind: 'background', jobId: expect.stringMatching(/^autoresearch-/) })
      const jobId = stringProperty(started.value, 'jobId')
      const output = await execute(harness, 'job_output', { job_id: jobId, wait: true, timeout_ms: 20_000 }, parent.agent)
      expect(output.isError).toBe(false)
      expect(JSON.parse(stringProperty(output.value, 'text'))).toMatchObject({ best: { metric: 1 }, status: 'round-failed' })
    } finally { await parent.dispose() }
  }, 30_000)

  it('boots and executes autoresearch when equivalent profile entry rows are deliberately reversed', async () => {
    const harness = await composeHarness({ reverseEntries: true })
    active.push(harness)
    const ids = harness.entries.map(entry => entry.id)
    expect(ids).toEqual([...ids].sort((left, right) => right.localeCompare(left)))
    expect(ids.indexOf('autoresearch')).toBeGreaterThan(ids.indexOf('jobs'))

    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd, 'reordered')
    try {
      const started = await execute(harness, 'autoresearch', request(cwd), parent.agent)
      expect(started.isError).toBe(false)
      expect(started.value).toMatchObject({ kind: 'background', jobId: expect.stringMatching(/^autoresearch-/) })
      const jobId = (started.value as { jobId: string }).jobId
      const output = await execute(harness, 'job_output', { job_id: jobId, wait: true, timeout_ms: 20_000 }, parent.agent)
      expect(output.isError).toBe(false)
      expect(JSON.parse((output.value as { text: string }).text)).toMatchObject({ best: { metric: 1 }, status: 'round-failed' })
    } finally { await parent.dispose() }
  }, 30_000)

  it('constructs LocalJobRegistry hooks synchronously, returns its id before worktree side effects, persists it before evaluator spawn, and cancels execution through the job', async () => {
    const marker = await evaluatorMarker('ordered-evaluator')
    const harness = await composeHarness({ autoresearchConfig: evaluatorConfig([holdingEvaluator, marker.path]) })
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd, 'ordering')
    const events: string[] = []
    let evaluatorSignal: AbortSignal | undefined
    let evaluatorHandle: SubprocessHandle | undefined
    let evaluatorHandleSettled = false
    const jobs = harness.ctx.jobs
    const originalStart = jobs.start.bind(jobs)
    const subprocess = harness.ctx.subprocess
    const originalSpawn = subprocess.spawn.bind(subprocess)
    jobs.start = spec => {
      events.push('registry-start-enter')
      const id = originalStart({ ...spec, run: () => {
        events.push('run-hook-enter')
        const hooks = spec.run()
        events.push('run-hook-return')
        return hooks
      } })
      events.push(`registry-start-return:${String(id)}`)
      return id
    }
    subprocess.spawn = spec => {
      const argv = spec.argv.map(String)
      const addsWorktree = argv.includes('worktree') && argv.includes('add')
      const startsEvaluator = argv.includes(holdingEvaluator)
      if (addsWorktree || startsEvaluator) {
        const returnedJobIds = events.filter(event => event.startsWith('registry-start-return:')).map(event => event.slice('registry-start-return:'.length))
        expect(returnedJobIds).not.toHaveLength(0)
        if (startsEvaluator) {
          expect(persistedBackgroundJobIds(cwd)).toEqual(expect.arrayContaining(returnedJobIds))
          evaluatorSignal = spec.signal
          evaluatorHandle = originalSpawn(spec)
          void evaluatorHandle.done.finally(() => { evaluatorHandleSettled = true })
          return evaluatorHandle
        }
      }
      return originalSpawn(spec)
    }
    try {
      const execution = execute(harness, 'autoresearch', request(cwd), parent.agent)
      await waitUntil(() => events.some(event => event.startsWith('registry-start-return:')), 'job registry did not return an id')
      const returned = events.find(event => event.startsWith('registry-start-return:'))!
      const jobId = returned.slice('registry-start-return:'.length)
      const pid = await evaluatorPid(marker.path)
      expect(events.slice(0, 4)).toEqual(['registry-start-enter', 'run-hook-enter', 'run-hook-return', `registry-start-return:${jobId}`])
      expect(persistedBackgroundJobIds(cwd)).toContain(jobId)
      expect(evaluatorSignal?.aborted).toBe(false)

      expect(harness.ctx.jobs.kill(jobId as never, parent.agent, 'ordering test cancellation')).toBe('requested')
      let lastProcessState: string | undefined
      let lastJobStatus: string | undefined
      await waitUntil(() => evaluatorSignal?.aborted === true, 'job cancellation did not abort the evaluator-owned signal')
      await waitUntil(async () => {
        lastProcessState = await processState(pid)
        lastJobStatus = harness.ctx.jobs.get(jobId as never, parent.agent).status
        return evaluatorHandleSettled
          && (lastProcessState === undefined || lastProcessState === 'Z')
          && lastJobStatus === 'killed'
      }, () => `cancellation did not settle within provider grace plus coverage overhead (${CANCELLATION_SETTLEMENT_TIMEOUT_MS}ms): process=${lastProcessState ?? 'exited'}, subprocess=${evaluatorHandleSettled ? 'settled' : 'pending'}, job=${lastJobStatus ?? 'unknown'}`, CANCELLATION_SETTLEMENT_TIMEOUT_MS)
      expect(await evaluatorHandle?.waitForExit()).toBe(true)
      const finalProcessState = await processState(pid)
      if (finalProcessState !== undefined && finalProcessState !== 'Z') throw new Error(`evaluator orphan ${pid} remains live in process state ${finalProcessState}`)
      expect((await harness.ctx.jobs.wait(jobId as never, 1, parent.agent)).status).toBe('killed')
      const result = await execution
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ kind: 'background', jobId })
    } finally {
      jobs.start = originalStart
      subprocess.spawn = originalSpawn
      try { await parent.dispose() } finally { await marker.dispose() }
    }
  }, 45_000)

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

  it('terminates an active production evaluator and its job before HMR returns', async () => {
    const marker = await evaluatorMarker('hmr-evaluator')
    const harness = await composeHarness({ autoresearchConfig: evaluatorConfig([holdingEvaluator, marker.path]) })
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd)
    try {
      const execution = execute(harness, 'autoresearch', request(cwd), parent.agent)
      const pid = await evaluatorPid(marker.path)
      const initialProcessState = await processState(pid)
      expect(initialProcessState).toBeDefined()
      expect(initialProcessState).not.toBe('Z')
      expect(harness.ctx.jobs.list(parent.agent)).toEqual([expect.objectContaining({ kind: 'autoresearch', status: 'running' })])

      await harness.reloadAutoresearch()
      await execution

      let finalProcessState: string | undefined
      await waitUntil(async () => {
        finalProcessState = await processState(pid)
        return finalProcessState === undefined || finalProcessState === 'Z'
      }, () => `evaluator process survived HMR unload in process state ${finalProcessState ?? 'unknown'}`)
      expect(harness.ctx.jobs.list(parent.agent).every(job => job.status !== 'running' && job.status !== 'stopping')).toBe(true)
      expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([parent.agent.id])
    } finally {
      try { await parent.dispose() } finally { await marker.dispose() }
    }
  }, 30_000)

  it('HMR reloads production autoresearch only after controller, child, evaluator, and job quiescence, then reapplies unique registrations', async () => {
    const harness = await composeHarness()
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd)
    holdModel()
    try {
      const started = await execute(harness, 'autoresearch', { ...request(cwd), max_experiments: 20 }, parent.agent)
      expect(started.isError).toBe(false)
      if (!started.value || typeof started.value !== 'object' || !('jobId' in started.value) || typeof started.value.jobId !== 'string') throw new Error(JSON.stringify(started.value))
      const jobId = started.value.jobId
      await waitUntil(() => calls.length > 0 && harness.ctx.agents.list().length > 1, 'autoresearch child did not become active before HMR')
      expect(harness.ctx.jobs.get(jobId as never, parent.agent)).toMatchObject({ status: 'running' })

      await harness.reloadAutoresearch()
      releaseModel()

      const settled = await harness.ctx.jobs.wait(jobId as never, 20_000, parent.agent)
      expect(['failed', 'killed']).toContain(settled.status)
      expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([parent.agent.id])
      expect(harness.ctx.tools.schemas().filter(tool => tool.name === 'autoresearch')).toHaveLength(1)
      expect((await assembledPrompt(harness.ctx)).match(/Use autoresearch only/g)).toHaveLength(1)
    } finally {
      releaseModel()
      await parent.dispose()
    }
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

  it('rejects reserved DSH_* Host evaluator environment during real Loader activation', async () => {
    const registration = evaluatorConfig([evaluator]).evaluatorRegistrations[0]!
    await expect(composeHarness({ autoresearchConfig: { evaluatorRegistrations: [{ ...registration, environment: { DSH_TOKEN: 'reserved' } }] } })).rejects.toThrow(/environment name DSH_TOKEN is reserved/)
  }, 30_000)

  it('rejects duplicate Host evaluator registrations during real Loader activation', async () => {
    const registration = { id: 'judge', command: 'node', args: ['score.mjs'], metricName: 'score', metricDirection: 'minimize', metricParserVersion: 'final-line-json-v1', evaluatorFiles: [] }
    await expect(composeHarness({ autoresearchConfig: { evaluatorRegistrations: [registration, registration] } })).rejects.toThrow(/duplicate evaluator registration id "judge"/)
  }, 30_000)

  it('defers missing Job control validation to owner-relative background registration', async () => {
    const harness = await composeHarness({ omitEntry: 'tool-jobs' })
    active.push(harness)
    const cwd = await repository(harness.root)
    const parent = await parentAgent(harness, cwd, 'no-job-controller')
    try {
      const result = await execute(harness, 'autoresearch', request(cwd), parent.agent)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ kind: 'background-start-failed', jobId: 'unregistered', status: 'failed' })
      expect(stringProperty(result.value, 'reason')).toMatch(/controller|collect|stop/i)
      expect(harness.ctx.jobs.list(parent.agent)).toEqual([])
    } finally { await parent.dispose() }
  }, 30_000)
})
