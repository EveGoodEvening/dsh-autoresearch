import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/index.ts'
import { retainSuccessfulJobOutput, serializeSuccessfulRunResult } from '../src/render.ts'
import type { AutoresearchRunResult, AutoresearchToolResult, BudgetLimitedRunResult } from '../src/types.ts'
import { composeHarness, executeTool, observeJobSettlement, type RealHarness } from './fixtures/harness-composition.ts'
import { calls } from './fixtures/loader/model-provider.ts'

const run = promisify(execFile)
const active: RealHarness[] = []
const suffix = '\n[status: completed, budget-limited]'
const smallRun: BudgetLimitedRunResult = {
  status: 'budget-limited', runId: 'presentation-run', tracker: '/研究/𝄞/tracker.sqlite',
  best: { metric: 0, commit: 'b'.repeat(40), experimentId: 'candidate-1' },
  counts: { experimentsStarted: 1, experimentsCompleted: 1, attempts: 2 },
  artifacts: [{ artifactId: 'stdout-1', kind: 'stdout', location: '/研究/𝄞/stdout.txt', sizeBytes: 12, sha256: 'a'.repeat(64) }],
}

async function harness(autoresearchConfig?: Readonly<Record<string, unknown>>) {
  const value = await composeHarness(autoresearchConfig ? { autoresearchConfig } : { autoresearch: false })
  active.push(value)
  return value
}

async function owner(host: RealHarness, cwd = host.root, parent?: Agent) {
  return host.ctx.agents.create({
    sessionId: SessionId(`presentation-${crypto.randomUUID()}`),
    meta: { cwd, ...(parent ? { parentSession: parent.id } : {}) },
    ...(parent ? { parentAgent: parent } : {}),
    agentOptions: { provider: 'autoresearch-test', model: 'bounded-model', maxTokens: 512 },
  })
}

function outputValue(result: ToolExecutionResult) {
  if (result.isError) throw new Error(JSON.stringify(result.error))
  return result.value as unknown as { text: string; job: { id: string; kind: string; status: string; detail?: string } }
}

function text(content: readonly ContentBlock[]): string {
  return content.map(block => {
    if (block.type !== 'text') throw new Error(`unexpected ${block.type} block`)
    return block.text
  }).join('')
}

function expectCapped(result: ToolExecutionResult, cap: number) {
  expect(result.content).toHaveLength(1)
  expect(Buffer.byteLength(text(result.content))).toBeLessThanOrEqual(cap)
}

function startPresentationJob(host: RealHarness, agent: Agent, cap: number, value = smallRun, adapt = true) {
  const terminal = observeJobSettlement(host.ctx, agent.id)
  const pending = Promise.withResolvers<JobOutcome>()
  const selected = serializeSuccessfulRunResult(value, cap)
  const presentation = adapt ? retainSuccessfulJobOutput(agent, cap) : undefined
  const id = host.ctx.jobs.start({
    kind: 'autoresearch', label: 'presentation boundary fixture', owner: agent.id, outputLimitBytes: cap,
    run: () => ({
      done: pending.promise,
      cancel: reason => pending.resolve({ status: 'killed', detail: reason ?? 'fixture cancelled', result: selected }),
    }),
  })
  if (presentation) presentation.state.jobId = id
  return {
    id, selected, presentation,
    async complete(outcome: JobOutcome = { status: 'completed', detail: value.status, result: selected }) {
      if (presentation && outcome.status === 'completed') presentation.state.success = { text: selected, status: value.status }
      pending.resolve(outcome)
      try { expect((await terminal.settled).job.id).toBe(id) } finally { terminal.dispose() }
    },
    dispose: terminal.dispose,
  }
}

async function updateConfig(host: RealHarness, id: string, config: Readonly<Record<string, unknown>>) {
  const entry = [...host.ctx.loader.entries()].find(row => row.options.id === id)
  if (!entry) throw new Error(`missing ${id} Loader row`)
  const previous = entry.fiber
  await entry.update({ disabled: true }, false, true)
  await previous?.await()
  await entry.update({ config: { ...entry.options.config, ...config }, disabled: false }, false, true)
  await host.ctx.loader.await()
}

