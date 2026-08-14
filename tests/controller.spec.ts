import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { AutoresearchRunController } from '../src/controller.ts'

import { DurableTracker } from '../src/tracker.ts'
const input = {
  repository: '.', run_tag: 'controller-test', objective: 'improve score', mutable_globs: ['src/**'],
  evaluation: { command: 'node', args: ['evaluate.mjs'] }, metric_name: 'score', metric_direction: 'minimize' as const,
  max_experiments: 2, mode: 'foreground' as const,
}

function parent(): Agent {
  return { id: 'parent', session: { header: { id: 'session', cwd: process.cwd() } } } as unknown as Agent
}

describe('exclusive autoresearch controller contract', () => {
  it('performs no repository, tracker, child, or evaluator effect during construction', () => {
    const ctx = new Proxy({}, { get: vi.fn(() => { throw new Error('constructor touched runtime service') }) }) as Context
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig(), input, parent: parent(), signal: new AbortController().signal })
    expect(controller.ready).toBeInstanceOf(Promise)
  })

  it('memoizes the single state-machine execution', async () => {
    const resolveExecutable = vi.fn(async () => { throw new Error('discovery stopped') })
    const ctx = { subprocess: { resolveExecutable } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig(), input, parent: parent(), signal: new AbortController().signal })
    const first = controller.run()
    const second = controller.run()
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('discovery stopped')
    await expect(controller.ready).rejects.toThrow('discovery stopped')
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
  })

  it('makes cancellation idempotent before initialization and never allocates a child', async () => {
    const resolveExecutable = vi.fn(async () => '/usr/bin/git')
    const create = vi.fn()
    const ctx = { subprocess: { resolveExecutable }, agents: { create } } as unknown as Context
    const signal = new AbortController()
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig(), input, parent: parent(), signal: signal.signal })
    controller.cancel('operator stop')
    controller.cancel('later reason must not replace the first')
    await expect(controller.run()).rejects.toThrow()
    await expect(controller.ready).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('disposal before run is quiescent and does not touch runtime services', async () => {
    const touched = vi.fn()
    const ctx = new Proxy({}, { get: () => { touched(); return undefined } }) as Context
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig(), input, parent: parent(), signal: new AbortController().signal })
    await controller.dispose()
    await expect(controller.ready).rejects.toThrow('disposed before start')
    expect(touched).not.toHaveBeenCalled()
  })

  it('records candidate commit lineage exactly once before evaluation', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-candidate-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite'))
      const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.createExperiment({ experimentId: 'candidate-1', runId: 'run', ordinal: 1, kind: 'candidate', parentCommit: sha, command: 'node', args: [] })
      const candidate = 'd'.repeat(40)
      tracker.recordCandidateCommit('candidate-1', candidate)
      tracker.recordCandidateCommit('candidate-1', candidate)
      expect(tracker.database.prepare('SELECT candidate_commit FROM experiments WHERE experiment_id = ?').get('candidate-1')?.['candidate_commit']).toBe(candidate)
      expect(() => tracker.recordCandidateCommit('candidate-1', 'e'.repeat(40))).toThrow(/conflicts/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('persists a terminal blocked result without releasing an uncertain evaluator lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-blocked-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite'))
      const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.acquireActiveLock('run', 'repo', 'tag')
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.createAttemptIntent({ attemptId: 'attempt', runId: 'run', experimentId: 'baseline', ordinal: 1 }, { provenanceSha256: 'c'.repeat(64) })
      tracker.commitTerminalExperiment('baseline', 'crashed', { failureCode: 'signal', failureMessage: 'provider ownership lost' })
      tracker.transitionRun('run', 'blocked', { blockedCode: 'attempt-uncertain', terminalReason: 'descendant survival is uncertain', quiescent: false })
      expect(tracker.recoveryState('run')).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false })
      expect(() => tracker.releaseActiveLock('run')).toThrow(/quiescence/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('commits a successful baseline using the accepted-state fact contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-baseline-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running')
      tracker.createExperiment({ experimentId: 'baseline', runId: 'run', ordinal: 0, kind: 'baseline', parentCommit: sha, command: 'node', args: [] })
      tracker.transitionExperiment('baseline', 'running')
      tracker.commitTerminalExperiment('baseline', 'accepted', { metric: 1, decision: 'accept' })
      tracker.transitionRun('run', 'ready', { best: { metric: 1, commit: sha, experimentId: 'baseline' } })
      expect(tracker.getRun('run')).toMatchObject({ state: 'ready', best_metric: 1 })
      expect(tracker.database.prepare('SELECT state, metric, exit_code FROM experiments WHERE experiment_id = ?').get('baseline')).toMatchObject({ state: 'accepted', metric: 1, exit_code: null })
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('atomically creates and prepares one candidate without a ready-state fault window', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-prepare-'))
    try {
      const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const sha = 'a'.repeat(40)
      tracker.createRun({ runId: 'run', repositoryId: 'repo', repository: '/repo', gitCommonDir: '/repo/.git', callerCwd: '/repo', startCommit: sha, runTag: 'tag', branch: 'autoresearch/tag-run', worktree: '/worktree', policy: {}, policySha256: 'b'.repeat(64), provenance: {}, provenanceSha256: 'c'.repeat(64) })
      tracker.transitionRun('run', 'baseline-running'); tracker.transitionRun('run', 'ready', { best: { metric: 1, commit: sha, experimentId: 'baseline' } })
      tracker.prepareCandidate({ experimentId: 'candidate-1', runId: 'run', ordinal: 1, kind: 'candidate', parentCommit: sha, command: 'node', args: [] }, { intent: { kind: 'candidate-snapshot', experimentId: 'candidate-1' } })
      expect(tracker.getRun('run')?.['state']).toBe('candidate-prepared')
      expect(tracker.database.prepare('SELECT state FROM experiments WHERE experiment_id = ?').get('candidate-1')?.['state']).toBe('baseline-pending')
      expect(() => tracker.prepareCandidate({ experimentId: 'candidate-2', runId: 'run', ordinal: 2, kind: 'candidate', parentCommit: sha, command: 'node', args: [] }, {})).toThrow(/ready run/)
      tracker.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

class IntegrationReader implements SubprocessOutputReader {
  constructor(private readonly bytes: () => Buffer, private readonly cap: number) {}
  readFrom(fromByte: number) { const whole = this.bytes(); const retained = whole.subarray(Math.max(0, whole.length - this.cap)); return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length } }
}

class IntegrationHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly pid: number
  readonly collected
  readonly done: Promise<SubprocessOutcome>
  private exited = false
  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], outCap: number, errCap: number) {
    this.pid = child.pid ?? -1
    this.collected = { stdout: new IntegrationReader(() => Buffer.concat(stdout), outCap), stderr: new IntegrationReader(() => Buffer.concat(stderr), errCap) }
    this.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { this.exited = true; resolve({ exitCode, signal }) }) })
  }
  terminate(): void { if (!this.exited && this.pid > 0) try { process.kill(-this.pid, 'SIGTERM') } catch {} }
  async waitForExit(): Promise<boolean> { await this.done; return true }
}

