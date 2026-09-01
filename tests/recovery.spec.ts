import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRunLock, allocateRunWorktree, captureGitConfigBaseline, checkoutCandidateForEvaluation, commitCandidate, discoverRepository, durableGitIdentity, makeRunGitIdentity, snapshotCandidate, validateCandidate } from '../src/git.ts'
import type { EvaluatorFailureCode } from '../src/evaluator.ts'
import { classifyDurableRegistration, reconcileRecovery, type RecoveredEvaluation, type RecoveryRequest } from '../src/recovery.ts'
import { DurableTracker } from '../src/tracker.ts'
import { serializeRegistrationJson, type DurableRegistrationIdentity, type DurableRunPolicy, type EvaluatorRegistration } from '../src/types.ts'

const SHA = 'a'.repeat(40)
const HASH = 'b'.repeat(64)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-recovery-'))
  roots.push(root)
  const tracker = DurableTracker.open(join(root, 'tracker.sqlite'))
  const repository = join(root, 'repo')
  const gitCommonDir = join(repository, '.git')
  const worktree = join(root, 'worktree')
  const runId = 'run-1'
  const policy = { repository, runTag: 'tag', objective: 'improve', constraints: [], mutableGlobs: ['src/**'], exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], gitConfig: [], submodules: [] }, evaluation: { command: 'node', args: ['evaluate.mjs'] }, metricName: 'score', metricDirection: 'minimize', timeoutMs: 1_000, maxExperiments: 2, provenance: {}, environment: {} } satisfies DurableRunPolicy
  const discovery = { repository, callerCwd: repository, gitCommonDir, repositoryId: 'repo-id', startCommit: SHA }
  const identity = { runId, runTag: 'tag', branch: 'autoresearch/tag-run-1', worktree, acceptedRef: 'refs/autoresearch/runs/run-1/accepted', candidateRefPrefix: 'refs/autoresearch/runs/run-1/candidates/' }
  const request = { tracker, runId, discovery, identity, policy, policySha256: HASH, provenanceSha256: HASH, gitExecutable: '/usr/bin/git', gitOptions: { timeoutMs: 1_000, graceMs: 100, maxStdoutBytes: 10_000, maxStderrBytes: 10_000 }, signal: new AbortController().signal } satisfies RecoveryRequest
  return { tracker, request }
}

function createRun(tracker: DurableTracker, request: RecoveryRequest): void {
  tracker.createRun({ runId: request.runId, repositoryId: request.discovery.repositoryId, repository: request.discovery.repository, gitCommonDir: request.discovery.gitCommonDir, callerCwd: request.discovery.callerCwd, startCommit: request.discovery.startCommit, runTag: request.identity.runTag, branch: request.identity.branch, worktree: request.identity.worktree, policy: request.policy, policySha256: request.policySha256, provenance: {}, provenanceSha256: request.provenanceSha256 })
}

function persistOutcome(
  tracker: DurableTracker,
  request: RecoveryRequest,
  experimentId: string,
  attemptId: string,
  ordinal: number,
  stdout = '{"score":7}\n',
  stderr = '',
  failed = false,
  options: { readonly metric?: number; readonly stdoutTruncated?: boolean; readonly stderrTruncated?: boolean; readonly failureCode?: 'exit'; readonly failureMessage?: string; readonly policyViolationMessage?: string } = {},
): void {
  tracker.createAttemptIntent({ attemptId, runId: request.runId, experimentId, ordinal }, { provenanceSha256: request.provenanceSha256 })
  const directory = join(tracker.layout.root, 'artifacts', request.runId, experimentId, attemptId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const artifacts = ([['stdout', stdout], ['stderr', stderr]] as const).map(([kind, content]) => {
    const path = join(directory, `${kind}.log`); writeFileSync(path, content, { mode: 0o600 }); chmodSync(path, 0o600)
    const bytes = Buffer.from(content)
    const truncated = kind === 'stdout' ? options.stdoutTruncated ?? false : options.stderrTruncated ?? false
    return { artifactId: `${attemptId}-${kind}`, runId: request.runId, experimentId, attemptId, kind, location: `artifact:sha256:${createHash('sha256').update(path).digest('hex')}`, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), owner: 'evaluator', retention: 'retain', metadata: { truncated } }
  })
  const failureCode = options.failureCode ?? 'exit'
  const failureMessage = options.failureMessage ?? 'baseline failed'
  const result = failed ? { kind: 'failed' as const, code: failureCode, message: failureMessage } : { kind: 'measured' as const, metric: options.metric ?? 7 }
  tracker.recordAttemptOutcome(attemptId, { facts: { exitedAt: new Date().toISOString(), exitCode: failed ? 1 : 0, signal: null, timedOut: false, processTreeQuiescent: true, ...(failed ? { failureCode, failureMessage } : {}) }, artifacts, result, ...(options.policyViolationMessage ? { outcome: { kind: 'frozen-file-policy-mismatch', code: 'provenance-mismatch', message: options.policyViolationMessage, evidence: [{ code: 'provenance-mismatch', message: options.policyViolationMessage }] } } : {}) })
}