async function repository(root: string, score: number) {
  const cwd = join(root, '研究-é-𝄞')
  await mkdir(cwd)
  await writeFile(join(cwd, 'score.txt'), `${score}\n`)
  for (const args of [['init', '-q'], ['config', 'user.name', 'Presentation Test'], ['config', 'user.email', 'presentation@example.invalid'], ['add', '.'], ['commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd })
  }
  return cwd
}

function request(cwd: string) {
  return {
    repository: cwd, run_tag: `summary-${crypto.randomUUID().slice(0, 8)}`, evaluator_id: 'judge',
    objective: 'release accepted candidate', mutable_globs: ['score.txt'], max_experiments: 1, timeout_ms: 10_000,
  }
}

async function startRun(host: RealHarness, agent: Agent, args: object) {
  const terminal = observeJobSettlement(host.ctx, agent.id)
  try {
    const started = await executeTool(host.ctx, 'autoresearch', args, agent)
    expect(started.isError).toBe(false)
    const ready = started.value as unknown as AutoresearchToolResult
    if (ready.kind !== 'background') throw new Error(JSON.stringify(ready))
    expect((await terminal.settled).job).toMatchObject({ id: ready.jobId, status: 'completed' })
    return ready
  } finally { terminal.dispose() }
}

function inspect(tracker: string, runId: string) {
  const db = new DatabaseSync(tracker, { readOnly: true })
  try {
    return {
      run: db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId)!,
      experiments: db.prepare('SELECT * FROM experiments WHERE run_id=? ORDER BY ordinal').all(runId),
      attempts: db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY created_at,attempt_id').all(runId),
      lock: db.prepare('SELECT * FROM active_locks WHERE run_id=?').get(runId)!,
    }
  } finally { db.close() }
}

async function resume(host: RealHarness, agent: Agent, args: object, runId: string): Promise<AutoresearchRunResult> {
  const { run_tag: _tag, evaluator_id: _id, ...stable } = args as Record<string, unknown>
  const result = await executeTool(host.ctx, 'autoresearch', { ...stable, resume_run_id: runId, mode: 'foreground' }, agent)
  expect(result.isError).toBe(false)
  const value = result.value as unknown as AutoresearchToolResult
  if (value.kind !== 'foreground') throw new Error(JSON.stringify(value))
  return value.run
}

afterEach(async () => {
  vi.restoreAllMocks()
  calls.length = 0
  const disposed = await Promise.allSettled(active.splice(0).map(host => host.dispose()))
  const failed = disposed.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(item => item.reason), 'presentation Host cleanup failed')
})