interface EvaluationStep { stdout?: string; stderr?: string; exitCode?: number; signal?: NodeJS.Signals; hang?: boolean; edit?: (cwd: string) => void }
class ControllerSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  evaluatorSpawns = 0
  constructor(private readonly evaluations: EvaluationStep[], private readonly onEvaluatorSpawn?: () => void) {}
  async resolveExecutable(command: string): Promise<string> { return command === 'git' ? execFileSync('which', ['git']).toString().trim() : command }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    if (spec.argv[0] === 'fake-evaluator') {
      this.onEvaluatorSpawn?.()
      const step = this.evaluations[this.evaluatorSpawns++] ?? { stdout: '{"score":999}\n' }
      step.edit?.(spec.cwd)
      const script = step.hang ? 'setInterval(() => {}, 1000)' : step.signal ? `process.kill(process.pid, ${JSON.stringify(step.signal)})` : `process.stdout.write(${JSON.stringify(step.stdout ?? '')});process.stderr.write(${JSON.stringify(step.stderr ?? '')});process.exit(${step.exitCode ?? 0})`
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      const child = spawn(process.execPath, ['-e', script], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      const handle = new IntegrationHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
      spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
    }
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: [typeof spec.stdio.stdin === 'object' ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const handle = new IntegrationHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
    spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
  }
}

