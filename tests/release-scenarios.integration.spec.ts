import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { composeHarness, packageRoot } from './fixtures/harness-composition.ts'

const evaluator = new URL('./fixtures/loader/evaluator.mjs', import.meta.url).pathname
const descendantEvaluator = new URL('./fixtures/loader/evaluator-descendant-hold.mjs', import.meta.url).pathname
const evidencePath = process.env.DSH_AUTORESEARCH_EVIDENCE
const installedRoot = process.env.DSH_AUTORESEARCH_INSTALLED_ROOT
const releaseDescribe = installedRoot === undefined ? describe.skip : describe
if (installedRoot !== undefined && packageRoot !== installedRoot) throw new Error(`fixture resolved ${packageRoot}, expected installed package ${installedRoot}`)
// The release test intentionally loads the runtime-selected packed installation rather than source modules.
const installedModule = (name: string) => pathToFileURL(join(installedRoot!, 'lib', `${name}.js`)).href

interface ReleaseRun {
  readonly status: string
  readonly runId: string
  readonly tracker: string
  readonly counts: { readonly experimentsStarted: number; readonly experimentsCompleted: number; readonly attempts: number }
  readonly best?: { readonly metric: number; readonly commit: string; readonly experimentId: string }
  readonly evidence?: Array<{ readonly code?: string }>
}

interface ReleaseToolValue {
  readonly kind: 'foreground' | 'background'
  readonly jobId: string
  readonly runId: string
  readonly tracker: string
  readonly run: ReleaseRun
}


function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trimEnd()
}

async function repository(root: string, name: string): Promise<string> {
  const cwd = join(root, name)
  await mkdir(cwd)
  await writeFile(join(cwd, 'score.txt'), name === 'tie' ? '1.0\n' : '1\n')
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['config', 'user.name', 'Release Scenario'])
  git(cwd, ['config', 'user.email', 'release@example.invalid'])
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-qm', 'baseline'])
  return cwd
}

function snapshot(cwd: string): { head: string; branch: string; index: string; status: string } {
  return {
    head: git(cwd, ['rev-parse', 'HEAD']),
    branch: git(cwd, ['symbolic-ref', '--short', 'HEAD']),
    index: git(cwd, ['write-tree']),
    status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  }
}

async function parent(ctx: Context, cwd: string) {
  return ctx.agents.create({
    sessionId: SessionId(`release-${crypto.randomUUID()}`),
    meta: { cwd },
    agentOptions: { provider: 'autoresearch-test', model: 'bounded-model', maxTokens: 512 },
  })
}

async function execute(ctx: Context, agent: Agent, args: unknown): Promise<ReleaseToolValue> {
  const result = await ctx.tools.execute({
    callId: `release-${crypto.randomUUID()}` as never,
    name: 'autoresearch',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result))
  return result.value as unknown as ReleaseToolValue
}

function request(cwd: string, objective: string, mode: 'foreground' | 'background' = 'foreground') {
  return {
    repository: cwd,
    run_tag: `release-${crypto.randomUUID().slice(0, 8)}`,
    objective,
    mutable_globs: ['score.txt'],
    evaluation: { command: process.execPath, args: [evaluator] },
    metric_name: 'score',
    metric_direction: 'minimize',
    max_experiments: 1,
    timeout_ms: 10_000,
    mode,
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
}

async function processGone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0] === 'Z'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return true
    throw error
  }
}
async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}



function inspect(trackerPath: string, runId: string) {
  const db = new DatabaseSync(trackerPath, { readOnly: true })
  try {
    const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) as Record<string, unknown>
    const experiments = db.prepare('SELECT ordinal,kind,state,metric,decision,parent_commit,candidate_commit FROM experiments WHERE run_id=? ORDER BY ordinal').all(runId) as Array<Record<string, unknown>>
    const transitions = db.prepare('SELECT sequence,scope,from_state,to_state,intent_json,outcome_json FROM transitions WHERE run_id=? ORDER BY sequence').all(runId) as Array<Record<string, unknown>>
    const lock = db.prepare('SELECT acquired_at,released_at FROM active_locks WHERE run_id=?').get(runId) as Record<string, unknown>
    return { run, experiments, transitions, lock }
  } finally {
    db.close()
  }
}