describe('production background success presentation', () => {
  it('retains tiny-cap accepted results across producer HMR, with per-job caps and unchanged canonical resume', async () => {
    const host = await harness({ maxResultChars: 1, exportTsv: true })
    const cwd = await repository(host.root, 1)
    const parent = await owner(host, cwd)
    const before = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const notice = Promise.withResolvers<UserMessage>()
    parent.agent.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent.agent && message.source.kind === 'tool-jobs') notice.resolve(message)
    })
    try {
      const args = request(cwd)
      const first = await startRun(host, parent.agent, args)
      const durable = inspect(first.tracker, first.runId)
      expect(durable.run).toMatchObject({ best_metric: 0, terminal_quiescent: 1, start_commit: before })
      expect(durable.experiments).toHaveLength(2)
      expect(durable.experiments[1]).toMatchObject({ kind: 'candidate', state: 'accepted', decision: 'accept', metric: 0 })
      expect(durable.attempts).toHaveLength(2)
      expect(durable.attempts.every(attempt => attempt.process_tree_quiescent === 1)).toBe(true)
      expect(durable.lock.released_at).not.toBeNull()
      const expectedBest = { metric: 0, commit: durable.run.best_commit, experimentId: durable.run.best_experiment_id }
      expect(expectedBest.commit).toBe(durable.experiments[1]!.candidate_commit)
      expect(expectedBest.commit).toMatch(/^[0-9a-f]{40}$/)
      const tsvPath = join(dirname(first.tracker), 'exports', `${first.runId}.tsv`)
      const tsv = await readFile(tsvPath)
      expect(tsv.toString()).toContain(expectedBest.commit)
      // Default wakeup can commit the notice before collection; observe delivery, not a transient inbox snapshot.
      expect(Buffer.byteLength(text((await notice.promise).content))).toBeLessThanOrEqual(1)

      await host.reloadAutoresearch()
      await updateConfig(host, 'autoresearch', { maxResultChars: 65_536 })
      const { run_tag: _tag, evaluator_id: _id, ...stable } = args
      // A second retained job exercises the new cap without another evaluator attempt.
      const secondArgs = { ...stable, resume_run_id: first.runId }
      const second = await startRun(host, parent.agent, secondArgs)
      await host.setAutoresearchEnabled(false)
      const output = await executeTool(host.ctx, 'job_output', { job_id: first.jobId }, parent.agent)
      const value = outputValue(output)
      const summary = {
        status: 'budget-limited', runId: first.runId, tracker: first.tracker, best: expectedBest,
        counts: { experimentsStarted: 1, experimentsCompleted: 1, attempts: 2 }, detailsOmitted: true,
      }
      expect(JSON.parse(value.text)).toEqual(summary)
      expect(output.content).toEqual([{ type: 'text', text: value.text }, { type: 'text', text: suffix }])
      expect(text(output.content)).toBe(value.text + suffix)
      const ample = await executeTool(host.ctx, 'job_output', { job_id: second.jobId }, parent.agent)
      const ampleValue = outputValue(ample)
      expect(ample.content).toEqual([{ type: 'text', text: ampleValue.text + suffix }])
      expect(JSON.parse(ampleValue.text)).toMatchObject({ best: summary.best, artifacts: expect.any(Array), counts: summary.counts })
      expect(JSON.parse(ampleValue.text)).not.toHaveProperty('detailsOmitted')
      const empty = await executeTool(host.ctx, 'job_output', { job_id: first.jobId }, parent.agent)
      expect(outputValue(empty).text).toBe('')
      expect(empty.content).toEqual([{ type: 'text', text: ']' }])

      await host.setAutoresearchEnabled(true)
      const canonical = await resume(host, parent.agent, args, first.runId)
      expect(canonical).toMatchObject({ status: summary.status, runId: first.runId, tracker: first.tracker, best: summary.best, counts: summary.counts })
      expect(canonical.artifacts).not.toHaveLength(0)
      expect(canonical).not.toHaveProperty('detailsOmitted')
      expect(inspect(first.tracker, first.runId)).toEqual(durable)
      expect((await readFile(tsvPath)).equals(tsv)).toBe(true)
      expect(JSON.stringify(await resume(host, parent.agent, secondArgs, second.runId))).toBe(ampleValue.text)
      expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()).toBe(before)
      expect((await run('git', ['status', '--porcelain=v1'], { cwd })).stdout).toBe('')
      expect(await readFile(join(cwd, 'score.txt'), 'utf8')).toBe('1\n')
    } finally { await parent.dispose() }
    expect(host.ctx.jobs.list()).toEqual([])
  }, 60_000)

  it('delivers a real zero baseline target and full terminal foreground resume at cap one', async () => {
    const host = await harness({ maxResultChars: 1 })
    const cwd = await repository(host.root, 0)
    const parent = await owner(host, cwd)
    try {
      const args = { ...request(cwd), target: 0 }
      const ready = await startRun(host, parent.agent, args)
      const output = await executeTool(host.ctx, 'job_output', { job_id: ready.jobId }, parent.agent)
      const selected = outputValue(output).text
      const durable = inspect(ready.tracker, ready.runId)
      expect(JSON.parse(selected)).toEqual({
        status: 'target-reached', runId: ready.runId, tracker: ready.tracker,
        best: { metric: 0, commit: durable.run.start_commit, experimentId: durable.experiments[0]!.experiment_id },
        counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 }, target: 0, detailsOmitted: true,
      })
      expect(output.content).toEqual([{ type: 'text', text: selected }, { type: 'text', text: '\n[status: completed, target-reached]' }])
      const canonical = await resume(host, parent.agent, args, ready.runId)
      expect(canonical).not.toHaveProperty('detailsOmitted')
      expect(canonical).toMatchObject({ target: 0, best: { metric: 0 }, counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } })
      expect(canonical.artifacts).not.toHaveLength(0)
      expect(inspect(ready.tracker, ready.runId)).toEqual(durable)
      expect(durable.lock.released_at).not.toBeNull()
    } finally { await parent.dispose() }
  }, 30_000)
})