interface ControllerFixture { root: string; ctx: Context; parent: Agent; subprocess: ControllerSubprocess; creates: CreateAgentOptions[]; order: string[]; trackerPath: () => string; liveCount: () => number }
interface ProposalLifecycle { afterReport?: (worktree: string) => Promise<void> | void; dispose?: () => Promise<void> | void }
function controllerFixture(evaluations: EvaluationStep[], edits: Array<(worktree: string, ordinal: number) => void> = [], lifecycle: ProposalLifecycle = {}): ControllerFixture {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-controller-e2e-'))
  execFileSync('git', ['init', '-b', 'main', root]); execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'code.ts'), 'export const n = 1\n'); writeFileSync(join(root, 'evaluate.mjs'), '// frozen evaluator identity\n')
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  const creates: CreateAgentOptions[] = []; const order: string[] = []; const subprocess = new ControllerSubprocess(evaluations, () => order.push('evaluator-spawn')); const live = new Map<string, Agent>(); let lastTracker = ''
  const parentCtx = { get(name: string) { if (name === 'agentPresets') return { composedPreset: () => 'preset' }; if (name === 'sandboxPolicy') return { overrideOf: () => 'workspace-write' }; if (name === 'approval') return {}; return undefined }, effect(execute: () => () => Promise<void>) { const cleanup = execute(); let released = false; return async () => { if (!released) { released = true; await cleanup() } } } } as unknown as Context
  const parentAgent = { id: SessionId('parent'), options: { provider: 'provider', model: 'model', maxTokens: 123 }, session: { header: { id: SessionId('parent-session'), cwd: root, delegationDepth: 0 }, append: vi.fn() }, ctx: parentCtx } as unknown as Agent
  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      creates.push(options); order.push(`child-${creates.length}-create`); const tools = new Map<string, ToolDefinition>(); const listeners: Array<(execution: { name: string }, result: Readonly<ToolExecutionResult>) => void> = []
      const childCtx = { agent: undefined as Agent | undefined, get: (name: string) => name === 'agentPresets' ? { composeFrom: vi.fn() } : undefined, tools: { restrict: () => () => undefined, presentAs: () => () => undefined, register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => undefined }, guard: () => () => undefined }, systemPrompt: { context: () => () => undefined, section: () => () => undefined }, on: (name: string, listener: (execution: { name: string }, result: Readonly<ToolExecutionResult>) => void) => { if (name === 'tools/result') listeners.push(listener); return () => undefined } } as unknown as Context
      let prompt = ''; const child = { id: options.sessionId, options: options.agentOptions ?? {}, session: { header: { id: options.sessionId, ...options.meta }, append: vi.fn() }, ctx: childCtx, status: 'idle', cancel: vi.fn(), followup(message: { content: Array<{ text?: string }> }) { prompt = message.content[0]?.text ?? '' }, async whenIdle() { const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { identity: { runId: string; experimentId: string; ordinal: number; nonce: string }; workspace: { worktree: string } }; edits[payload.identity.ordinal - 1]?.(payload.workspace.worktree, payload.identity.ordinal); const tool = tools.get('autoresearch_report')!; const value = await tool.execute({ ...payload.identity, hypothesis: 'candidate', intendedEdits: ['src/code.ts'], implementationSummary: 'changed', blockerClaim: 'child cannot authorize this blocker' }, { concludeTurn: vi.fn() } as never); listeners.forEach(listener => listener({ name: 'autoresearch_report' }, { isError: false, value } as ToolExecutionResult)); await lifecycle.afterReport?.(payload.workspace.worktree) } } as unknown as Agent
      childCtx.agent = child; await options.setup?.(childCtx); live.set(String(options.sessionId), child)
      return { agent: child, dispose: async () => { order.push(`child-${creates.length}-dispose-start`); await lifecycle.dispose?.(); live.delete(String(options.sessionId)); order.push(`child-${creates.length}-dispose-end`) } }
    }, get(id: SessionId) { return live.get(String(id)) },
  }
  const ctx = Object.assign(parentCtx as unknown as Record<string, unknown>, { subprocess, agents, jobs: { list: () => [] as JobSnapshot[] } }) as unknown as Context
  parentAgent.ctx = ctx
  return { root, ctx, parent: parentAgent, subprocess, creates, order, trackerPath: () => lastTracker, liveCount: () => live.size }
}

async function runControllerCase(f: ControllerFixture, overrides: Partial<typeof input> = {}) {
  const controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false }), input: { ...input, repository: f.root, evaluation: { command: 'fake-evaluator', args: [] }, mutable_globs: ['src/**'], ...overrides }, parent: f.parent, signal: new AbortController().signal })
  const result = await controller.run(); const ready = await controller.ready; return { result, ready, tracker: DurableTracker.open(ready.tracker) }
}