const evidence: Record<string, unknown> = { installedRoot }

releaseDescribe('packed release scenarios', () => {
  it('observes the installed controller prepare barrier before any autoresearch mutation', async () => {
    const harness = await composeHarness()
    const cwd = await repository(harness.root, 'prepare-barrier')
    const owner = await parent(harness.ctx, cwd)
    const marker = join(harness.root, 'prepare-evaluator.marker')
    const before = snapshot(cwd)
    const { AutoresearchRunController } = await import(installedModule('controller'))
    const { resolveConfig } = await import(installedModule('config'))
    const args = request(cwd, 'release accepted candidate')
    args.evaluation = {
      command: process.execPath,
      args: ['-e', `const fs=require('node:fs');fs.appendFileSync(process.argv[1],'spawned\\n');const score=Number(fs.readFileSync('score.txt','utf8'));process.stdout.write(JSON.stringify({score})+'\\n')`, marker],
    }
    const controller = new AutoresearchRunController(harness.ctx, {
      config: resolveConfig({ terminationGraceMs: 5_000 }), input: args, parent: owner.agent, signal: new AbortController().signal,
    })
    try {
      const prepared = await controller.prepare()
      const preparedDb = new DatabaseSync(prepared.tracker, { readOnly: true })
      const run = preparedDb.prepare('SELECT run_id,state FROM runs WHERE run_id=?').get(prepared.runId) as Record<string, unknown>
      const experiments = Number(preparedDb.prepare('SELECT COUNT(*) n FROM experiments WHERE run_id=?').get(prepared.runId)?.n)
      const localLocks = Number(preparedDb.prepare('SELECT COUNT(*) n FROM active_locks WHERE run_id=? AND released_at IS NULL').get(prepared.runId)?.n)
      preparedDb.close()
      const refs = git(cwd, ['for-each-ref', '--format=%(refname)', `refs/autoresearch/runs/${prepared.runId}/`]).split('\n').filter(Boolean)
      const authority = new DatabaseSync(join(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dsh-autoresearch-locks.sqlite'), { readOnly: true })
      const sharedLocks = Number(authority.prepare('SELECT COUNT(*) n FROM active_locks WHERE run_id=?').get(prepared.runId)?.n)
      authority.close()
      const preparedObservation = {
        trackerExists: await pathExists(prepared.tracker), runExists: run.run_id === prepared.runId, runState: run.state,
        experiments, localLocks, sharedLocks, worktreeExists: await pathExists(prepared.worktree), refs, evaluatorMarkerExists: await pathExists(marker), caller: snapshot(cwd),
      }
      expect(preparedObservation).toEqual({ trackerExists: true, runExists: true, runState: 'initializing', experiments: 0, localLocks: 0, sharedLocks: 0, worktreeExists: false, refs: [], evaluatorMarkerExists: false, caller: before })

      const completed = await controller.run()
      expect(completed.status).toBe('budget-limited')
      expect(await pathExists(marker)).toBe(true)
      evidence.prepareBarrier = { ok: true, prepared: preparedObservation, afterRun: { status: completed.status, evaluatorMarkerExists: true } }
    } finally {
      await controller.dispose()
      await owner.dispose()
      await harness.dispose().catch(() => undefined)
    }
  }, 45_000)

  it('runs accepted and rejected candidates with strict decisions and durable Git/tracker evidence', async () => {
    const harness = await composeHarness()
    const scenarios = [
      { name: 'accepted', objective: 'release accepted candidate', decision: 'accept', state: 'accepted', metric: 0 },
      { name: 'tie', objective: 'release tie candidate', decision: 'reject', state: 'rejected', metric: 1 },
      { name: 'rejected', objective: 'release rejected candidate', decision: 'reject', state: 'rejected', metric: 2 },
    ]
    try {
      for (const scenario of scenarios) {
        const cwd = await repository(harness.root, scenario.name)
        const owner = await parent(harness.ctx, cwd)
        const before = snapshot(cwd)
        try {
          const value = await execute(harness.ctx, owner.agent, request(cwd, scenario.objective))
          const run = value.run
          expect(value.kind).toBe('foreground')
          if (run.status !== 'budget-limited') throw new Error(JSON.stringify({ status: run.status, evidence: run.evidence }))

          expect(snapshot(cwd)).toEqual(before)
          const durable = inspect(run.tracker, run.runId)
          expect(durable.run.start_commit).toBe(before.head)
          expect(durable.experiments[0]).toMatchObject({ kind: 'baseline', metric: 1, state: 'accepted' })
          expect(durable.experiments[1]).toMatchObject({ kind: 'candidate', metric: scenario.metric, decision: scenario.decision, state: scenario.state })

          const candidate = String(durable.experiments[1].candidate_commit)
          expect(candidate).toMatch(/^[0-9a-f]{40}$/)
          const auditRefs = git(cwd, ['for-each-ref', '--format=%(objectname)', `refs/autoresearch/runs/${run.runId}/candidates/`]).split('\n').filter(Boolean)
          expect(auditRefs).toContain(candidate)
          expect(String(durable.run.branch)).toContain(run.runId)
          expect(String(durable.run.worktree)).toContain(run.runId)
          expect(durable.transitions[0].scope).toBe('run')
          expect(durable.transitions.some(row => row.scope === 'experiment' && row.to_state === 'baseline-pending')).toBe(true)
          expect(durable.lock.released_at).not.toBeNull()
          expect(durable.run.terminal_quiescent).toBe(1)

          const exportDirectory = join(dirname(run.tracker), 'exports')
          const tsvPath = join(exportDirectory, `${run.runId}.tsv`)
          const { DurableTracker } = await import(installedModule('tracker'))
          const publisher = DurableTracker.open(run.tracker)
          publisher.exportTsv(run.runId, tsvPath)
          const first = await readFile(tsvPath)
          publisher.exportTsv(run.runId, tsvPath)
          const second = await readFile(tsvPath)
          const firstHash = createHash('sha256').update(first).digest('hex'); const secondHash = createHash('sha256').update(second).digest('hex')
          const lines = first.toString('utf8').trimEnd().split('\n')
          const ordinals = lines.slice(1).map(line => Number(line.split('\t', 1)[0]))
          const temporaryFiles = (await readdir(exportDirectory)).filter(name => name.startsWith(`${run.runId}.tsv.`) && name.endsWith('.tmp'))
          expect(second).toEqual(first)
          expect(firstHash).toBe(secondHash)
          expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right))
          expect(lines).toHaveLength(durable.experiments.length + 1)
          expect(first.toString('utf8')).toContain(candidate)
          expect(temporaryFiles).toEqual([])
          expect(harness.ctx.agents.list().map((agent: Agent) => agent.id)).toEqual([owner.agent.id])
          evidence[scenario.name] = { ok: true, runId: run.runId, caller: before, identity: { branch: durable.run.branch, worktree: durable.run.worktree, startCommit: durable.run.start_commit }, baseline: durable.experiments[0], candidate: durable.experiments[1], auditCommit: candidate, strictDecision: scenario.decision, tsv: { location: tsvPath, firstSha256: firstHash, secondSha256: secondHash, equalBytes: first.equals(second), rowCount: lines.length - 1, ordinals, temporaryFiles, lowerLayerAtomicFaultTest: "tests/tracker.spec.ts: 'publishes deterministic run-scoped TSV atomically and retries independently from committed state'" }, terminalBeforeLockRelease: true, agentDisposed: true }
        } finally {
          await owner.dispose()
        }
      }
    } finally {
      await harness.dispose().catch(() => undefined)
    }
  }, 60_000)

  it('uses real deferred jobs, generic list/output/kill, and quiescent cancellation', async () => {
    const harness = await composeHarness()
    try {
      const cwd = await repository(harness.root, 'background')
      const owner = await parent(harness.ctx, cwd)
      try {
        const args = request(cwd, 'release accepted candidate', 'background')
        const started = await execute(harness.ctx, owner.agent, args)
        expect(started).toMatchObject({ kind: 'background', jobId: expect.any(String), runId: expect.any(String) })

        const listed = await harness.ctx.tools.execute({ callId: 'list' as never, name: 'job_list', arguments: {}, agent: owner.agent, signal: new AbortController().signal })
        expect(listed.isError).toBe(false)
        expect(listed.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: started.jobId })]))

        const output = await harness.ctx.tools.execute({ callId: 'output' as never, name: 'job_output', arguments: { job_id: started.jobId, wait: true, timeout_ms: 20_000 }, agent: owner.agent, signal: new AbortController().signal })
        expect(output.isError).toBe(false)
        const outputValue = output.value as unknown as { text: string }
        const completed = JSON.parse(outputValue.text) as ReleaseRun
        if (completed.status !== 'budget-limited') throw new Error(JSON.stringify({ status: completed.status, evidence: completed.evidence }))

        const kill = await harness.ctx.tools.execute({ callId: 'kill' as never, name: 'job_kill', arguments: { job_id: started.jobId }, agent: owner.agent, signal: new AbortController().signal })
        expect(kill.isError).toBe(false)
        const noLiveJobs = harness.ctx.jobs.list(owner.agent).every(job => !['running', 'stopping'].includes(job.status))

        const durable = inspect(started.tracker, started.runId); const resumeCwd = join(cwd, 'resume-cwd')
        await mkdir(resumeCwd); await writeFile(join(resumeCwd, 'caller.txt'), 'advance caller head\n')
        git(cwd, ['add', 'resume-cwd/caller.txt']); git(cwd, ['commit', '-qm', 'advance caller head'])
        const advancedHead = git(cwd, ['rev-parse', 'HEAD'])
        const { run_tag: _tag, mode: _mode, repository: _repository, ...stable } = args
        const resumed = await execute(harness.ctx, owner.agent, { ...stable, repository: resumeCwd, resume_run_id: started.runId, mode: 'foreground' })
        expect(resumed).toMatchObject({ kind: 'foreground', run: { runId: started.runId, status: 'budget-limited', best: completed.best } })
        expect(resumed.run).toEqual(completed)

        evidence.background = {
          ok: true, readiness: started, listed: true, output: completed.status, kill: true, noLiveJobs,
          resumedStatus: resumed.run.status, resumedBest: resumed.run.best, resumeResultMatches: true,
          headAdvanced: advancedHead !== durable.run.start_commit, resumeCwdChanged: resumeCwd !== durable.run.caller_cwd,
        }
      } finally {
        await owner.dispose()
      }
    } finally {
      await harness.dispose().catch(() => undefined)
    }
  }, 45_000)

  it('interrupts a real evaluator descendant tree and resumes without duplicate work', async () => {
    const harness = await composeHarness()
    try {
      const cwd = await repository(harness.root, 'interruption'); const owner = await parent(harness.ctx, cwd); const marker = join(harness.root, 'descendants.json')
      try {
        const args = { ...request(cwd, 'release interruption resume', 'background'), evaluation: { command: process.execPath, args: [descendantEvaluator, marker] } }
        const started = await execute(harness.ctx, owner.agent, args); await waitUntil(async () => { try { await readFile(marker); return true } catch { return false } }, 'descendant evaluator did not start')
        const pids = JSON.parse(await readFile(marker, 'utf8')) as { parent: number; child: number }
        const killed = await harness.ctx.tools.execute({ callId: 'interrupt-kill' as never, name: 'job_kill', arguments: { job_id: started.jobId }, agent: owner.agent, signal: new AbortController().signal }); expect(killed.isError).toBe(false)
        await harness.ctx.jobs.wait(started.jobId, 20_000, owner.agent); await waitUntil(async () => await processGone(pids.parent) && await processGone(pids.child), 'provider-owned evaluator tree survived cancellation')
        const { run_tag: _tag, mode: _mode, ...stable } = args; const resumed = await execute(harness.ctx, owner.agent, { ...stable, resume_run_id: started.runId, mode: 'foreground' })
        expect(resumed).toMatchObject({ kind: 'foreground', run: { runId: started.runId, status: 'cancelled' } })
        const durable = inspect(started.tracker, started.runId); const db = new DatabaseSync(started.tracker, { readOnly: true }); const attempts = Number(db.prepare('SELECT COUNT(*) n FROM attempts').get()?.n); const uncertain = Number(db.prepare('SELECT COUNT(*) n FROM attempts WHERE process_tree_quiescent IS NOT 1').get()?.n); db.close(); expect(attempts).toBe(1); expect(uncertain).toBe(0)
        evidence.interruptionResume = { ok: true, runId: started.runId, parentPid: pids.parent, childPid: pids.child, processTreeQuiescent: true, resumedStatus: resumed.run.status, attempts, duplicateCandidate: durable.experiments.filter(row => row.kind === 'candidate').length > 1 }
      } finally { await owner.dispose() }
    } finally { await harness.dispose().catch(() => undefined) }
  }, 45_000)

  it('blocks a restart with no quiescence proof without signalling or duplicating evaluation', async () => {
    const harness = await composeHarness()
    try {
      const cwd = await repository(harness.root, 'uncertain'); const owner = await parent(harness.ctx, cwd)
      try {
        const args = request(cwd, 'release accepted candidate'); const completed = await execute(harness.ctx, owner.agent, args); const run = completed.run; const db = new DatabaseSync(run.tracker)
        const attemptId = String(db.prepare('SELECT attempt_id FROM attempts ORDER BY ordinal DESC LIMIT 1').get()?.attempt_id); const beforeAttempts = Number(db.prepare('SELECT COUNT(*) n FROM attempts').get()?.n)
        db.prepare('UPDATE attempts SET process_tree_quiescent=NULL, exited_at=NULL, provider_attempt_id=?, provider_pid=? WHERE attempt_id=?').run(`pid:${process.pid}`, process.pid, attemptId)
        db.prepare('UPDATE runs SET terminal_quiescent=0 WHERE run_id=?').run(run.runId); db.prepare('UPDATE active_locks SET released_at=NULL WHERE run_id=?').run(run.runId); db.close()
        const kill = vi.spyOn(process, 'kill'); const { run_tag: _tag, mode: _mode, ...stable } = args
        try {
          const resumed = await execute(harness.ctx, owner.agent, { ...stable, resume_run_id: run.runId, mode: 'foreground' }); expect(resumed.run.status).toBe('blocked')
          const check = new DatabaseSync(run.tracker, { readOnly: true }); const afterAttempts = Number(check.prepare('SELECT COUNT(*) n FROM attempts').get()?.n); const lock = check.prepare('SELECT released_at FROM active_locks WHERE run_id=?').get(run.runId) as { released_at: string | null }; check.close(); expect(afterAttempts).toBe(beforeAttempts); expect(lock.released_at).toBeNull(); expect(kill.mock.calls.some(([pid, signal]) => Math.abs(Number(pid)) === process.pid && signal !== 0)).toBe(false)
          evidence.uncertainRestart = { ok: true, status: resumed.run.status, code: resumed.run.evidence?.[0]?.code, pidSignalled: false, attempts: afterAttempts, duplicateEvaluation: false, lockRetained: true }
        } finally { kill.mockRestore() }
      } finally { await owner.dispose() }
    } finally { await harness.dispose().catch(() => undefined) }
  }, 45_000)

  it('writes machine-readable evidence', async () => {
    expect(evidence.prepareBarrier).toBeDefined(); expect(evidence.accepted).toBeDefined(); expect(evidence.tie).toBeDefined(); expect(evidence.rejected).toBeDefined(); expect(evidence.background).toBeDefined(); expect(evidence.interruptionResume).toBeDefined(); expect(evidence.uncertainRestart).toBeDefined()
    if (evidencePath) await writeFile(evidencePath, JSON.stringify({ ok: true, ...evidence }))
  })
})
