import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { assembledPrompt, composeHarness, type RealHarness } from './fixtures/harness-composition.ts'

const active: RealHarness[] = []
afterEach(async () => {
  await Promise.allSettled(active.splice(0).map(harness => harness.dispose()))
})

function owner(ctx: Context): Agent {
  const session = { id: 'owner-agent', header: { id: 'owner-agent', cwd: process.cwd() } }
  const agent = {
    id: 'owner-agent',
    ctx,
    status: 'busy',
    session,
    inject() {}, followup() {}, cancel() {}, whenIdle: async () => undefined,
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}
async function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ callId: `call-${name}` as never, name, arguments: args, agent, signal: new AbortController().signal })
}

describe('real Cordis Harness composition', () => {
  it('registers autoresearch, generic job controls, and ordered prompt guidance', async () => {
    const harness = await composeHarness()
    active.push(harness)

    expect(harness.ctx.tools.get('autoresearch')?.name).toBe('autoresearch')
    expect(harness.ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining(['autoresearch', 'job_output', 'job_list', 'job_kill']))
    const prompt = await assembledPrompt(harness.ctx)
    expect(prompt).toContain('Track every background job id you start')
    expect(prompt).toContain('Use autoresearch only when the direct human explicitly requests')
  })

  it('uses the actual LocalJobRegistry through generic list, output, and kill tools', async () => {
    const harness = await composeHarness()
    active.push(harness)
    const agent = owner(harness.ctx)
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const id = harness.ctx.jobs.start({
      kind: 'autoresearch', label: 'composition job', owner: agent,
      run: () => ({
        cancel: () => release(),
        done: done.then(() => ({ status: 'killed' as const, detail: 'test cancellation', output: 'durable output' })),
      }),
    })

    const listed = await execute(harness.ctx, 'job_list', {}, agent)
    expect(listed.isError).toBe(false)
    expect(listed.value).toEqual([expect.objectContaining({ id, kind: 'autoresearch', status: 'running' })])

    const killed = await execute(harness.ctx, 'job_kill', { job_id: id, reason: 'composition test' }, agent)
    expect(killed.isError).toBe(false)
    await harness.ctx.jobs.wait(id, 1_000, agent)
    const output = await execute(harness.ctx, 'job_output', { job_id: id }, agent)
    expect(output.isError).toBe(false)
    expect(output.value).toEqual(expect.objectContaining({ text: 'durable output', job: expect.objectContaining({ status: 'killed' }) }))
  })

  it('executes a real evaluator fixture through the local subprocess provider', async () => {
    const harness = await composeHarness()
    active.push(harness)
    const evaluator = new URL('./fixtures/evaluator.mjs', import.meta.url)
    const handle = harness.ctx.subprocess.spawn({
      argv: [process.execPath, evaluator.pathname, '7.5'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
      graceMs: 250,
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(await handle.waitForExit()).toBe(true)
    expect(handle.collected.stdout?.readFrom(0)).toEqual(expect.objectContaining({ text: '{"metric":7.5}\n', lossy: false }))
    expect(handle.collected.stderr?.readFrom(0).text).toBe('')
  })

  it('removes real tool and prompt registrations on unload', async () => {
    const harness = await composeHarness()
    expect(harness.ctx.tools.get('autoresearch')).toBeDefined()
    expect(harness.autoresearchFiber).toBeDefined()
    await harness.autoresearchFiber!.dispose()
    expect(harness.ctx.tools.get('autoresearch')).toBeUndefined()
    expect(await assembledPrompt(harness.ctx)).not.toContain('Use autoresearch only')
    active.push(harness)
  })
})

describe('bundle/profile and activation failures', () => {
  it('applies the shipped patch through the actual include patch API as opt-in composition', async () => {
    const patch = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as never[]
    const base = [{ id: 'tools', name: '@deepseek-ai/dsh-tools', config: {} }]
    const assembled = applyEntryPatches(base, patch)
    expect(base).toEqual([{ id: 'tools', name: '@deepseek-ai/dsh-tools', config: {} }])
    expect(assembled).toEqual([
      ...base,
      expect.objectContaining({ id: 'autoresearch', name: 'dsh-autoresearch', config: expect.objectContaining({ gitExecutable: 'git', defaultMaxExperiments: 20 }) }),
    ])
  })

  it.each([
    ['jobs', { tools: {}, agents: { create() {} }, subprocess: {}, systemPrompt: {} }],
    ['subprocess', { tools: {}, agents: { create() {} }, jobs: { start() {} }, systemPrompt: {} }],
    ['agents', { tools: {}, jobs: { start() {} }, subprocess: {}, systemPrompt: {} }],
  ])('fails synchronously and clearly without compatible %s composition', (service, seams) => {
    const ctx = Object.assign(new Context(), seams)
    expect(() => apply(ctx as never, {})).toThrow(service === 'agents' ? /ctx\.agents service/ : new RegExp(`ctx\\.${service} service`))
  })

  it('rejects incompatible jobs and Agent registries rather than hanging', () => {
    const base = { tools: {}, subprocess: {}, systemPrompt: {} }
    expect(() => apply(Object.assign(new Context(), base, { jobs: {}, agents: { create() {} } }) as never, {})).toThrow(/compatible ctx\.jobs registry/)
    expect(() => apply(Object.assign(new Context(), base, { jobs: { start() {} }, agents: {} }) as never, {})).toThrow(/compatible ctx\.agents\.create runtime/)
  })
})
