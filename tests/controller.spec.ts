import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { resolveConfig, type Config } from '../src/config.ts'
import { AutoresearchRunController, type AutoresearchRunReady } from '../src/controller.ts'
import { currentControllerProcessIdentity, GitBoundaryError } from '../src/git.ts'

import { DurableTracker } from '../src/tracker.ts'
import { sweepRepositoryRetention } from '../src/retention.ts'
import { evaluatorEvaluationSha256, freezeEvaluatorProvenanceFromManifest } from '../src/evaluator.ts'
import { EVALUATOR_CONTRACT_GENERATION } from '../src/types.ts'
const evaluatorRegistration = { id: 'judge', command: 'fake-evaluator', args: [], metricName: 'score', metricDirection: 'minimize' as const, metricParserVersion: 'final-line-json-v1' as const, evaluatorFiles: ['evaluate.mjs'] }
const input = {
  repository: '.', run_tag: 'controller-test', evaluator_id: 'judge', objective: 'improve score', mutable_globs: ['src/**'],
  max_experiments: 2, mode: 'foreground' as const,
}
const controllerConfig = () => resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] })

function parent(): Agent {
  return { id: 'parent', session: { header: { id: 'session', cwd: process.cwd() } } } as unknown as Agent
}

describe('exclusive autoresearch controller contract', () => {
  it('performs no repository, tracker, child, or evaluator effect during construction', () => {
    const ctx = new Proxy({}, { get: vi.fn(() => { throw new Error('constructor touched runtime service') }) }) as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    expect(controller.ready).toBeInstanceOf(Promise)
  })

  it('memoizes the single state-machine execution', async () => {
    const resolveExecutable = vi.fn(async () => { throw new Error('discovery stopped') })
    const ctx = { subprocess: { resolveExecutable } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    const first = controller.run()
    const second = controller.run()
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('discovery stopped')
    await expect(controller.ready).rejects.toThrow('discovery stopped')
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown evaluator id before Git discovery or any mutation', async () => {
    const resolveExecutable = vi.fn()
    const ctx = { subprocess: { resolveExecutable }, agents: { create: vi.fn() } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, evaluator_id: 'unknown' }, parent: parent(), signal: new AbortController().signal })
    await expect(controller.run()).rejects.toThrow('unknown evaluator registration id "unknown"')
    expect(resolveExecutable).not.toHaveBeenCalled()
  })

  it('promptly aborts cancellation while pre-tracker executable discovery is held open', async () => {
    let entered!: () => void
    const discoveryEntered = new Promise<void>(resolve => { entered = resolve })
    const create = vi.fn()
    const resolveExecutable = vi.fn((_command: string, _env: unknown, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      entered()
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const ctx = { subprocess: { resolveExecutable }, agents: { create } } as unknown as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
    const running = controller.run()
    await discoveryEntered
    controller.cancel('operator stop')
    await expect(running).rejects.toThrow('operator stop')
    await expect(controller.ready).rejects.toThrow('operator stop')
    await controller.dispose()
    expect(create).not.toHaveBeenCalled()
  })

  it('makes cancellation idempotent before initialization and never allocates a child', async () => {
    const resolveExecutable = vi.fn(async () => '/usr/bin/git')
    const create = vi.fn()
    const ctx = { subprocess: { resolveExecutable }, agents: { create } } as unknown as Context
    const signal = new AbortController()
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: signal.signal })
    controller.cancel('operator stop')
    controller.cancel('later reason must not replace the first')
    await expect(controller.run()).rejects.toThrow()
    await expect(controller.ready).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('disposal before run is quiescent and does not touch runtime services', async () => {
    const touched = vi.fn()
    const ctx = new Proxy({}, { get: () => { touched(); return undefined } }) as Context
    const controller = new AutoresearchRunController(ctx, { config: controllerConfig(), input, parent: parent(), signal: new AbortController().signal })
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

async function runControllerCase(f: ControllerFixture, overrides: Partial<typeof input> & Record<string, unknown> = {}, configOverrides: Config = {}) {
  const controller = createCaseController(f, overrides, undefined, configOverrides)
  const result = await controller.run(); const ready = await controller.ready; return { result, ready, tracker: DurableTracker.open(ready.tracker) }
}

function createCaseController(f: ControllerFixture, overrides: Partial<typeof input> & Record<string, unknown> = {}, resumeRunId?: string, configOverrides: Config = {}) {
  const { run_tag: _runTag, evaluator_id: _evaluatorId, ...baseInput } = input
  const { metric_direction: hostDirection, ...toolOverrides } = overrides
  const identity = resumeRunId ? { resume_run_id: resumeRunId } : { run_tag: input.run_tag, evaluator_id: input.evaluator_id }
  const registration = { ...evaluatorRegistration, metricDirection: hostDirection === 'maximize' ? 'maximize' as const : 'minimize' as const }
  return new AutoresearchRunController(f.ctx, {
    config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [registration], ...configOverrides }),
    input: { ...baseInput, ...identity, repository: f.root, mutable_globs: ['src/**'], ...toolOverrides } as never,
    parent: f.parent,
    signal: new AbortController().signal,
  })
}

function candidateAuditCommits(root: string, runId: string): string[] {
  return execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(objectname)', `refs/autoresearch/runs/${runId}/candidates/`]).toString().trim().split('\n').filter(Boolean)
}

function seedImmutableEvidence(database: DatabaseSync, triggerNames: readonly string[], mutation: () => void): void {
  const triggers = triggerNames.map(name => {
    const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.['sql']
    if (typeof sql !== 'string') throw new Error(`canonical trigger ${name} is missing`)
    return { name, sql }
  })
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`)
    mutation()
    for (const trigger of triggers) database.exec(trigger.sql)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function controllerClaims(gitCommonDir: string, runId: string): unknown[] {
  const authority = new DatabaseSync(join(gitCommonDir, 'dsh-autoresearch-locks.sqlite'), { readOnly: true })
  try { return authority.prepare('SELECT * FROM controller_claims WHERE run_id = ? ORDER BY owner_id').all(runId) }
  finally { authority.close() }
}

describe('controller real Git/SQLite outcomes', () => {
  it('activates Host registration authority and atomically persists its identity', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const controller = createCaseController(f)
    try {
      const ready = await controller.prepare()
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare('SELECT contract_generation, evaluator_id FROM run_registrations WHERE run_id = ?').get(ready.runId)).toEqual({ contract_generation: EVALUATOR_CONTRACT_GENERATION, evaluator_id: 'judge' })
      expect(String(tracker.getRun(ready.runId)?.['policy_json'])).toContain('fake-evaluator')
      tracker.close()
    } finally {
      await controller.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('blocks terminal resume on corrupt durable registration before spawn or mutation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      seedImmutableEvidence(first.tracker.database, ['run_registrations_immutable'], () => {
        first.tracker.database.prepare('UPDATE run_registrations SET registration_json = ? WHERE run_id = ?').run('{malformed', first.ready.runId)
      })
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      first.tracker.close()
      const resumed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()
      expect(resumed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'registration-corrupt' })] })
      const tracker = DurableTracker.open(first.ready.tracker)
      expect(tracker.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('blocks nonterminal resume when the current Host registration changed or was removed', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = createCaseController(f, { max_experiments: 1, target: 1 })
      const ready = await first.prepare()
      await first.dispose()
      const seeded = DurableTracker.open(ready.tracker)
      expect(seeded.getRun(ready.runId)?.['state']).toBe('initializing')
      const transitionCount = seeded.listTransitions(ready.runId).length
      seeded.close()
      const changed = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [{ ...evaluatorRegistration, args: ['changed'] }] }).run()
      expect(changed).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      const removed = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [] }).run()
      expect(removed).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      const evaluatorPathDrift = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [{ ...evaluatorRegistration, evaluatorFiles: ['evaluate.mjs', 'other.mjs'] }] }).run()
      expect(evaluatorPathDrift).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      const datasetPathDrift = await createCaseController(f, {}, ready.runId, { evaluatorRegistrations: [{ ...evaluatorRegistration, dataset: { kind: 'local', files: ['dataset.json'] } }] }).run()
      expect(datasetPathDrift).toMatchObject({ status: 'round-failed', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.listTransitions(ready.runId)).toHaveLength(transitionCount)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('requires the exact current Host registration before registered terminal replay', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      first.tracker.close()
      const exact = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()
      const changed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId, { evaluatorRegistrations: [{ ...evaluatorRegistration, args: ['changed'] }] }).run()
      const removed = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(exact).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      expect(changed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      expect(removed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'evaluator-registration-mismatch' })] })
      const tracker = DurableTracker.open(first.ready.tracker)
      expect(tracker.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each(['nonterminal', 'terminal'] as const)('rejects semantically drifted canonical provenance before writable %s resume', async (kind) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      let ready: AutoresearchRunReady
      if (kind === 'terminal') { const completed = await runControllerCase(f, { max_experiments: 1, target: 1 }); ready = completed.ready; completed.tracker.close() }
      else { const controller = createCaseController(f, { max_experiments: 1, target: 1 }); ready = await controller.prepare(); await controller.dispose() }
      const tracker = DurableTracker.open(ready.tracker)
      const row = tracker.getRun(ready.runId)!
      const wrapper = JSON.parse(String(row['provenance_json'])) as { canonical: string; sha256: string }
      const semantic = JSON.parse(wrapper.canonical) as Record<string, unknown>
      semantic.metricName = 'tampered-score'
      wrapper.canonical = JSON.stringify(semantic)
      wrapper.sha256 = createHash('sha256').update(wrapper.canonical).digest('hex')
      seedImmutableEvidence(tracker.database, ['runs_immutable_identity'], () => {
        tracker.database.prepare('UPDATE runs SET provenance_json = ?, provenance_sha256 = ? WHERE run_id = ?').run(JSON.stringify(wrapper), wrapper.sha256, ready.runId)
      })
      const versionBefore = tracker.schemaVersion()
      const schemaBefore = tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      const claimsBefore = controllerClaims(String(row['git_common_dir']), ready.runId)
      const transitionCount = tracker.listTransitions(ready.runId).length
      tracker.close()
      const bytesBefore = readFileSync(ready.tracker)
      const walBefore = existsSync(`${ready.tracker}-wal`) ? readFileSync(`${ready.tracker}-wal`) : null
      const sidecarExistenceBefore = [`${ready.tracker}-wal`, `${ready.tracker}-shm`].map(existsSync)
      const resumed = await createCaseController(f, { max_experiments: 1, target: 1 }, ready.runId).run()
      expect(resumed).toMatchObject({ evidence: [expect.objectContaining({ code: 'provenance-mismatch' })] })
      expect(readFileSync(ready.tracker)).toEqual(bytesBefore)
      expect(existsSync(`${ready.tracker}-wal`) ? readFileSync(`${ready.tracker}-wal`) : null).toEqual(walBefore)
      expect([`${ready.tracker}-wal`, `${ready.tracker}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(ready.tracker)
      expect(inspection.schemaVersion()).toBe(versionBefore)
      expect(inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore)
      expect(inspection.listTransitions(ready.runId)).toHaveLength(transitionCount)
      inspection.close()
      expect(controllerClaims(String(row['git_common_dir']), ready.runId)).toEqual(claimsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(kind === 'terminal' ? 1 : 0)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([
    ['missing', "DELETE FROM run_registrations"],
    ['corrupt', "UPDATE run_registrations SET registration_json = '{'"],
    ['changed', "UPDATE run_registrations SET evaluator_id = 'other'"],
  ] as const)('blocks a %s current-contract registration without changing main/WAL bytes, schema version, or sidecar existence', async (_kind, mutation) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const trackerPath = first.ready.tracker
      const durableRun = first.tracker.getRun(first.ready.runId)!
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const evaluatorSpawns = f.subprocess.evaluatorSpawns
      const claimsBefore = controllerClaims(String(durableRun['git_common_dir']), first.ready.runId)
      seedImmutableEvidence(first.tracker.database, ['run_registrations_presence_monotonic', 'run_registrations_immutable'], () => {
        first.tracker.database.exec(mutation)
      })
      const versionBefore = first.tracker.schemaVersion()
      const schemaBefore = first.tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      first.tracker.close()
      const bytesBefore = readFileSync(trackerPath)
      const walBefore = existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null
      const sidecarExistenceBefore = [`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)
      const resumed = await createCaseController(f, {}, first.ready.runId).run()
      expect(resumed).toMatchObject({ evidence: [expect.objectContaining({ code: 'registration-corrupt' })] })
      expect(readFileSync(trackerPath)).toEqual(bytesBefore)
      expect(existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null).toEqual(walBefore)
      expect([`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(trackerPath)
      expect(inspection.schemaVersion()).toBe(versionBefore)
      expect(inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore)
      expect(inspection.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      inspection.close()
      expect(controllerClaims(String(durableRun['git_common_dir']), first.ready.runId)).toEqual(claimsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(evaluatorSpawns)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('blocks a current-contract terminal tracker missing registration even when its schema is labeled v6', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
      `)
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()

      expect(() => sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }))).toThrow(/current evaluator-contract run is missing its durable registration/)
      const inspection = DurableTracker.openReadOnly(first.ready.tracker)
      expect(inspection.schemaVersion()).toBe(6)
      inspection.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('migrates a supported v7 registered terminal tracker before canonical resume revalidation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        UPDATE schema_metadata SET version = 7 WHERE singleton = 1;
      `)
      first.tracker.close()

      const replay = await createCaseController(f, { max_experiments: 1, target: 1 }, first.ready.runId).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(8)
      expect(migrated.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'run_registrations_presence_monotonic'").get()).toEqual({ name: 'run_registrations_presence_monotonic' })
      migrated.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['registered-v7', 'legacy-v6'] as const)('migrates a supported older %s terminal tracker before retention identity revalidation', async (kind) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.prepare("UPDATE artifacts SET created_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?").run(first.ready.runId)
      if (kind === 'registered-v7') {
        first.tracker.database.exec(`
          DROP TRIGGER run_registrations_presence_monotonic;
          UPDATE schema_metadata SET version = 7 WHERE singleton = 1;
        `)
      } else {
        first.tracker.database.exec(`
          DROP TRIGGER run_registrations_presence_monotonic;
          DROP TRIGGER run_registrations_immutable;
          DROP TABLE run_registrations;
          UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
          UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
        `)
      }
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()

      const summary = sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }), undefined, new Date('2030-01-01T00:00:00.000Z'))
      expect(summary.artifactsPruned).toBe(2)
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(8)
      expect(migrated.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'pruned' }])
      migrated.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each([1, 2] as const)('starts a new run after sweeping a canonical v%s terminal tracker', async (version) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }, { stdout: '{"score":2}\n' }])
    try {
      const first = await runControllerCase(f, { run_tag: `legacy-v${version}`, max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        DROP TRIGGER attempts_immutable_outcome;
        ALTER TABLE attempts DROP COLUMN outcome_json;
        DROP TABLE schema_metadata;
        CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
        INSERT INTO schema_metadata VALUES (1, ${version}, 'legacy');
        DROP TRIGGER experiments_immutable_lineage;
        CREATE TRIGGER experiments_immutable_lineage BEFORE UPDATE OF run_id, ordinal, kind, parent_commit, candidate_commit, command, args_json, cwd ON experiments BEGIN SELECT RAISE(ABORT, 'immutable experiment lineage/evaluator'); END;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      if (version === 1) {
        first.tracker.database.exec(`
          DROP TRIGGER runs_immutable_identity;
          DROP TRIGGER experiments_immutable_lineage;
          DROP TRIGGER attempts_immutable_intent;
          ALTER TABLE runs DROP COLUMN terminal_quiescent;
        `)
      }
      first.tracker.close()

      const second = await runControllerCase(f, { run_tag: `after-v${version}`, max_experiments: 1, target: 2 })
      expect(second.result).toMatchObject({ status: 'target-reached', best: { metric: 2 } })
      second.tracker.close()
      const migrated = DurableTracker.openReadOnly(first.ready.tracker)
      expect(migrated.schemaVersion()).toBe(8)
      migrated.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })


  it('replays a legacy terminal result canonically without mutation, ownership, cleanup, or spawn', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 }, { evaluatorRegistrations: [{ ...evaluatorRegistration, environment: { TOKEN: 'non-empty-secret' } }] })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare('UPDATE active_locks SET released_at = NULL WHERE run_id = ?').run(first.ready.runId)
      const durableRun = first.tracker.getRun(first.ready.runId)!
      const authority = new DatabaseSync(join(String(durableRun['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(durableRun['repository_id'], durableRun['run_tag'], first.ready.runId, '2026-01-01T00:00:00.000Z')
      authority.prepare('INSERT INTO controller_claims (run_id, owner_id, owner_pid, owner_start_token, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(first.ready.runId, 'legacy-owner', null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      const sharedAuthorityBefore = { lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId), claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId) }
      authority.close()
      const transitionCount = first.tracker.listTransitions(first.ready.runId).length
      const artifactsBefore = first.tracker.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId)
      first.tracker.close()
      expect(JSON.parse(String(durableRun['policy_json'])).environment).toEqual({ TOKEN: { sha256: createHash('sha256').update('non-empty-secret').digest('hex') } })
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const tracker = DurableTracker.openReadOnly(first.ready.tracker)
      expect(tracker.listTransitions(first.ready.runId)).toHaveLength(transitionCount)
      expect(tracker.database.prepare('SELECT released_at FROM active_locks WHERE run_id = ?').get(first.ready.runId)).toEqual({ released_at: null })
      const replayAuthority = new DatabaseSync(join(String(durableRun['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      expect({ lock: replayAuthority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId), claim: replayAuthority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId) }).toEqual(sharedAuthorityBefore)
      replayAuthority.close()
      expect(tracker.database.prepare('SELECT artifact_id, retention FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId)).toEqual(artifactsBefore)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      expect(f.creates).toHaveLength(0)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('replays a registered terminal result without pruning under a live controller claim, then takes over a stale claim', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
      first.tracker.database.prepare('UPDATE artifacts SET created_at = ? WHERE run_id = ?').run(old, first.ready.runId)
      const run = first.tracker.getRun(first.ready.runId)!
      const authority = new DatabaseSync(join(String(run['git_common_dir']), 'dsh-autoresearch-locks.sqlite'))
      const live = currentControllerProcessIdentity()
      authority.prepare('INSERT INTO controller_claims (run_id, owner_id, owner_pid, owner_start_token, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(first.ready.runId, 'live-owner', live.pid, live.startToken ?? null, old, old, old)
      authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(run['repository_id'], run['run_tag'], first.ready.runId, old)
      const liveAuthority = {
        lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId),
      }
      first.tracker.close()

      const replay = await createCaseController(f, {}, first.ready.runId, { artifactRetentionDays: 1 }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const retained = DurableTracker.openReadOnly(first.ready.tracker)
      expect(retained.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'retain' }])
      expect({
        lock: authority.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        claim: authority.prepare('SELECT * FROM controller_claims WHERE run_id = ?').get(first.ready.runId),
      }).toEqual(liveAuthority)
      retained.close()

      authority.prepare('UPDATE controller_claims SET owner_start_token = ? WHERE run_id = ?').run(live.startToken === undefined ? 'provably-stale' : `${BigInt(live.startToken) + 1n}`, first.ready.runId)
      const staleReplay = await createCaseController(f, {}, first.ready.runId, { artifactRetentionDays: 1 }).run()
      expect(staleReplay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
      const pruned = DurableTracker.openReadOnly(first.ready.tracker)
      expect(pruned.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'pruned' }])
      expect(authority.prepare('SELECT owner_id FROM controller_claims WHERE run_id = ?').get(first.ready.runId)).toBeUndefined()
      expect(authority.prepare('SELECT 1 FROM active_locks WHERE run_id = ?').get(first.ready.runId)).toBeUndefined()
      pruned.close()
      authority.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it.each(['missing', 'corrupt'] as const)('typed-blocks legacy terminal replay with %s retained artifact bytes without mutating durable state', async (fault) => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      const artifact = first.tracker.database.prepare("SELECT experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ? AND retention = 'retain' ORDER BY kind LIMIT 1").get(first.ready.runId)!
      const artifactPath = join(first.tracker.layout.root, 'artifacts', first.ready.runId, String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`)
      first.tracker.close()
      if (fault === 'missing') unlinkSync(artifactPath)
      else writeFileSync(artifactPath, 'tampered')
      const before = readFileSync(first.ready.tracker)
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'blocked', evidence: [{ code: 'artifact-incomplete' }] })
      expect(readFileSync(first.ready.tracker)).toEqual(before)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('allows legacy terminal replay after artifact metadata is durably pruned', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare("UPDATE artifacts SET retention = 'pruned' WHERE run_id = ?").run(first.ready.runId)
      const files = first.tracker.database.prepare('SELECT experiment_id, attempt_id, kind FROM artifacts WHERE run_id = ?').all(first.ready.runId)
      for (const artifact of files) unlinkSync(join(first.tracker.layout.root, 'artifacts', first.ready.runId, String(artifact['experiment_id']), String(artifact['attempt_id']), `${String(artifact['kind'])}.log`))
      first.tracker.close()
      const replay = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(replay).toMatchObject({ status: 'target-reached', counts: { attempts: 1 } })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('rejects a legacy terminal tracker replacement between read-only retention classification and writable claim', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const originalOpen = DurableTracker.open.bind(DurableTracker)
    let openSpy: MockInstance | undefined
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const registrationTriggers = first.tracker.database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name IN ('run_registrations_presence_monotonic', 'run_registrations_immutable') ORDER BY name").all().map(row => String(row['sql']))
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DELETE FROM run_registrations;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
        UPDATE artifacts SET created_at = '2020-01-01T00:00:00.000Z';
      `)
      first.tracker.database.exec(registrationTriggers.join(';'))
      const run = first.tracker.getRun(first.ready.runId)!
      first.tracker.close()
      openSpy = vi.spyOn(DurableTracker, 'open').mockImplementationOnce((path: string) => {
        const tracker = originalOpen(path)
        tracker.database.prepare("UPDATE runs SET updated_at = '2030-01-01T00:00:00.000Z' WHERE run_id = ?").run(first.ready.runId)
        return tracker
      })
      expect(() => sweepRepositoryRetention(String(run['git_common_dir']), '.autoresearch-test', resolveConfig({ artifactRetentionDays: 1, evaluatorRegistrations: [evaluatorRegistration] }), undefined, new Date('2026-01-01T00:00:00.000Z'))).toThrow(/changed between read-only retention classification and writable open/)
      openSpy.mockRestore(); openSpy = undefined
      const inspection = DurableTracker.openReadOnly(first.ready.tracker)
      expect(inspection.database.prepare('SELECT DISTINCT retention FROM artifacts WHERE run_id = ?').all(first.ready.runId)).toEqual([{ retention: 'retain' }])
      inspection.close()
    } finally {
      openSpy?.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it('rejects a pre-cutover v6 nonterminal resume without changing schema, main/WAL bytes, state, lock, or sidecar existence', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    try {
      const first = await runControllerCase(f, { max_experiments: 1, target: 1 })
      const trackerPath = first.ready.tracker
      first.tracker.database.exec(`
        DROP TRIGGER run_registrations_presence_monotonic;
        DROP TRIGGER run_registrations_immutable;
        DROP TABLE run_registrations;
        UPDATE schema_metadata SET version = 6 WHERE singleton = 1;
        UPDATE transitions SET intent_json = '{"kind":"create-run"}' WHERE scope = 'run' AND from_state IS NULL AND to_state = 'initializing';
      `)
      first.tracker.database.prepare("UPDATE runs SET state = 'ready', terminal_quiescent = NULL WHERE run_id = ?").run(first.ready.runId)
      first.tracker.database.prepare('UPDATE active_locks SET released_at = NULL WHERE run_id = ?').run(first.ready.runId)
      const exportDirectory = join(trackerPath, '..', 'exports')
      mkdirSync(exportDirectory, { recursive: true })
      const tsvPath = join(exportDirectory, `${first.ready.runId}.tsv`)
      writeFileSync(tsvPath, 'preserve\n')
      const durableBefore = {
        version: first.tracker.schemaVersion(),
        run: first.tracker.getRun(first.ready.runId),
        lock: first.tracker.database.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        schema: first.tracker.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        artifacts: first.tracker.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId),
        tsv: readFileSync(tsvPath),
      }
      first.tracker.close()
      const bytesBefore = readFileSync(trackerPath)
      const walBefore = existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null
      const sidecarExistenceBefore = [`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)
      sweepRepositoryRetention(String(durableBefore.run?.['git_common_dir']), '.autoresearch-test', resolveConfig({ evaluatorRegistrations: [evaluatorRegistration] }))

      const resumed = await createCaseController(f, {}, first.ready.runId, { evaluatorRegistrations: [] }).run()
      expect(resumed).toMatchObject({ status: 'blocked', evidence: [expect.objectContaining({ code: 'legacy-evaluator-policy-unsupported' })] })
      expect(readFileSync(trackerPath)).toEqual(bytesBefore)
      expect(existsSync(`${trackerPath}-wal`) ? readFileSync(`${trackerPath}-wal`) : null).toEqual(walBefore)
      expect([`${trackerPath}-wal`, `${trackerPath}-shm`].map(existsSync)).toEqual(sidecarExistenceBefore)
      const inspection = DurableTracker.openReadOnly(trackerPath)
      expect({
        version: inspection.schemaVersion(),
        run: inspection.getRun(first.ready.runId),
        artifacts: inspection.database.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(first.ready.runId),
        tsv: readFileSync(tsvPath),
        lock: inspection.database.prepare('SELECT * FROM active_locks WHERE run_id = ?').get(first.ready.runId),
        schema: inspection.database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      }).toEqual(durableBefore)
      inspection.close()
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      expect(f.creates).toHaveLength(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['minimize', 5, 5, 'target-reached'],
    ['maximize', 5, 5, 'target-reached'],
  ] as const)('short-circuits a %s baseline target with artifacts, no child, and zero candidate budget', async (direction, metric, target, status) => {
    const f = controllerFixture([{ stdout: `{"score":${metric}}\n` }])
    try { const { result, tracker } = await runControllerCase(f, { metric_direction: direction, target, max_experiments: 1 }); expect(result).toMatchObject({ status, best: { metric }, counts: { experimentsStarted: 0, experimentsCompleted: 0, attempts: 1 } }); expect(f.creates).toHaveLength(0); expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.['n']).toBe(2); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('does not apply the presentation limit to canonical terminal results', async () => {
    const f = controllerFixture([{ stdout: '{"score":5}\n' }])
    try {
      const { result, tracker } = await runControllerCase(f, { target: 5, max_experiments: 1 }, { maxResultChars: 1 })
      expect(result).toMatchObject({ status: 'target-reached', best: { metric: 5 }, artifacts: expect.arrayContaining([expect.objectContaining({ kind: 'stdout' }), expect.objectContaining({ kind: 'stderr' })]) })
      expect(JSON.stringify(result).length).toBeGreaterThan(1)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('resumes across execution modes from another subdirectory after caller HEAD advances', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')])
    try {
      const initial = createCaseController(f, { repository: join(f.root, 'src'), mode: 'background', max_experiments: 1 })
      const first = await initial.run(); const ready = await initial.ready
      const tracker = DurableTracker.open(ready.tracker); const row = tracker.getRun(ready.runId)!
      const startCommit = String(row['start_commit']); const persistedPolicy = JSON.parse(String(row['policy_json'])) as Record<string, unknown>
      const provenanceSha256 = String(row['provenance_sha256'])
      const attemptProvenance = (tracker.database.prepare('SELECT spawn_intent_json FROM attempts ORDER BY ordinal').all() as Array<{ spawn_intent_json: string }>).map(attempt => { const parsed: unknown = JSON.parse(attempt.spawn_intent_json); if (!parsed || typeof parsed !== 'object' || !('provenanceSha256' in parsed)) throw new Error('attempt spawn intent lacks provenanceSha256'); return String(parsed.provenanceSha256) })
      expect(attemptProvenance).toEqual([provenanceSha256, provenanceSha256])
      tracker.close()
      expect(first.status).toBe('budget-limited')
      expect(persistedPolicy).toMatchObject({ repository: f.root, runTag: input.run_tag })
      expect(persistedPolicy).not.toHaveProperty('mode')

      const resumeDirectory = join(f.root, 'resume-cwd'); mkdirSync(resumeDirectory); writeFileSync(join(resumeDirectory, 'caller.txt'), 'caller advancement\n')
      execFileSync('git', ['-C', f.root, 'add', 'resume-cwd/caller.txt']); execFileSync('git', ['-C', f.root, 'commit', '-m', 'advance caller head'])
      expect(execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD']).toString().trim()).not.toBe(startCommit)

      const resumed = await createCaseController(f, { repository: resumeDirectory, mode: 'foreground', max_experiments: 1 }, ready.runId).run()
      expect(resumed).toEqual(first)
      expect(f.subprocess.evaluatorSpawns).toBe(2)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('persists start-commit manifest provenance when the evaluator file changes at registered-run creation', async () => {
    const f = controllerFixture([{ stdout: '{"score":1}\n' }])
    const originalCreate = DurableTracker.prototype.createRegisteredRun
    let registered: { runId: string; tracker: string; worktree: string; evaluator: Buffer } | undefined
    const createSpy = vi.spyOn(DurableTracker.prototype, 'createRegisteredRun').mockImplementation(function (record) {
      const evaluator = join(record.worktree, 'evaluate.mjs')
      registered = { runId: record.runId, tracker: this.path, worktree: record.worktree, evaluator: readFileSync(evaluator) }
      writeFileSync(evaluator, 'concurrent evaluator replacement\n')
      return originalCreate.call(this, record)
    })
    const controller = createCaseController(f, { max_experiments: 1, target: 1 })
    try {
      const [runOutcome, readyOutcome] = await Promise.allSettled([controller.run(), controller.ready])
      for (const outcome of [runOutcome, readyOutcome]) {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'fulfilled') throw new Error('dirty registered run unexpectedly continued')
        expect(outcome.reason).toBeInstanceOf(GitBoundaryError)
        expect(outcome.reason).toMatchObject({ code: 'accepted-reconcile-dirty' })
      }
      expect(f.subprocess.evaluatorSpawns).toBe(0)

      if (!registered) throw new Error('registered run was not captured')
      const tracker = DurableTracker.openReadOnly(registered.tracker)
      const row = tracker.getRun(registered.runId)!
      const registration = tracker.readRegistration(registered.runId)!
      const policy = JSON.parse(String(row['policy_json'])) as { evaluation: { command: string; args: string[]; cwd?: string }; metricName: string; metricDirection: 'minimize' | 'maximize'; environment: Record<string, string> }
      const expected = freezeEvaluatorProvenanceFromManifest({ evaluation: policy.evaluation, evaluatorFiles: registration.registration.evaluatorFiles, environment: policy.environment, metricName: policy.metricName, metricDirection: policy.metricDirection, policy: { normalizedPolicySha256: String(row['policy_sha256']), evaluationSha256: evaluatorEvaluationSha256(policy.evaluation), policy } }, registration.manifest)
      expect(row).toMatchObject({ state: 'initializing', provenance_sha256: expected.sha256 })
      expect(JSON.parse(String(row['provenance_json']))).toMatchObject({ evaluatorFileHashes: expected.evaluatorFileHashes })
      tracker.close()
    } finally {
      createSpy.mockRestore()
      if (registered && existsSync(registered.worktree)) writeFileSync(join(registered.worktree, 'evaluate.mjs'), registered.evaluator)
      await controller.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('attempts every activation cleanup phase and removes the durable partial run when cleanup phases throw', async () => {
    const f = controllerFixture([])
    const acquire = vi.spyOn(DurableTracker.prototype, 'acquireActiveLock').mockImplementation(() => { throw new Error('injected local lock failure') })
    const rollback = DurableTracker.prototype.rollbackRegisteredRunActivation
    const rollbackFault = vi.spyOn(DurableTracker.prototype, 'rollbackRegisteredRunActivation').mockImplementation(function (runId) { rollback.call(this, runId); throw new Error('injected registered-run cleanup failure') })
    const close = DurableTracker.prototype.close
    const closeFault = vi.spyOn(DurableTracker.prototype, 'close').mockImplementation(function () { close.call(this); throw new Error('injected tracker-close failure') })
    try {
      const controller = createCaseController(f)
      await expect(controller.run()).rejects.toThrow(/activation failed and 2 cleanup phase/)
      closeFault.mockRestore()
      const runsRoot = join(f.root, '.git', '.autoresearch-test', 'runs')
      const runDirectories = existsSync(runsRoot) ? readdirSync(runsRoot) : []
      expect(runDirectories).toHaveLength(1)
      const inspection = DurableTracker.openReadOnly(join(runsRoot, runDirectories[0]!, 'tracker.sqlite'))
      expect(inspection.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
      inspection.close()
      expect(execFileSync('git', ['-C', f.root, 'branch', '--list', 'autoresearch/*']).toString()).toBe('')
      expect(execFileSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain']).toString()).not.toContain('.autoresearch-test/worktrees')
    } finally {
      acquire.mockRestore(); rollbackFault.mockRestore(); closeFault.mockRestore(); rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('prepares a durable job binding, checkpoints cancellation before abort work, and starts no child or additional subprocess', async () => {
    const f = controllerFixture([])
    const close = vi.spyOn(DurableTracker.prototype, 'close')
    try {
      const controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, repository: f.root }, parent: f.parent, signal: new AbortController().signal })
      const prepared = await controller.prepare('autoresearch-7')
      const tracker = DurableTracker.open(prepared.tracker)
      expect(tracker.database.prepare("SELECT outcome_json FROM transitions WHERE run_id = ? AND outcome_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(prepared.runId)?.['outcome_json']).toContain('autoresearch-7')
      const subprocessCount = f.subprocess.specs.length
      controller.cancel('held initialization stop')
      expect(tracker.database.prepare("SELECT intent_json FROM transitions WHERE run_id = ? AND intent_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(prepared.runId)?.['intent_json']).toContain('held initialization stop')
      expect(f.creates).toHaveLength(0)
      expect(f.subprocess.specs).toHaveLength(subprocessCount)
      tracker.close()
      await controller.dispose()
      expect(close).toHaveBeenCalled()
    } finally {
      close.mockRestore()
      rmSync(f.root, { recursive: true, force: true })
    }
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

  it('reruns a proven-quiescent candidate evaluation exactly once from its recorded candidate commit', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: '{"score":9}\n' }, { stdout: '{"score":8}\n' }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), 'export const n = 2\n')])
    const original = DurableTracker.prototype.recordAttemptOutcome
    let candidateInterruptions = 0
    const fault = vi.spyOn(DurableTracker.prototype, 'recordAttemptOutcome').mockImplementation(function (attemptId, facts) {
      if (attemptId.includes('-candidate-') && candidateInterruptions < 2) {
        candidateInterruptions++
        this.database.prepare('UPDATE attempts SET process_tree_quiescent = 1 WHERE attempt_id = ?').run(attemptId)
        throw new Error(`candidate outcome barrier ${candidateInterruptions}`)
      }
      return original.call(this, attemptId, facts)
    })
    try {
      const first = createCaseController(f, { max_experiments: 1 }); await expect(first.run()).rejects.toThrow('candidate outcome barrier 1'); const ready = await first.ready
      const trackerBefore = DurableTracker.open(ready.tracker)
      const candidateCommit = String(trackerBefore.database.prepare("SELECT candidate_commit FROM experiments WHERE kind = 'candidate'").get()?.['candidate_commit'])
      expect(candidateCommit).toMatch(/^[0-9a-f]{40}$/u)
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      trackerBefore.close()
      await expect(createCaseController(f, { max_experiments: 1 }, ready.runId).run()).rejects.toThrow('candidate outcome barrier 2')
      fault.mockRestore()
      const terminal = await createCaseController(f, { max_experiments: 1 }, ready.runId).run()
      expect(terminal).toMatchObject({ status: 'round-failed', counts: { experimentsStarted: 1, experimentsCompleted: 1, attempts: 3 } })
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare("SELECT candidate_commit, state, failure_code FROM experiments WHERE kind = 'candidate'").get()).toEqual({ candidate_commit: candidateCommit, state: 'crashed', failure_code: 'recovery-rerun-exhausted' })
      expect(tracker.database.prepare("SELECT ordinal, process_tree_quiescent, exited_at FROM attempts WHERE experiment_id LIKE '%-candidate-%' ORDER BY ordinal").all()).toEqual([
        { ordinal: 1, process_tree_quiescent: 1, exited_at: null },
        { ordinal: 2, process_tree_quiescent: 1, exited_at: null },
      ])
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      tracker.close()
    } finally { fault.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['accept', 9, 'before-publication'], ['accept', 9, 'after-publication'],
    ['reject', 11, 'before-publication'], ['reject', 11, 'after-publication'],
  ] as const)('reconciles an interrupted %s decision with metric %s at %s deterministically and idempotently', async (decision, metric, barrier) => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }, { stdout: `{"score":${metric}}\n` }], [(worktree) => writeFileSync(join(worktree, 'src', 'code.ts'), `export const n = ${metric}\n`)])
    const checkpoint = DurableTracker.prototype.checkpointRun
    const commitTerminal = DurableTracker.prototype.commitTerminalExperiment
    let hits = 0
    const fault = barrier === 'before-publication'
      ? vi.spyOn(DurableTracker.prototype, 'checkpointRun').mockImplementation(function (runId, facts, at) {
          if ((facts.intent as { kind?: string } | undefined)?.kind === 'git-reconciliation' && hits++ === 0) throw new Error('decision barrier before publication')
          return checkpoint.call(this, runId, facts, at)
        })
      : vi.spyOn(DurableTracker.prototype, 'commitTerminalExperiment').mockImplementation(function (experimentId, state, facts, at) {
          if (experimentId.includes('-candidate-') && hits++ === 0) throw new Error('decision barrier after publication')
          return commitTerminal.call(this, experimentId, state, facts, at)
        })
    try {
      const interrupted = createCaseController(f, { max_experiments: 1 }); await expect(interrupted.run()).rejects.toThrow(`decision barrier ${barrier === 'before-publication' ? 'before' : 'after'} publication`); const ready = await interrupted.ready
      fault.mockRestore()
      const candidates = DurableTracker.open(ready.tracker)
      const rowBefore = candidates.database.prepare("SELECT candidate_commit FROM experiments WHERE kind = 'candidate'").get()!
      const candidateCommit = String(rowBefore['candidate_commit']); const startCommit = execFileSync('git', ['-C', f.root, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim()
      candidates.close()
      const [left, right] = await Promise.allSettled([createCaseController(f, { max_experiments: 1 }, ready.runId).run(), createCaseController(f, { max_experiments: 1 }, ready.runId).run()])
      expect([left, right].some(result => result.status === 'fulfilled' && result.value.status === 'budget-limited')).toBe(true)
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare("SELECT state, decision, metric, candidate_commit FROM experiments WHERE kind = 'candidate'").get()).toEqual({ state: decision === 'accept' ? 'accepted' : 'rejected', decision, metric, candidate_commit: candidateCommit })
      const run = tracker.getRun(ready.runId)!
      expect(run['best_commit']).toBe(decision === 'accept' ? candidateCommit : startCommit)
      expect(execFileSync('git', ['-C', ready.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(decision === 'accept' ? candidateCommit : startCommit)
      expect(candidateAuditCommits(f.root, ready.runId)).toEqual([candidateCommit])
      expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM attempts WHERE experiment_id LIKE '%-candidate-%'").get()?.['n']).toBe(1)
      expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM transitions WHERE scope = 'experiment' AND experiment_id LIKE '%-candidate-%' AND to_state = ?").get(decision === 'accept' ? 'accepted' : 'rejected')?.['n']).toBe(1)
      tracker.close()
    } finally { fault.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
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
      controller = new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.autoresearch-test', cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false, evaluatorRegistrations: [evaluatorRegistration] }), input: { ...input, repository: f.root, mutable_globs: ['src/**'] }, parent: f.parent, signal: new AbortController().signal })
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

  it('prunes failed-attempt artifact bytes while preserving terminal replay metadata', async () => {
    const f = controllerFixture([{ stdout: '', stderr: 'failed', exitCode: 9 }])
    try {
      const { result, ready, tracker } = await runControllerCase(f, {}, { retainFailedArtifacts: false })
      expect(result.status).toBe('baseline-blocked')
      const rows = tracker.database.prepare('SELECT run_id, experiment_id, attempt_id, kind, retention FROM artifacts ORDER BY kind').all()
      expect(rows.map(row => row['retention'])).toEqual(['pruned', 'pruned'])
      for (const row of rows) {
        const path = join(tracker.layout.root, 'artifacts', String(row['run_id']), String(row['experiment_id']), String(row['attempt_id']), `${String(row['kind'])}.log`)
        expect(existsSync(path)).toBe(false)
      }
      tracker.database.prepare("UPDATE artifacts SET retention = 'pruning' WHERE artifact_id = (SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT 1)").run()
      tracker.close()

      const replay = await createCaseController(f, {}, ready.runId, { retainFailedArtifacts: false }).run()
      expect(replay.status).toBe('baseline-blocked')
      expect(replay.artifacts).toHaveLength(2)
      expect(replay.artifacts.every(item => !('retention' in item))).toBe(true)
      expect(f.subprocess.evaluatorSpawns).toBe(1)
      const replayedTracker = DurableTracker.open(ready.tracker)
      expect(replayedTracker.database.prepare('SELECT DISTINCT retention FROM artifacts').all()).toEqual([{ retention: 'pruned' }])
      replayedTracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('sweeps expired artifact bytes and TSV exports before the next repository run', async () => {
    const f = controllerFixture([{ stdout: '{"score":5}\n' }, { stdout: '{"score":7}\n' }])
    try {
      const first = await runControllerCase(f, { run_tag: 'retention-first', target: 5, max_experiments: 1 }, { exportTsv: true })
      const old = new Date(Date.now() - 3 * 86_400_000)
      first.tracker.database.prepare('UPDATE artifacts SET created_at = ?').run(old.toISOString())
      const artifactPaths = first.tracker.database.prepare('SELECT run_id, experiment_id, attempt_id, kind FROM artifacts ORDER BY kind').all().map(row => join(first.tracker.layout.root, 'artifacts', String(row['run_id']), String(row['experiment_id']), String(row['attempt_id']), `${String(row['kind'])}.log`))
      const tsvPath = join(first.tracker.layout.root, 'exports', `${first.ready.runId}.tsv`)
      expect(artifactPaths.every(path => existsSync(path))).toBe(true)
      expect(existsSync(tsvPath)).toBe(true)
      utimesSync(tsvPath, old, old)
      first.tracker.close()

      const second = await runControllerCase(f, { run_tag: 'retention-second', target: 7, max_experiments: 1 }, { artifactRetentionDays: 1, tsvRetentionDays: 1 })
      second.tracker.close()
      const swept = DurableTracker.open(first.ready.tracker)
      expect(swept.database.prepare('SELECT DISTINCT retention FROM artifacts').all()).toEqual([{ retention: 'pruned' }])
      expect(artifactPaths.every(path => !existsSync(path))).toBe(true)
      expect(existsSync(tsvPath)).toBe(false)
      swept.close()

      const replay = await createCaseController(f, { target: 5, max_experiments: 1 }, first.ready.runId, { artifactRetentionDays: 1, tsvRetentionDays: 1 }).run()
      expect(replay).toMatchObject({ status: 'target-reached', best: { metric: 5 } })
      expect(f.subprocess.evaluatorSpawns).toBe(2)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('removes every safe terminal worktree when retainWorktrees is false by itself', async () => {
    const f = controllerFixture([{ stdout: '', exitCode: 9 }])
    try {
      const { result, ready, tracker } = await runControllerCase(f, {}, { retainWorktrees: false, cleanupWorktreesOnSuccess: false })
      expect(result.status).toBe('baseline-blocked')
      expect(existsSync(ready.worktree)).toBe(false)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each([
    ['failed', { stdout: '', exitCode: 9 }, {}, 'baseline-blocked', true],
    ['successful', { stdout: '{"score":5}\n' }, { target: 5, max_experiments: 1 }, 'target-reached', false],
  ] as const)('limits cleanupWorktreesOnSuccess to %s terminal outcomes', async (_label, evaluation, overrides, status, retained) => {
    const f = controllerFixture([evaluation])
    try {
      const { result, ready, tracker } = await runControllerCase(f, overrides, { retainWorktrees: false, cleanupWorktreesOnSuccess: true })
      expect(result.status).toBe(status)
      expect(existsSync(ready.worktree)).toBe(retained)
      tracker.close()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('treats forbidden child edits as a host policy failure while a child blocker claim remains non-authoritative', async () => {
    const f = controllerFixture([{ stdout: '{"score":10}\n' }], [(worktree) => writeFileSync(join(worktree, 'package.json'), '{}\n')])
    try { const { result, tracker } = await runControllerCase(f, { mutable_globs: ['**'], max_experiments: 1 }); expect(result).toMatchObject({ status: 'round-failed' }); expect(String((result as { reason: string }).reason)).toMatch(/forbidden|protected|policy/iu); expect(tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE kind='candidate'").get()?.['n']).toBe(0); const outcomes = tracker.listTransitions(String((result as { runId: string }).runId)).map(row => String(row['outcome_json'])); expect(outcomes.some(value => value.includes('child-blocker-claim') && value.includes('false'))).toBe(true); tracker.close() } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