describe('controller real Git/SQLite outcomes', () => {
  it.each([
    ['minimize', 5, 5, 'target-reached'],
    ['maximize', 5, 5, 'target-reached'],
  ] as const)('short-circuits a %s baseline target with artifacts, no child, and zero candidate budget', async (direction, metric, target, status) => {
    const f = controllerFixture([{ stdout: `{"score":${metric}}\n` }])
    try { const { result, tracker } = await runControllerCase(f, { metric_direction: direction, target, max_experiments: 1 }); expect(result).toMatchObject({ status, best: { metric }, counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } }); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['minimize', 10, 9, 'accepted'], ['maximize', 10, 11, 'accepted'],
    ['minimize', 10, 10, 'rejected'], ['maximize', 10, 10, 'rejected'],
    ['minimize', 10, 11, 'rejected'], ['maximize', 10, 9, 'rejected'],
  ] as const)('applies strict %s decision for baseline %s candidate %s as %s', async (direction, baseline, candidate, state) => {
    const assertCandidateHead = (cwd: string) => { expect(execFileSync('git', ['-C', cwd, 'show', '-s', '--format=%s', 'HEAD']).toString().trim()).toMatch(/^autoresearch candidate /u); expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1']).toString()).toBe('') }
    const f = controllerFixture([{ stdout: `{"score":${baseline}}\n` }, { stdout: `{"score":${candidate}}\n`, edit: assertCandidateHead }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${candidate}\n`)])
    try { const { result, tracker } = await runControllerCase(f, { metric_direction: direction, max_experiments: 1 }); expect(result.status).toBe('budget-limited'); const row = tracker.database.prepare("SELECT state, decision, metric, candidate_commit FROM experiments WHERE kind = 'candidate'").get()!; expect(row).toMatchObject({ state, decision: state === 'accepted' ? 'accept' : 'reject', metric: candidate }); expect(String(row['candidate_commit'])).toMatch(/^[0-9a-f]{40}$/); expect(f.creates).toHaveLength(1); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('persists a terminal experiment and artifacts before the next child and releases only after terminal run persistence', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }, { stdout: '{"score":8}\n' }], [(worktree, ordinal) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${ordinal + 1}\n`), (worktree, ordinal) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${ordinal + 1}\n`)])
    try { const { result, tracker } = await runControllerCase(f, { max_experiments: 2 }); expect(result).toMatchObject({ status: 'budget-limited', counts: { experimentsStarted: 2, experimentsCompleted: 2, attempts: 3 } }); const experiments = tracker.database.prepare("SELECT state FROM experiments WHERE kind='candidate' ORDER BY ordinal").all(); expect(experiments).toEqual([{ state: 'accepted' }, { state: 'accepted' }]); expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull(); expect(f.order.filter(item => item.includes('child'))).toEqual(['child-1-create', 'child-1-dispose-start', 'child-1-dispose-end', 'child-2-create', 'child-2-dispose-start', 'child-2-dispose-end']); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('durably retains the terminal lock when proposal disposal leaves child ownership uncertain', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [], { dispose: async () => { throw new Error('child disposal failed') } })
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result.status).toBe('blocked')
      expect(tracker.getRun(result.runId)).toMatchObject({ state: 'blocked', terminal_quiescent: 0 })
      expect(tracker.recoveryState(result.runId)).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('awaits proposal disposal once on controller failure and leaves no registration or job', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [(worktree) => writeFileSync(join(worktree, 'package.json'), '{}\n')])
    try {
      const { result, tracker } = await runControllerCase(f, { mutable_globs: ['**'], max_experiments: 1 })
      expect(result.status).toBe('round-failed')
      expect(f.order.filter(item => item.includes('dispose'))).toEqual(['child-1-dispose-start', 'child-1-dispose-end'])
      expect(f.liveCount()).toBe(0)
      expect(f.ctx.jobs.list()).toEqual([])
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('does not spawn an evaluator until a child-owned late mutation and proposal disposal are quiescent', async () => {
    let lateMutation: Promise<void> | undefined
    const f = controllerFixture(
      [{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }],
      [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')],
      {
        afterReport(worktree) {
          const mutation = Promise.withResolvers<void>()
          lateMutation = mutation.promise
          setTimeout(() => { writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 3\n'); f.order.push('late-mutation'); mutation.resolve() }, 20)
        },
        async dispose() { await lateMutation },
      },
    )
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result.status).toBe('budget-limited')
      const disposalEnd = f.order.indexOf('child-1-dispose-end')
      expect(f.order.indexOf('late-mutation')).toBeGreaterThan(f.order.indexOf('child-1-dispose-start'))
      expect(disposalEnd).toBeLessThan(f.order.lastIndexOf('evaluator-spawn'))
      expect(f.liveCount()).toBe(0)
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).not.toBeNull()
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([{ stdout: '', exitCode: 9 }, { stdout: '{"score":1}\n', stderr: 'failure', exitCode: 7 }, { stdout: 'not-json\n' }])('classifies baseline evaluator failure with only canonical durable artifacts and no child', async step => {
    const f = controllerFixture([step])
    try {
      const { result, tracker } = await runControllerCase(f); expect(result.status).toBe('baseline-blocked'); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT state FROM experiments').get()?.['state']).toBe('crashed')
      // decodeRunResult has already validated this discriminated baseline-blocked result.
      const terminal = result as { artifacts: Array<{ artifactId: string; kind: string }>; exit: { stdout: { artifactId: string }; stderr: { artifactId: string } } }
      const refs = terminal.artifacts
      expect(refs.map(item => item.kind).sort()).toEqual(['stderr', 'stdout']); expect(new Set(refs.map(item => item.artifactId)).size).toBe(2); expect(refs).toContainEqual(expect.objectContaining(terminal.exit.stdout)); expect(refs).toContainEqual(expect.objectContaining(terminal.exit.stderr)); expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2); tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('revalidates terminal baseline artifacts before cancellation can release the lock', async () => {
    const f = controllerFixture([{ stdout: '', exitCode: 9 }])
    const transitionRun = DurableTracker.prototype.transitionRun
    let controller!: AutoresearchRunController
    let observedTerminalBaseline = false
    const transitionSpy = vi.spyOn(DurableTracker.prototype, 'transitionRun').mockImplementation(function (runId, to, facts, at) {
      const transitionId = transitionRun.call(this, runId, to, facts, at)
      if (to === 'baseline-blocked') {
        observedTerminalBaseline = true
        const artifact = this.database.prepare("SELECT run_id, experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ? AND kind = 'stdout'").get(runId)!
        unlinkSync(join(this.layout.root, 'artifacts', String(artifact['run_id']), String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`))
        controller.cancel('operator stop after terminal persistence')
      }
      return transitionId
    })
    try {
      controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false }), input: { ...input, repository: f.root, evaluation: { command: 'fake-evaluator', args: [] }, mutable_globs: ['src/**'] }, parent: f.parent, signal: new AbortController().signal })
      const result = await controller.run()
      const ready = await controller.ready
      const tracker = DurableTracker.open(ready.tracker)
      expect(observedTerminalBaseline).toBe(true)
      expect(result).toMatchObject({ status: 'round-failed', evidence: [{ code: 'artifact-incomplete' }] })
      expect(tracker.getRun(result.runId)).toMatchObject({ state: 'baseline-blocked' })
      expect(tracker.database.prepare('SELECT released_at FROM active_locks').get()?.['released_at']).toBeNull()
      tracker.close()
    } finally {
      transitionSpy.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('persists baseline signal artifacts with zero child allocation and zero candidate budget', async () => {
    const f = controllerFixture([{ signal: 'SIGTERM', stdout: 'partial', stderr: 'terminated' }])
    try {
      const { result, tracker } = await runControllerCase(f, { max_experiments: 1 })
      expect(result).toMatchObject({ status: 'baseline-blocked', counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } })
      expect(f.creates).toHaveLength(0)
      expect(tracker.database.prepare('SELECT state, signal FROM experiments').get()).toMatchObject({ state: 'crashed', signal: 'SIGTERM' })
      expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })


  it('classifies a real evaluator timeout, awaits process-tree exit, retains artifacts, and spawns no child', async () => {
    const f = controllerFixture([{ hang: true }])
    try { const { result, tracker } = await runControllerCase(f, { timeout_ms: 25 }); expect(result.status).toBe('baseline-blocked'); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT state FROM experiments').get()?.['state']).toBe('timed-out'); expect(tracker.database.prepare('SELECT timed_out, process_tree_quiescent FROM attempts').get()).toEqual({ timed_out: 1, process_tree_quiescent: 1 }); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('treats forbidden child edits as a host policy failure while a child blocker claim remains non-authoritative', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [(worktree) => writeFileSync(join(worktree, 'package.json'), '{}\n')])
    try { const { result, tracker } = await runControllerCase(f, { mutable_globs: ['**'], max_experiments: 1 }); expect(result).toMatchObject({ status: 'round-failed' }); expect(String((result as { reason: string }).reason)).toMatch(/forbidden|protected|policy/iu); expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE kind='candidate'").get()?.['n']).toBe(0); const outcomes = tracker.listTransitions(String((result as { runId: string }).runId)).map(row => String(row['outcome_json'])); expect(outcomes.some(value => value.includes('child-blocker-claim') && value.includes('false'))).toBe(true); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