it('keeps controller provenance mismatches outside recovered raw evaluator failure codes', () => {
  type RecoveredFailureCode = Extract<RecoveredEvaluation, { kind: 'failed' }>['code']
  // @ts-expect-error Post-evaluator frozen-file classification is not a raw evaluator outcome.
  const recovered: RecoveredFailureCode = 'provenance-mismatch'
  const raw: EvaluatorFailureCode = 'exit'
  expect([recovered, raw]).toEqual(['provenance-mismatch', 'exit'])
})

const unusedContext = {} as Parameters<typeof reconcileRecovery>[0]

describe('recovery reconciler', () => {
  it('returns a typed missing-run block without inspecting Git', async () => {
    const { tracker, request } = fixture()
    await expect(reconcileRecovery(unusedContext, request)).resolves.toMatchObject({ kind: 'blocked', code: 'run-missing', lock: 'retain' })
    tracker.close()
  })

  it.each([
    ['repository-mismatch', (request: RecoveryRequest) => ({ ...request, discovery: { ...request.discovery, repositoryId: 'other' } })],
    ['start-commit-mismatch', (request: RecoveryRequest) => ({ ...request, discovery: { ...request.discovery, startCommit: 'c'.repeat(40) } })],
    ['policy-mismatch', (request: RecoveryRequest) => ({ ...request, policySha256: 'c'.repeat(64) })],
    ['provenance-mismatch', (request: RecoveryRequest) => ({ ...request, provenanceSha256: 'c'.repeat(64) })],
  ] as const)('classifies immutable %s before attempting repair', async (code, mutate) => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    await expect(reconcileRecovery(unusedContext, mutate(request))).resolves.toMatchObject({ kind: 'blocked', code, lock: 'retain' })
    tracker.close()
  })

  it('authorizes initialization only from the exact immutable row without an active lock', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'initialize', runId: request.runId, startCommit: SHA, reuseLock: false })
    tracker.close()
  })

  it('accepts another caller subdirectory for the same canonical repository identity', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    const resumed = { ...request, discovery: { ...request.discovery, callerCwd: join(request.discovery.repository, 'nested') } }
    await expect(reconcileRecovery(unusedContext, resumed)).resolves.toEqual({ kind: 'initialize', runId: request.runId, startCommit: SHA, reuseLock: false })
    tracker.close()
  })

  it('reuses a matching initialization lock and resumes the same worktree without reacquisition', async () => {
    const f = await realFixture()
    const directive = await reconcileRecovery(f.ctx, f.request)
    expect(directive).toEqual({ kind: 'initialize', runId: f.request.runId, startCommit: f.request.discovery.startCommit, reuseLock: true })
    f.tracker.acquireActiveLock(f.request.runId, f.request.discovery.repositoryId, f.request.identity.runTag)
    await allocateRunWorktree(f.ctx, f.request.gitExecutable, f.request.discovery, f.request.identity, durableGitIdentity(f.tracker, f.request.runId), f.request.gitOptions, true)
    expect(f.tracker.database.prepare('SELECT COUNT(*) AS n FROM active_locks WHERE run_id = ? AND released_at IS NULL').get(f.request.runId)?.['n']).toBe(1)
    expect(execFileSync('git', ['-C', f.request.identity.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(f.request.discovery.startCommit)
    f.tracker.close()
  })

  it.each([
    { state: 'blocked' as const, fromState: undefined, lastState: undefined },
    { state: 'round-failed' as const, fromState: 'baseline-running' as const, lastState: undefined },
    { state: 'cancelled' as const, fromState: undefined, lastState: 'initializing' as const },
  ])('classifies evaluator-free terminal $state by explicit contract', async ({ state, fromState, lastState }) => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    tracker.acquireActiveLock(request.runId, request.discovery.repositoryId, request.identity.runTag)
    if (fromState) tracker.transitionRun(request.runId, fromState)
    tracker.transitionRun(request.runId, state, { terminalReason: state, blockedCode: state })
    const terminal = { kind: 'terminal', runId: request.runId, state, ...(lastState ? { lastState } : {}), artifacts: [] }
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ ...terminal, lock: 'release' })
    tracker.releaseActiveLock(request.runId)
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ ...terminal, lock: 'already-released' })
    tracker.close()
  })

  it('validates a terminal failed baseline before releasing its lock and is idempotent', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request); tracker.acquireActiveLock(request.runId, request.discovery.repositoryId, request.identity.runTag)
    tracker.transitionRun(request.runId, 'baseline-running'); tracker.createExperiment({ experimentId: 'baseline', runId: request.runId, ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: [] }); tracker.transitionExperiment('baseline', 'running')
    persistOutcome(tracker, request, 'baseline', 'attempt-1', 1, '', 'failed\n', true); tracker.commitTerminalExperiment('baseline', 'crashed', { failureCode: 'exit', failureMessage: 'baseline failed' }); tracker.transitionRun(request.runId, 'baseline-blocked', { terminalReason: 'baseline failed', blockedCode: 'exit', quiescent: true })
    const first = await reconcileRecovery(unusedContext, request); const second = await reconcileRecovery(unusedContext, request)
    expect(first).toMatchObject({ kind: 'terminal', state: 'baseline-blocked', lock: 'release', artifacts: [{ kind: 'stderr' }, { kind: 'stdout' }] }); expect(second).toEqual(first)
    tracker.close()
  })

  it.each(['missing', 'tampered', 'extraneous'] as const)('retains the terminal lock for %s canonical artifact evidence', async fault => {
    const { tracker, request } = fixture(); createRun(tracker, request); tracker.acquireActiveLock(request.runId, request.discovery.repositoryId, request.identity.runTag)
    tracker.transitionRun(request.runId, 'baseline-running'); tracker.createExperiment({ experimentId: 'baseline', runId: request.runId, ordinal: 0, kind: 'baseline', parentCommit: SHA, command: 'node', args: [] }); tracker.transitionExperiment('baseline', 'running')
    persistOutcome(tracker, request, 'baseline', 'attempt-1', 1, '', 'failed\n', true); tracker.commitTerminalExperiment('baseline', 'crashed', { failureCode: 'exit', failureMessage: 'baseline failed' }); tracker.transitionRun(request.runId, 'baseline-blocked', { terminalReason: 'baseline failed', blockedCode: 'exit', quiescent: true })
    if (fault === 'missing') rmSync(join(tracker.layout.root, 'artifacts', request.runId, 'baseline', 'attempt-1', 'stdout.log'))
    if (fault === 'tampered') writeFileSync(join(tracker.layout.root, 'artifacts', request.runId, 'baseline', 'attempt-1', 'stdout.log'), 'tampered', { mode: 0o600 })
    if (fault === 'extraneous') tracker.database.exec("PRAGMA foreign_keys=OFF; INSERT INTO artifacts VALUES ('extra','run-1',NULL,NULL,'trace','artifact:sha256:" + 'd'.repeat(64) + "',0,'" + 'e'.repeat(64) + "','host','retain','{}','2026-01-01T00:00:00.000Z'); PRAGMA foreign_keys=ON")
    await expect(reconcileRecovery(unusedContext, request)).resolves.toMatchObject({ kind: 'blocked', code: 'artifact-incomplete', lock: 'retain' })
    expect(tracker.recoveryState(request.runId).activeLock).toBeDefined(); tracker.close()
  })

  it('replays idempotently after evaluator outcome and terminal experiment persistence', async () => {
    const f = await realFixture(); const { tracker, request } = f
    tracker.transitionRun(request.runId, 'baseline-running'); tracker.createExperiment({ experimentId: 'baseline', runId: request.runId, ordinal: 0, kind: 'baseline', parentCommit: request.discovery.startCommit, command: 'node', args: [] }); tracker.transitionExperiment('baseline', 'running')
    persistOutcome(tracker, request, 'baseline', 'attempt-1', 1); tracker.commitTerminalExperiment('baseline', 'accepted', { metric: 7, decision: 'accept' })
    const first = await reconcileRecovery(f.ctx, request); const replay = await reconcileRecovery(f.ctx, request)
    expect(first).toEqual({ kind: 'settle-baseline', runId: request.runId, experiment: { experimentId: 'baseline', ordinal: 0, kind: 'baseline', parentCommit: request.discovery.startCommit }, outcome: { kind: 'accept', metric: 7 } }); expect(replay).toEqual(first)
    expect(tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.['n']).toBe(1); expect(tracker.getRun(request.runId)?.['state']).toBe('baseline-running'); tracker.close()
  })

  it('retains a proposal-uncertain terminal lock from the durable run fact across repeated recovery', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    tracker.acquireActiveLock(request.runId, request.discovery.repositoryId, request.identity.runTag)
    tracker.transitionRun(request.runId, 'blocked', { terminalReason: 'proposal disposal uncertain', blockedCode: 'attempt-uncertain', quiescent: false })
    expect(tracker.getRun(request.runId)?.['terminal_quiescent']).toBe(0)
    expect(tracker.recoveryState(request.runId)).toMatchObject({ processDisposition: 'uncertain', safeToReleaseTerminalLock: false })
    const first = await reconcileRecovery(unusedContext, request)
    const second = await reconcileRecovery(unusedContext, request)
    expect(first).toEqual({ kind: 'terminal', runId: request.runId, state: 'blocked', lock: 'retain', artifacts: [] })
    expect(second).toEqual(first)
    expect(() => tracker.releaseActiveLock(request.runId)).toThrow(/safe-to-release/)
    tracker.close()
  })

  it('rejects a noninitial state whose active lock was lost', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    tracker.transitionRun(request.runId, 'baseline-running')
    await expect(reconcileRecovery(unusedContext, request)).resolves.toMatchObject({ kind: 'blocked', code: 'lock-mismatch', lock: 'retain' })
    tracker.close()
  })

  it('is deterministic across repeated interruption recovery reads', async () => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    const first = await reconcileRecovery(unusedContext, request)
    const second = await reconcileRecovery(unusedContext, request)
    expect(second).toEqual(first)
    expect(tracker.listTransitions(request.runId)).toHaveLength(1)
    tracker.close()
  })
  it('classifies legacy and registered durable authority before recovery ownership', async () => {
    const legacy = fixture(); createRun(legacy.tracker, legacy.request)
    expect(classifyDurableRegistration(legacy.tracker, legacy.request.runId)).toMatchObject({ kind: 'legacy', evidence: { kind: 'legacy-run', code: 'legacy-contract' } })
    await expect(reconcileRecovery(unusedContext, legacy.request)).resolves.toEqual({ kind: 'initialize', runId: legacy.request.runId, startCommit: SHA, reuseLock: false })
    expect(legacy.tracker.database.prepare('SELECT COUNT(*) AS count FROM run_registrations').get()).toEqual({ count: 0 })
    legacy.tracker.close()

    const registered = fixture()
    const registration: EvaluatorRegistration = { evaluatorId: 'judge', command: 'node', args: ['score.mjs'], environment: {}, metricName: 'score', metricDirection: 'maximize', evaluatorFiles: ['score.mjs'], dataset: { kind: 'none' } }
    registered.tracker.createRegisteredRun({ runId: registered.request.runId, repositoryId: registered.request.discovery.repositoryId, repository: registered.request.discovery.repository, gitCommonDir: registered.request.discovery.gitCommonDir, callerCwd: registered.request.discovery.callerCwd, startCommit: registered.request.discovery.startCommit, runTag: registered.request.identity.runTag, branch: registered.request.identity.branch, worktree: registered.request.identity.worktree, policy: registered.request.policy, policySha256: registered.request.policySha256, provenance: {}, provenanceSha256: registered.request.provenanceSha256, registration, manifest: { 'score.mjs': HASH } })
    expect(classifyDurableRegistration(registered.tracker, registered.request.runId)).toMatchObject({ kind: 'registered', identity: { evaluatorId: 'judge', registrationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) } })
    await expect(reconcileRecovery(unusedContext, registered.request)).resolves.toEqual({ kind: 'initialize', runId: registered.request.runId, startCommit: SHA, reuseLock: false })
    registered.tracker.close()
  })

  it('typed-blocks directly seeded corrupt registration evidence without changing legacy recovery dispatch', async () => {
    const { tracker, request } = fixture()
    createRun(tracker, request)
    tracker.database.prepare("UPDATE transitions SET intent_json = ? WHERE run_id = ? AND scope = 'run' AND from_state IS NULL AND to_state = 'initializing'").run('{"kind":"create-run","contractGeneration":"host-registration-v1"}', request.runId)
    tracker.database.prepare(`INSERT INTO run_registrations (run_id, contract_generation, evaluator_id, registration_json, manifest_json, registration_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      request.runId, 'host-registration-v1', 'judge', '{malformed', '{}', '0'.repeat(64), new Date().toISOString(),
    )
    expect(classifyDurableRegistration(tracker, request.runId)).toMatchObject({ kind: 'blocked', evidence: { kind: 'registration-blocked', code: 'registration-corrupt' } })
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'initialize', runId: request.runId, startCommit: SHA, reuseLock: false })
    tracker.close()
  })

  it('typed-blocks extended, duplicate-key, and non-canonical persisted registration JSON', async () => {
    const registration: EvaluatorRegistration = { evaluatorId: 'judge', command: 'node', args: ['score.mjs'], environment: {}, metricName: 'score', metricDirection: 'maximize', evaluatorFiles: ['score.mjs'], dataset: { kind: 'none' } }
    const corruptions: readonly { readonly field: 'registration_json' | 'manifest_json'; readonly mutate: (identity: DurableRegistrationIdentity) => string }[] = [
      { field: 'registration_json', mutate: identity => serializeRegistrationJson({ ...identity.registration, extension: true }) },
      { field: 'registration_json', mutate: identity => serializeRegistrationJson(identity.registration).replace('"command":"node"', '"command":"node","command":"node"') },
      { field: 'registration_json', mutate: identity => serializeRegistrationJson({ ...identity.registration, evaluatorFiles: ['score.mjs', 'score.mjs'] }) },
      { field: 'manifest_json', mutate: identity => ` ${serializeRegistrationJson(identity.manifest)}` },
      { field: 'manifest_json', mutate: identity => serializeRegistrationJson(identity.manifest).replace('{', `{"score.mjs":"${HASH}",`) },
    ]
    for (const corruption of corruptions) {
      const { tracker, request } = fixture()
      const identity = tracker.createRegisteredRun({ runId: request.runId, repositoryId: request.discovery.repositoryId, repository: request.discovery.repository, gitCommonDir: request.discovery.gitCommonDir, callerCwd: request.discovery.callerCwd, startCommit: request.discovery.startCommit, runTag: request.identity.runTag, branch: request.identity.branch, worktree: request.identity.worktree, policy: request.policy, policySha256: request.policySha256, provenance: {}, provenanceSha256: request.provenanceSha256, registration, manifest: { 'score.mjs': HASH } })
      tracker.database.exec('DROP TRIGGER run_registrations_immutable')
      tracker.database.prepare(`UPDATE run_registrations SET ${corruption.field} = ? WHERE run_id = ?`).run(corruption.mutate(identity), request.runId)
      expect(classifyDurableRegistration(tracker, request.runId)).toMatchObject({ kind: 'blocked', evidence: { kind: 'registration-blocked', code: 'registration-corrupt' } })
      await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'initialize', runId: request.runId, startCommit: SHA, reuseLock: false })
      tracker.close()
    }
  })
})

class RecoveryReader implements SubprocessOutputReader {
  constructor(private readonly bytes: () => Buffer, private readonly cap: number) {}
  readFrom(fromByte: number) { const whole = this.bytes(); const retained = whole.subarray(Math.max(0, whole.length - this.cap)); return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length } }
}
class RecoveryHandle implements SubprocessHandle {
  readonly stdin = undefined; readonly stdout = undefined; readonly stderr = undefined; readonly pid: number; readonly collected; readonly done: Promise<SubprocessOutcome>
  private exited = false
  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], outCap: number, errCap: number) { this.pid = child.pid ?? -1; this.collected = { stdout: new RecoveryReader(() => Buffer.concat(stdout), outCap), stderr: new RecoveryReader(() => Buffer.concat(stderr), errCap) }; this.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { this.exited = true; resolve({ exitCode, signal }) }) }) }
  terminate(): void { if (!this.exited && this.pid > 0) try { process.kill(-this.pid, 'SIGTERM') } catch {} }
  async waitForExit(): Promise<boolean> { await this.done; return true }
}
class RecoverySubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  async resolveExecutable(command: string): Promise<string> { return execFileSync('which', [command]).toString().trim() }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle { this.specs.push(spec); const stdout: Buffer[] = []; const stderr: Buffer[] = []; const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: [typeof spec.stdio.stdin === 'object' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); if (typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data); child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk)); const handle = new RecoveryHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0); spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle }
}

async function realFixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-recovery-real-')); roots.push(root); const repository = join(root, 'repo'); mkdirSync(repository)
  execFileSync('git', ['init', '-b', 'main', repository]); execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']); mkdirSync(join(repository, 'src')); writeFileSync(join(repository, 'src', 'code.ts'), 'base\n'); execFileSync('git', ['-C', repository, 'add', '.']); execFileSync('git', ['-C', repository, 'commit', '-m', 'base'])
  const subprocess = new RecoverySubprocess(); const ctx = { subprocess } as unknown as Context; const gitExecutable = await subprocess.resolveExecutable('git'); const gitOptions = { timeoutMs: 5_000, graceMs: 100, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 }; const discovery = await discoverRepository(ctx, gitExecutable, repository, gitOptions)
  const runId = 'run-real'; const policy = { repository, runTag: 'tag', objective: 'improve', constraints: [], mutableGlobs: ['src/**'], exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], gitConfig: [], submodules: [] }, evaluation: { command: 'node', args: ['evaluate.mjs'] }, metricName: 'score', metricDirection: 'minimize', timeoutMs: 1_000, maxExperiments: 2, provenance: {}, environment: {} } satisfies DurableRunPolicy
  const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'tag', runId); const tracker = DurableTracker.open(join(root, 'tracker.sqlite')); const request = { tracker, runId, discovery, identity, policy, policySha256: HASH, provenanceSha256: HASH, gitExecutable, gitOptions, signal: new AbortController().signal } satisfies RecoveryRequest
  createRun(tracker, request); acquireRunLock(tracker, identity, discovery.repositoryId, 2); await allocateRunWorktree(ctx, gitExecutable, discovery, identity, durableGitIdentity(tracker, runId), gitOptions); return { root, ctx, tracker, request, subprocess }
}

describe('recovery nonterminal state matrix with real Git/SQLite', () => {
  it('reconciles ready deterministically without creating a candidate', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running'); f.tracker.transitionRun(f.request.runId, 'ready', { best: { metric: 10, commit: f.request.discovery.startCommit, experimentId: 'baseline' } })
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toEqual({ kind: 'ready', runId: f.request.runId, best: { metric: 10, commit: f.request.discovery.startCommit, experimentId: 'baseline' }, nextOrdinal: 1, restoreCommit: f.request.discovery.startCommit }); expect(second).toEqual(first); expect(f.tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE kind='candidate'").get()?.['n']).toBe(0); f.tracker.close()
  })

  it.each([
    ['no experiment', (f: Awaited<ReturnType<typeof realFixture>>) => undefined, { kind: 'evaluate', createExperiment: true, attemptOrdinal: 1, rerun: false }],
    ['pending experiment', (f: Awaited<ReturnType<typeof realFixture>>) => f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }), { kind: 'evaluate', createExperiment: false, attemptOrdinal: 1, rerun: false }],
    ['running without attempt', (f: Awaited<ReturnType<typeof realFixture>>) => { f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running') }, { kind: 'evaluate', createExperiment: false, attemptOrdinal: 1, rerun: false }],
  ] as const)('reconciles baseline-running with %s', async (_label, arrange, expected) => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running'); arrange(f); const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request); expect(first).toMatchObject(expected); expect(second).toEqual(first); expect(f.subprocess.specs.every(spec => spec.argv[0] === f.request.gitExecutable)).toBe(true); f.tracker.close()
  })


  it.each([
    ['accepted', { metric: 7, decision: 'accept' }],
    ['crashed', { failureCode: 'signal', failureMessage: 'signal' }],
  ] as const)('refuses to settle a terminal %s baseline without its durable evaluator attempt', async (terminal, facts) => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running'); f.tracker.commitTerminalExperiment('baseline', terminal, facts)
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toMatchObject({ kind: 'blocked', code: 'attempt-uncertain', lock: 'retain' }); expect(second).toEqual(first); expect(f.tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.['n']).toBe(0)
    f.tracker.close()
  })
  it('blocks an uncertain prior evaluator repeatedly without PID signalling or duplicate execution', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running'); f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running'); f.tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: f.request.runId, experimentId: 'baseline', ordinal: 1 }, { provenanceSha256: HASH }); f.tracker.recordAttemptObserved('attempt-1', { providerPid: 4242, spawnedAt: new Date().toISOString() })
    const before = f.subprocess.specs.length; const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request); expect(first).toMatchObject({ kind: 'blocked', code: 'attempt-uncertain', lock: 'retain' }); expect(second).toEqual(first); expect(f.subprocess.specs.slice(before).every(spec => spec.argv[0] === f.request.gitExecutable)).toBe(true); expect(f.tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.['n']).toBe(1); f.tracker.close()
  })

  it('recovers the authoritative metric without reparsing redacted stdout', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running')
    persistOutcome(f.tracker, f.request, 'baseline', 'attempt-1', 1, '{"score":[REDACTED]}\n', '', false, { metric: 1 })
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toMatchObject({ kind: 'finalize-evaluation', evaluation: { kind: 'measured', metric: 1 } }); expect(second).toEqual(first)
    f.tracker.close()
  })

  it('recovers post-evaluator provenance mismatch authority without rewriting the completed raw metric', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running')
    persistOutcome(f.tracker, f.request, 'baseline', 'attempt-1', 1, '{"score":1}\n', '', false, { metric: 1, policyViolationMessage: 'frozen evaluator files differ from the immutable manifest' })
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toMatchObject({ kind: 'finalize-evaluation', evaluation: { kind: 'measured', metric: 1, policyViolation: { code: 'provenance-mismatch', message: 'frozen evaluator files differ from the immutable manifest' } } }); expect(second).toEqual(first)
    f.tracker.close()
  })

  it('preserves a measured outcome when only stderr was truncated', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running')
    persistOutcome(f.tracker, f.request, 'baseline', 'attempt-1', 1, '{"score":3}\n', 'bounded stderr tail', false, { metric: 3, stderrTruncated: true })
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toMatchObject({ kind: 'finalize-evaluation', evaluation: { kind: 'measured', metric: 3, artifacts: [{ kind: 'stderr', metadata: { truncated: true } }, { kind: 'stdout', metadata: { truncated: false } }] } }); expect(second).toEqual(first)
    f.tracker.close()
  })

  it('reruns one proven-quiescent no-outcome evaluator attempt exactly once and never duplicates after recovery advances', async () => {
    const f = await realFixture()
    f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] })
    f.tracker.transitionExperiment('baseline', 'running')
    f.tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: f.request.runId, experimentId: 'baseline', ordinal: 1 }, { provenanceSha256: HASH })
    f.tracker.recordAttemptObserved('attempt-1', { processTreeQuiescent: true })

    const rerun = await reconcileRecovery(f.ctx, f.request)
    expect(rerun).toMatchObject({ kind: 'evaluate', experiment: { experimentId: 'baseline' }, attemptOrdinal: 2, rerun: true })
    f.tracker.createAttemptIntent({ attemptId: 'attempt-2', runId: f.request.runId, experimentId: 'baseline', ordinal: 2 }, { provenanceSha256: HASH })

    const firstAfterSpawn = await reconcileRecovery(f.ctx, f.request)
    const repeatedAfterSpawn = await reconcileRecovery(f.ctx, f.request)
    expect(firstAfterSpawn).toMatchObject({ kind: 'blocked', code: 'attempt-uncertain', lock: 'retain' })
    expect(repeatedAfterSpawn).toEqual(firstAfterSpawn)
    expect(f.tracker.database.prepare('SELECT attempt_id, ordinal FROM attempts ORDER BY ordinal').all()).toEqual([
      { attempt_id: 'attempt-1', ordinal: 1 },
      { attempt_id: 'attempt-2', ordinal: 2 },
    ])
    f.tracker.close()
  })

  it('blocks a completed zero-artifact attempt as artifact-incomplete and never schedules a rerun', async () => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running')
    f.tracker.createExperiment({ experimentId: 'baseline', runId: f.request.runId, ordinal: 0, kind: 'baseline', parentCommit: f.request.discovery.startCommit, command: 'node', args: [] }); f.tracker.transitionExperiment('baseline', 'running')
    f.tracker.createAttemptIntent({ attemptId: 'attempt-1', runId: f.request.runId, experimentId: 'baseline', ordinal: 1 }, { provenanceSha256: HASH })
    f.tracker.recordAttemptOutcome('attempt-1', { facts: { exitedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: false, processTreeQuiescent: true }, artifacts: [], result: { kind: 'measured', metric: 7 } })
    const first = await reconcileRecovery(f.ctx, f.request); const second = await reconcileRecovery(f.ctx, f.request)
    expect(first).toMatchObject({ kind: 'blocked', code: 'artifact-incomplete', lock: 'retain' }); expect(second).toEqual(first)
    expect(f.tracker.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.['n']).toBe(1)
    f.tracker.close()
  })

  it.each([
    ['repository', (f: Awaited<ReturnType<typeof realFixture>>) => ({ ...f.request, discovery: { ...f.request.discovery, repositoryId: 'other' } }), 'repository-mismatch'],
    ['policy', (f: Awaited<ReturnType<typeof realFixture>>) => ({ ...f.request, policySha256: 'c'.repeat(64) }), 'policy-mismatch'],
    ['provenance', (f: Awaited<ReturnType<typeof realFixture>>) => ({ ...f.request, provenanceSha256: 'c'.repeat(64) }), 'provenance-mismatch'],
  ] as const)('retains the lock for %s identity blockers without mutation', async (_label, mutate, code) => {
    const f = await realFixture(); f.tracker.transitionRun(f.request.runId, 'baseline-running'); const before = f.tracker.listTransitions(f.request.runId); await expect(reconcileRecovery(f.ctx, mutate(f))).resolves.toMatchObject({ kind: 'blocked', code, lock: 'retain' }); expect(f.tracker.listTransitions(f.request.runId)).toEqual(before); f.tracker.close()
  })
  it('replays candidate preparation before and after audit publication without allocating another candidate', async () => {
    const f = await realFixture(); const best = { metric: 10, commit: f.request.discovery.startCommit, experimentId: 'baseline' }; f.tracker.transitionRun(f.request.runId, 'baseline-running'); f.tracker.transitionRun(f.request.runId, 'ready', { best })
    const baseline = await captureGitConfigBaseline(f.ctx, f.request.gitExecutable, f.request.identity.worktree, f.request.policy, f.request.gitOptions); writeFileSync(join(f.request.identity.worktree, 'src', 'code.ts'), 'candidate\n'); const snapshot = await snapshotCandidate(f.ctx, f.request.gitExecutable, f.request.identity.worktree, baseline, f.request.gitOptions); const paths = validateCandidate(snapshot, f.request.policy); const experimentId = 'candidate-1'
    f.tracker.prepareCandidate({ experimentId, runId: f.request.runId, ordinal: 1, kind: 'candidate', parentCommit: best.commit, command: 'node', args: [], annotation: { trust: 'untrusted-child-annotation', hypothesis: 'candidate hypothesis', intendedEdits: ['src/code.ts'], implementationSummary: 'candidate summary' } }, { intent: { kind: 'candidate-snapshot', experimentId, snapshot, validatedPaths: paths } })
    const before = await reconcileRecovery(f.ctx, f.request); expect(before).toMatchObject({ kind: 'commit-candidate', experiment: { experimentId } }); expect(await reconcileRecovery(f.ctx, f.request)).toEqual(before)
    const candidate = await commitCandidate(f.ctx, f.request.gitExecutable, f.request.identity.worktree, f.request.identity, experimentId, snapshot, paths, f.request.gitOptions); await checkoutCandidateForEvaluation(f.ctx, f.request.gitExecutable, f.request.identity.worktree, f.request.identity, candidate.candidateCommit, best.commit, f.request.gitOptions); f.tracker.recordCandidateCommit(experimentId, candidate.candidateCommit)
    const after = await reconcileRecovery(f.ctx, f.request); expect(after).toMatchObject({ kind: 'evaluate', experiment: { experimentId, candidateCommit: candidate.candidateCommit }, commit: candidate.candidateCommit, createExperiment: false, attemptOrdinal: 1, rerun: false }); expect(await reconcileRecovery(f.ctx, f.request)).toEqual(after); expect(f.tracker.database.prepare("SELECT COUNT(*) AS n FROM experiments WHERE kind='candidate'").get()?.['n']).toBe(1); f.tracker.close()
  })

  it.each([
    ['minimize accept', 'minimize', 9, 'accept'], ['minimize tie', 'minimize', 10, 'reject'], ['minimize regression', 'minimize', 11, 'reject'],
    ['maximize accept', 'maximize', 11, 'accept'], ['maximize tie', 'maximize', 10, 'reject'], ['maximize regression', 'maximize', 9, 'reject'],
  ] as const)('refuses terminal %s candidate decisions without durable evaluator evidence', async (_label, direction, metric, _outcome) => {
    const f = await realFixture(); const policy = { ...f.request.policy, metricDirection: direction }; const request = { ...f.request, policy }; const best = { metric: 10, commit: f.request.discovery.startCommit, experimentId: 'baseline' }; f.tracker.transitionRun(f.request.runId, 'baseline-running'); f.tracker.transitionRun(f.request.runId, 'ready', { best })
    const baseline = await captureGitConfigBaseline(f.ctx, f.request.gitExecutable, f.request.identity.worktree, policy, f.request.gitOptions); writeFileSync(join(f.request.identity.worktree, 'src', 'code.ts'), `${metric}\n`); const snapshot = await snapshotCandidate(f.ctx, f.request.gitExecutable, f.request.identity.worktree, baseline, f.request.gitOptions); const paths = validateCandidate(snapshot, policy); const experimentId = 'candidate-1'; f.tracker.prepareCandidate({ experimentId, runId: f.request.runId, ordinal: 1, kind: 'candidate', parentCommit: best.commit, command: 'node', args: [], annotation: { trust: 'untrusted-child-annotation', hypothesis: 'candidate hypothesis', intendedEdits: ['src/code.ts'], implementationSummary: 'candidate summary' } }, { intent: { kind: 'candidate-snapshot', experimentId, snapshot, validatedPaths: paths } }); const candidate = await commitCandidate(f.ctx, f.request.gitExecutable, f.request.identity.worktree, f.request.identity, experimentId, snapshot, paths, f.request.gitOptions); await checkoutCandidateForEvaluation(f.ctx, f.request.gitExecutable, f.request.identity.worktree, f.request.identity, candidate.candidateCommit, best.commit, f.request.gitOptions); f.tracker.recordCandidateCommit(experimentId, candidate.candidateCommit); f.tracker.transitionExperiment(experimentId, 'running'); f.tracker.transitionRun(f.request.runId, 'candidate-running'); f.tracker.checkpointExperiment(experimentId, { metric }); f.tracker.transitionRun(f.request.runId, 'deciding')
    const first = await reconcileRecovery(f.ctx, request); const second = await reconcileRecovery(f.ctx, request); expect(first).toMatchObject({ kind: 'blocked', code: 'attempt-uncertain', lock: 'retain' }); expect(second).toEqual(first); f.tracker.close()
  })
})