describe('stock Jobs presentation and Host policy pipeline', () => {
  it('preserves exact full JSON across UTF-8/framing boundaries and leaves byte-fitting single blocks unchanged', async () => {
    const host = await harness()
    const parent = await owner(host)
    try {
      const full = JSON.stringify(smallRun)
      const bytes = Buffer.byteLength(full + suffix)
      for (const cap of [full.length, bytes - 1, bytes, bytes + 1, Number.MAX_SAFE_INTEGER]) {
        const job = startPresentationJob(host, parent.agent, cap)
        await job.complete()
        const output = await executeTool(host.ctx, 'job_output', { job_id: job.id }, parent.agent)
        expect(outputValue(output).text).toBe(full)
        expect(output.content).toEqual(bytes <= cap
          ? [{ type: 'text', text: full + suffix }]
          : [{ type: 'text', text: full }, { type: 'text', text: suffix }])
        expect(Buffer.byteLength(text(output.content))).toBe(bytes)
      }
    } finally { await parent.dispose() }
  }, 30_000)

  it('lets real spill policy price the proposed two blocks at the one-block-fit/two-block-over threshold', async () => {
    const host = await harness()
    const parent = await owner(host)
    try {
      const large = { ...smallRun, tracker: `/ascii/${'x'.repeat(4_000)}/tracker.sqlite` }
      const full = JSON.stringify(large)
      const cap = full.length
      const oneBlockTokens = Math.ceil((full.length + suffix.length) / 4) + 4
      expect(Math.ceil(full.length / 4) + 4 + Math.ceil(suffix.length / 4) + 4).toBe(oneBlockTokens + 4)
      await updateConfig(host, 'spill-policy', { maxInlineTokens: oneBlockTokens })
      const backend = host.ctx.get('spillStore')!
      const save = vi.spyOn(backend, 'saveText')
      // Negative control: the original one-block shape fits spill policy, but Jobs still caps it.
      const stock = startPresentationJob(host, parent.agent, cap, large, false)
      await stock.complete()
      const unsplit = await executeTool(host.ctx, 'job_output', { job_id: stock.id }, parent.agent)
      expectCapped(unsplit, cap)
      expect(text(unsplit.content)).toContain('[output truncated]')
      expect(save.mock.results).toEqual([])
      const adapted = startPresentationJob(host, parent.agent, cap, large)
      await adapted.complete()
      const output = await executeTool(host.ctx, 'job_output', { job_id: adapted.id }, parent.agent)
      expect(outputValue(output).text).toBe(full)
      const spill = await save.mock.results.at(-1)?.value
      expect(spill).toMatchObject({ bytes: Buffer.byteLength(full + suffix), locator: expect.any(String) })
      expect(await readFile(spill.locator, 'utf8')).toBe(full + suffix)
      expect(text(output.content)).toContain('Full formatted result stored at:')
      expect(output.content).not.toEqual([{ type: 'text', text: full }, { type: 'text', text: suffix }])
      expectCapped(output, cap)
    } finally { await parent.dispose() }
  }, 30_000)

  it.each(['pass', 'context', 'block', 'content', 'value', 'equal-value', 'throw'] as const)('preserves an inner %s decision through actual finalization', async policy => {
    const host = await harness()
    const parent = await owner(host)
    try {
      const job = startPresentationJob(host, parent.agent, 64)
      const context = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Host policy context' }] })
      let continuations = 0
      parent.agent.ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        if (exec.name !== 'job_output') return decision
        continuations++
        if (policy === 'throw') throw new Error('Host policy threw')
        if (policy === 'block') return { kind: 'block', feedback: [{ type: 'text', text: 'Host denied' }] }
        if (policy === 'content') return { kind: 'accept', content: [{ type: 'text', text: 'Host redacted' }] }
        if (policy === 'value' || policy === 'equal-value') {
          const value = outputValue(result)
          return { kind: 'accept', value: policy === 'equal-value' ? result.value! : { ...value, text: 'Host replacement' } }
        }
        return policy === 'context' ? { ...decision, additionalContexts: [context] } : decision
      })
      await job.complete()
      const output = await executeTool(host.ctx, 'job_output', { job_id: job.id }, parent.agent)
      expect(continuations).toBe(1)
      if (policy === 'pass' || policy === 'context') {
        expect(output.content).toEqual([{ type: 'text', text: job.selected }, { type: 'text', text: suffix }])
        if (policy === 'context') expect(output.additionalContexts).toEqual([context])
      } else {
        expectCapped(output, 64)
        if (policy === 'block') expect(output).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Host denied' }] })
        if (policy === 'throw') expect(output).toMatchObject({ isError: true, error: { message: 'Host policy threw' } })
        if (policy === 'content') expect(output.content).toEqual([{ type: 'text', text: 'Host redacted' }])
        if (policy === 'value') expect(outputValue(output).text).toBe('Host replacement')
        if (policy === 'equal-value') {
          expect(outputValue(output).text).toBe(job.selected)
          expect(text(output.content)).toContain('[output truncated]')
        }
      }
    } finally { await parent.dispose() }
  }, 30_000)

  it('lets an enclosing Host policy inspect and replace the actual proposal while preserving contexts', async () => {
    const host = await harness()
    const parent = await owner(host)
    try {
      const context = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'enclosing policy context' }] })
      let proposed: ContentBlock[] | undefined
      parent.agent.ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        if (exec.name !== 'job_output' || decision.kind !== 'accept') return decision
        proposed = decision.content ?? result.content
        return { kind: 'accept', content: [{ type: 'text', text: 'outer redaction' }], additionalContexts: [context] }
      }, { prepend: true })
      const job = startPresentationJob(host, parent.agent, 64)
      await job.complete()
      const output = await executeTool(host.ctx, 'job_output', { job_id: job.id }, parent.agent)
      expect(proposed).toEqual([{ type: 'text', text: job.selected }, { type: 'text', text: suffix }])
      expect(output.content).toEqual([{ type: 'text', text: 'outer redaction' }])
      expect(output.additionalContexts).toEqual([context])
    } finally { await parent.dispose() }
  }, 30_000)

  it('does not restore successful JSON when the caller aborts while post-execute continuation is pending', async () => {
    const host = await harness()
    const parent = await owner(host)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let pending: Promise<ToolExecutionResult> | undefined
    try {
      const job = startPresentationJob(host, parent.agent, 64)
      parent.agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
        const decision = await next()
        if (exec.name === 'job_output') { entered.resolve(); await release.promise }
        return decision
      })
      await job.complete()
      const abort = new AbortController()
      pending = executeTool(host.ctx, 'job_output', { job_id: job.id }, parent.agent, abort.signal)
      await entered.promise
      abort.abort(new Error('cancel read'))
      release.resolve()
      const output = await pending
      expect(output).toMatchObject({ isError: true, error: { message: 'tool call aborted' } })
      expectCapped(output, 64)
      expect(text(output.content)).not.toContain(job.selected)
    } finally { release.resolve(); await pending; await parent.dispose() }
  }, 30_000)

  it('keeps foreign/descendant owners, unrelated producers, repeat reads, failures, kills and errors outside the success floor', async () => {
    const host = await harness()
    const parent = await owner(host)
    const foreign = await owner(host)
    const child = await owner(host, host.root, parent.agent)
    try {
      const pending = startPresentationJob(host, parent.agent, 64)
      const running = await executeTool(host.ctx, 'job_output', { job_id: pending.id }, parent.agent)
      expect(outputValue(running)).toMatchObject({ text: '', job: { status: 'running' } })
      expect(running.content).toEqual([{ type: 'text', text: '(no new output)\n[status: running]' }])
      for (const agent of [foreign.agent, child.agent]) {
        const denied = await executeTool(host.ctx, 'job_output', { job_id: pending.id }, agent)
        expect(denied.isError).toBe(true)
        expect(text(denied.content)).not.toContain(pending.selected)
      }
      await pending.complete()
      expect((await executeTool(host.ctx, 'job_output', { job_id: pending.id }, parent.agent)).content).toEqual([
        { type: 'text', text: pending.selected }, { type: 'text', text: suffix },
      ])
      const empty = await executeTool(host.ctx, 'job_output', { job_id: pending.id }, parent.agent)
      expect(outputValue(empty).text).toBe('')
      expectCapped(empty, 64)
      expect(text(empty.content)).not.toContain(pending.selected)
      // Same kind and identical selected JSON are insufficient without this exact job's registration.
      const other = startPresentationJob(host, parent.agent, 64, smallRun, false)
      await other.complete()
      const unadapted = await executeTool(host.ctx, 'job_output', { job_id: other.id }, parent.agent)
      expectCapped(unadapted, 64)
      expect(text(unadapted.content)).toContain('[output truncated]')
      for (const status of ['failed', 'killed'] as const) {
        const job = startPresentationJob(host, parent.agent, 64)
        await job.complete({ status, detail: 'baseline-blocked', result: job.selected })
        const output = await executeTool(host.ctx, 'job_output', { job_id: job.id }, parent.agent)
        expect(outputValue(output)).toMatchObject({ text: job.selected, job: { status } })
        expectCapped(output, 64)
        expect(text(output.content)).toContain('[output truncated]')
      }
      const killed = startPresentationJob(host, parent.agent, 1)
      const kill = await executeTool(host.ctx, 'job_kill', { job_id: killed.id }, parent.agent)
      expectCapped(kill, 1)
      await killed.complete()
      const killedOutput = await executeTool(host.ctx, 'job_output', { job_id: killed.id }, parent.agent)
      expect(outputValue(killedOutput).job.status).toBe('killed')
      expectCapped(killedOutput, 1)
      parent.agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'job_output'
        ? { kind: 'deny', reason: 'Host denied this known job. '.repeat(20) } : next())
      const denied = await executeTool(host.ctx, 'job_output', { job_id: pending.id }, parent.agent)
      expect(denied.isError).toBe(true)
      expectCapped(denied, 64)
    } finally { await child.dispose(); await foreign.dispose(); await parent.dispose() }
    expect(host.ctx.jobs.list()).toEqual([])
  }, 30_000)
})
