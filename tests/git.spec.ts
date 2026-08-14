import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { DurableTracker } from '../src/tracker.ts'
import { acquireRunLock, allocateRunWorktree, captureGitConfigBaseline, commitCandidate, discoverRepository, durableGitIdentity, GitBoundaryError, makeRunGitIdentity, reconcileAcceptedHead, reconcileRejectedHead, recoverTerminalRunLock, releaseTerminalRunLock, removeRunWorktree, runGit, snapshotCandidate, validateCandidate, type GitContext } from '../src/git.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

class Reader implements SubprocessOutputReader {
  constructor(private readonly get: () => Buffer, private readonly maxBytes: number) {}
  readFrom(fromByte: number) { const whole = this.get(); const retained = whole.subarray(Math.max(0, whole.length - this.maxBytes)); return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length } }
}
class LocalHandle implements SubprocessHandle {
  readonly stdin = undefined; readonly stdout = undefined; readonly stderr = undefined; readonly pid: number; readonly collected; readonly done: Promise<SubprocessOutcome>
  terminateCalls = 0; waitCalls = 0; exited = false
  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], maxOut: number, maxErr: number) {
    this.pid = child.pid ?? -1; this.collected = { stdout: new Reader(() => Buffer.concat(stdout), maxOut), stderr: new Reader(() => Buffer.concat(stderr), maxErr) }
    this.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { this.exited = true; resolve({ exitCode, signal }) }) })
  }
  terminate(): void { this.terminateCalls++; if (!this.exited && this.pid > 0) { try { process.kill(-this.pid, 'SIGTERM') } catch {} } }
  async waitForExit(): Promise<boolean> { this.waitCalls++; await this.done; return true }
}
class LocalSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []; readonly handles: LocalHandle[] = []
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec); const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const handle = new LocalHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
    this.handles.push(handle); spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true }); return handle
  }
}

const commandOptions = { timeoutMs: 5_000, graceMs: 100, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-git-')); roots.push(root)
  execFileSync('git', ['init', '-b', 'main', root]); execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(root, 'src.txt'), 'base\n'); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'code.ts'), 'export const n = 1\n')
  execFileSync('git', ['-C', root, 'add', 'src.txt', 'src/code.ts']); execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  const subprocess = new LocalSubprocess(); return { root, subprocess, ctx: { subprocess } as unknown as GitContext }
}
function policy(mutableGlobs = ['src/**'], gitConfig: string[] = []) { return { mutableGlobs, exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], submodules: [], gitConfig }, evaluation: { command: 'evaluate.mjs', args: [] }, provenance: {} } }
function faultingGit(root: string, match: string): string {
  const script = join(root, `fault-git-${Math.random().toString(16).slice(2)}.cjs`); const marker = `${script}.fired`
  writeFileSync(script, `#!/usr/bin/env node\nconst { existsSync, writeFileSync } = require('node:fs'); const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); if (!existsSync(${JSON.stringify(marker)}) && args.join(' ').includes(${JSON.stringify(match)})) { writeFileSync(${JSON.stringify(marker)}, '1'); process.stderr.write('injected git failure\\n'); process.exit(91) } const result = spawnSync('git', args, { stdio: 'inherit', env: process.env }); process.exit(result.status ?? 1)\n`)
  chmodSync(script, 0o700); return script
}
function ref(root: string, name: string): string { return execFileSync('git', ['-C', root, 'rev-parse', '--verify', name]).toString().trim() }
async function createRun(f = fixture(), runTag = 'speed', runId = 'run-001', limit = 2) {
  const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, runTag, runId)
  const trackerPath = join(f.root, '.tracker', `${runId}.sqlite`); mkdirSync(join(f.root, '.tracker'), { recursive: true, mode: 0o700 }); const tracker = DurableTracker.open(trackerPath)
  tracker.createRun({ runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag, branch: identity.branch, worktree: identity.worktree, policy: {}, policySha256: 'a'.repeat(64), provenance: {}, provenanceSha256: 'b'.repeat(64) })
  acquireRunLock(tracker, identity, discovery.repositoryId, limit); await allocateRunWorktree(f.ctx, 'git', discovery, identity, durableGitIdentity(tracker, runId), commandOptions)
  const gitConfig = await captureGitConfigBaseline(f.ctx, 'git', identity.worktree, policy(), commandOptions)
  return { ...f, discovery, identity, tracker, gitConfig }
}
async function candidate(f: Awaited<ReturnType<typeof createRun>>, id: string, source: string) {
  writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), source); const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)
  return commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, id, snapshot, validateCandidate(snapshot, policy()), commandOptions)
}

function assertState(f: Awaited<ReturnType<typeof createRun>>, expected: string) {
  expect(ref(f.root, f.identity.acceptedRef)).toBe(expected); expect(ref(f.root, `refs/heads/${f.identity.branch}`)).toBe(expected); expect(ref(f.identity.worktree, 'HEAD')).toBe(expected)
}

describe('host-owned Git boundary', () => {
  it('discovers repository identity read-only through scrubbed argv calls', async () => {
    const { root, ctx, subprocess } = fixture(); writeFileSync(join(root, 'dirty.txt'), 'caller work\n'); const before = execFileSync('git', ['-C', root, 'status', '--porcelain=v1']).toString()
    const discovery = await discoverRepository(ctx, 'git', join(root, 'src'), commandOptions)
    expect(discovery.startCommit).toMatch(/^[0-9a-f]{40}$/); expect(discovery.repository).toBe(root); expect(execFileSync('git', ['-C', root, 'status', '--porcelain=v1']).toString()).toBe(before)
    expect(subprocess.specs.every((spec) => spec.env?.GIT_CONFIG_GLOBAL === '/dev/null' && spec.env?.GIT_TERMINAL_PROMPT === '0' && spec.argv.includes('core.hooksPath=/dev/null'))).toBe(true)
    expect(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain']).toString().match(/^worktree /gmu)).toHaveLength(1)
  })

  it('binds allocation to durable immutable identity and preserves dirty caller state', async () => {
    const f = fixture(); writeFileSync(join(f.root, 'src.txt'), 'caller staged\n'); execFileSync('git', ['-C', f.root, 'add', 'src.txt']); writeFileSync(join(f.root, 'caller.tmp'), 'untracked\n')
    const callerHead = ref(f.root, 'HEAD'); const callerStatus = execFileSync('git', ['-C', f.root, 'status', '--porcelain=v1']).toString(); const run = await createRun(f)
    expect(ref(f.root, 'HEAD')).toBe(callerHead); expect(execFileSync('git', ['-C', f.root, 'status', '--porcelain=v1']).toString().replace('?? .tracker/\n', '')).toBe(callerStatus); assertState(run, run.discovery.startCommit)
    await expect(allocateRunWorktree(f.ctx, 'git', run.discovery, run.identity, { ...durableGitIdentity(run.tracker, run.identity.runId), startCommit: 'f'.repeat(40) }, commandOptions, true)).rejects.toMatchObject({ code: 'git-durable-identity-mismatch' })
  })

  it('rejects allocation collision dimensions and repairs only pristine missing accepted ref', async () => {
    const f = fixture(); const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'resume', 'run-resume')
    const trackerPath = join(f.root, '.tracker', 'resume.sqlite'); mkdirSync(join(f.root, '.tracker'), { recursive: true, mode: 0o700 }); chmodSync(join(f.root, '.tracker'), 0o700); const tracker = DurableTracker.open(trackerPath)
    tracker.createRun({ runId: identity.runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag: identity.runTag, branch: identity.branch, worktree: identity.worktree, policy: {}, policySha256: 'a'.repeat(64), provenance: {}, provenanceSha256: 'b'.repeat(64) })
    const durable = durableGitIdentity(tracker, identity.runId); const faulty = faultingGit(f.root, `update-ref ${identity.acceptedRef}`)
    await expect(allocateRunWorktree(f.ctx, faulty, discovery, identity, durable, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' }); await allocateRunWorktree(f.ctx, 'git', discovery, identity, durable, commandOptions, true)
    execFileSync('git', ['-C', identity.worktree, 'checkout', '--detach']); await expect(allocateRunWorktree(f.ctx, 'git', discovery, identity, durable, commandOptions, true)).rejects.toMatchObject({ code: 'git-identity-collision' })
    execFileSync('git', ['-C', identity.worktree, 'checkout', identity.branch]); const blob = execFileSync('git', ['-C', f.root, 'hash-object', 'src.txt']).toString().trim(); execFileSync('git', ['-C', f.root, 'update-ref', identity.acceptedRef, blob])
    await expect(allocateRunWorktree(f.ctx, 'git', discovery, identity, durable, commandOptions, true)).rejects.toMatchObject({ code: 'git-resume-mismatch' })
  })

  it('blocks branch-only, registered-only, wrong-path, and wrong-branch allocation collisions', async () => {
    for (const kind of ['branch-only', 'registered-only', 'wrong-path', 'wrong-branch'] as const) {
      const f = fixture(); const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'collision', `run-${kind}`)
      const trackerPath = join(f.root, '.tracker', `${kind}.sqlite`); mkdirSync(join(f.root, '.tracker'), { recursive: true, mode: 0o700 }); chmodSync(join(f.root, '.tracker'), 0o700); const tracker = DurableTracker.open(trackerPath)
      tracker.createRun({ runId: identity.runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag: identity.runTag, branch: identity.branch, worktree: identity.worktree, policy: {}, policySha256: 'a'.repeat(64), provenance: {}, provenanceSha256: 'b'.repeat(64) })
      if (kind === 'branch-only') execFileSync('git', ['-C', f.root, 'branch', identity.branch, discovery.startCommit])
      if (kind === 'registered-only') execFileSync('git', ['-C', f.root, 'worktree', 'add', '--detach', identity.worktree, discovery.startCommit])
      if (kind === 'wrong-path') execFileSync('git', ['-C', f.root, 'worktree', 'add', '-b', identity.branch, `${identity.worktree}-wrong`, discovery.startCommit])
      if (kind === 'wrong-branch') execFileSync('git', ['-C', f.root, 'worktree', 'add', '-b', `${identity.branch}-wrong`, identity.worktree, discovery.startCommit])
      await expect(allocateRunWorktree(f.ctx, 'git', discovery, identity, durableGitIdentity(tracker, identity.runId), commandOptions, true)).rejects.toMatchObject({ code: 'git-identity-collision' })
      tracker.close()
    }
  })

  it('allows tag reuse after terminal release and independent active run tags', async () => {
    const f = fixture(); const first = await createRun(f, 'same', 'run-a', 3); first.tracker.transitionRun(first.identity.runId, 'cancelled', { terminalReason: 'done', quiescent: true }); expect(releaseTerminalRunLock(first.tracker, first.identity.runId)).toBe(true)
    const second = await createRun(f, 'same', 'run-b', 3); const third = await createRun(f, 'other', 'run-c', 3)
    expect(new Set([first.identity.worktree, second.identity.worktree, third.identity.worktree]).size).toBe(3); expect(second.identity.branch).not.toBe(first.identity.branch); assertState(second, second.discovery.startCommit); assertState(third, third.discovery.startCommit)
  })

  it('enforces staged, unstaged, untracked, rename, dependency, and protected policy', async () => {
    const f = await createRun(); writeFileSync(join(f.identity.worktree, 'package.json'), '{}\n'); execFileSync('git', ['-C', f.identity.worktree, 'add', 'package.json']); writeFileSync(join(f.identity.worktree, 'src.txt'), 'unstaged\n'); writeFileSync(join(f.identity.worktree, 'policy.txt'), 'untracked\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions); expect(snapshot.changed.find((item) => item.path === 'src.txt')?.unstaged).toBe(true)
    expect(() => validateCandidate(snapshot, policy(['**']))).toThrowError(expect.objectContaining({ code: 'candidate-policy-violation', evidence: expect.arrayContaining(['package.json: protected surface', 'policy.txt: protected surface']) }))
    const dependency = { ...snapshot, changed: snapshot.changed.filter((item) => item.path === 'package.json') }; expect(validateCandidate(dependency, { ...policy(), exceptionalAllowlists: { dependencies: ['package.json'], evaluators: [], datasets: [], submodules: [], gitConfig: [] } })).toEqual(['package.json'])
    execFileSync('git', ['-C', f.identity.worktree, 'reset', '--hard']); execFileSync('git', ['-C', f.identity.worktree, 'mv', 'src/code.ts', 'forbidden.policy']); const rename = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)
    expect(() => validateCandidate(rename, policy(['src/**']))).toThrowError(expect.objectContaining({ evidence: expect.arrayContaining(['forbidden.policy: outside mutable paths']) }))
  })

  it('denies and narrowly allows real submodule gitlink changes', async () => {
    const f = await createRun(); execFileSync('git', ['-C', f.identity.worktree, 'update-index', '--add', '--cacheinfo', '160000', f.discovery.startCommit, 'vendor/sub'])
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions); expect(snapshot.changed[0]?.submodule).toBe(true); expect(() => validateCandidate(snapshot, policy(['**']))).toThrowError(expect.objectContaining({ code: 'candidate-policy-violation' }))
    const allowed = { ...policy(), exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], submodules: ['vendor/sub'], gitConfig: [] } }; expect(validateCandidate(snapshot, allowed)).toEqual(['vendor/sub'])
  })

  it('captures common/worktree config baseline, applies exact allowlist, and rejects hooks or filters', async () => {
    const f = await createRun(); execFileSync('git', ['-C', f.identity.worktree, 'config', 'autoresearch.changed', 'true'])
    await expect(snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)).rejects.toMatchObject({ code: 'git-config-mutated', evidence: ['.git/config'] })
    const allowed = await captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(['src/**'], ['.git/config']), commandOptions); execFileSync('git', ['-C', f.identity.worktree, 'config', 'autoresearch.changed', 'again']); await expect(snapshotCandidate(f.ctx, 'git', f.identity.worktree, allowed, commandOptions)).resolves.toBeDefined()
    execFileSync('git', ['-C', f.identity.worktree, 'config', 'filter.evil.clean', 'touch /tmp/evil']); await expect(captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(['src/**'], ['.git/config']), commandOptions)).rejects.toMatchObject({ code: 'git-config-unsafe' })
    execFileSync('git', ['-C', f.identity.worktree, 'config', '--unset-all', 'filter.evil.clean']); execFileSync('git', ['-C', f.identity.worktree, 'config', 'extensions.worktreeConfig', 'true'])
    const worktreeBaseline = await captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(), commandOptions); execFileSync('git', ['-C', f.identity.worktree, 'config', '--worktree', 'autoresearch.worktree', 'changed'])
    await expect(snapshotCandidate(f.ctx, 'git', f.identity.worktree, worktreeBaseline, commandOptions)).rejects.toMatchObject({ code: 'git-config-mutated', evidence: ['.git/config.worktree'] })
    const allowedWorktree = await captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(['src/**'], ['.git/config.worktree']), commandOptions); execFileSync('git', ['-C', f.identity.worktree, 'config', '--worktree', 'autoresearch.worktree', 'again']); await expect(snapshotCandidate(f.ctx, 'git', f.identity.worktree, allowedWorktree, commandOptions)).resolves.toBeDefined()
    expect(() => policy(['src/**'], ['config'])).not.toThrow(); await expect(captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(['src/**'], ['config']), commandOptions)).rejects.toMatchObject({ code: 'git-config-allowlist-invalid' })
  })

  it('deterministically recovers commit-tree candidate before and after audit publication without moving HEAD', async () => {
    const f = await createRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n'); const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions); const paths = validateCandidate(snapshot, policy()); const before = ref(f.identity.worktree, 'HEAD')
    const faulty = faultingGit(f.root, `update-ref ${f.identity.candidateRefPrefix}recover`); await expect(commitCandidate(f.ctx, faulty, f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' }); expect(ref(f.identity.worktree, 'HEAD')).toBe(before)
    const recovered = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions); expect(recovered.candidateCommit).not.toBe(before); expect(ref(f.root, recovered.auditRef)).toBe(recovered.candidateCommit); await expect(commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions)).resolves.toEqual(recovered)
  })

  it('promotes with restart recovery and leaves every identity unchanged on failed preconditions', async () => {
    const f = await createRun(); const accepted = f.discovery.startCommit; const c = await candidate(f, 'promote', 'export const n = 2\n'); writeFileSync(join(f.identity.worktree, 'unrelated.tmp'), 'dirty\n')
    await expect(reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'accepted-reconcile-dirty' }); assertState(f, accepted)
    rmSync(join(f.identity.worktree, 'unrelated.tmp')); const faulty = faultingGit(f.root, `update-ref ${f.identity.acceptedRef}`); await expect(reconcileAcceptedHead(f.ctx, faulty, f.identity.worktree, f.identity, c.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' })
    expect(ref(f.root, f.identity.acceptedRef)).toBe(accepted); expect(ref(f.root, `refs/heads/${f.identity.branch}`)).toBe(c.candidateCommit); expect(ref(f.identity.worktree, 'HEAD')).toBe(c.candidateCommit)
    await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions); assertState(f, c.candidateCommit)
  })

  it('explicitly rejects candidates idempotently while retaining audit refs', async () => {
    const f = await createRun(); const rejected = await candidate(f, 'rejected', 'export const n = 2\n'); await reconcileRejectedHead(f.ctx, 'git', f.identity.worktree, f.identity, rejected.candidateCommit, f.discovery.startCommit, commandOptions); await reconcileRejectedHead(f.ctx, 'git', f.identity.worktree, f.identity, rejected.candidateCommit, f.discovery.startCommit, commandOptions); assertState(f, f.discovery.startCommit)
    const accepted = await candidate(f, 'accepted', 'export const n = 3\n'); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, accepted.candidateCommit, commandOptions); await removeRunWorktree(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    expect(ref(f.root, rejected.auditRef)).toBe(rejected.candidateCommit); expect(ref(f.root, accepted.auditRef)).toBe(accepted.candidateCommit)
  })

  it('releases only terminal quiescent locks and cleanup preserves refs', async () => {
    const f = await createRun(); expect(() => acquireRunLock(f.tracker, f.identity, f.discovery.repositoryId, 2)).toThrowError(GitBoundaryError); expect(() => releaseTerminalRunLock(f.tracker, f.identity.runId)).toThrow()
    f.tracker.transitionRun(f.identity.runId, 'cancelled', { terminalReason: 'test', quiescent: true }); expect(releaseTerminalRunLock(f.tracker, f.identity.runId)).toBe(true); expect(recoverTerminalRunLock(f.tracker, f.identity.runId)).toBe(false)
    await removeRunWorktree(f.ctx, 'git', f.discovery, f.identity, commandOptions); expect(execFileSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain']).toString()).not.toContain(f.identity.worktree); expect(ref(f.root, f.identity.acceptedRef)).toBe(f.discovery.startCommit)
  })

  it('caps both streams and terminates timed-out process trees before settlement', async () => {
    const { ctx, root, subprocess } = fixture(); await expect(runGit(ctx, process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { ...commandOptions, cwd: root, maxStdoutBytes: 32 })).rejects.toMatchObject({ code: 'git-output-limit' }); await expect(runGit(ctx, process.execPath, ['-e', "process.stderr.write('x'.repeat(10000))"], { ...commandOptions, cwd: root, maxStderrBytes: 32 })).rejects.toMatchObject({ code: 'git-output-limit' })
    await expect(runGit(ctx, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...commandOptions, cwd: root, timeoutMs: 50 })).rejects.toMatchObject({ code: 'git-timeout' }); expect(subprocess.handles.at(-1)?.terminateCalls).toBeGreaterThan(0); expect(subprocess.handles.at(-1)?.waitCalls).toBeGreaterThan(0); expect(subprocess.handles.at(-1)?.exited).toBe(true)
  })

  it('atomically blocks the listener-registration abort race and quiesces repeated cancellation', async () => {
    const { ctx, root, subprocess } = fixture(); const controller = new AbortController(); let reads = 0
    const racingSignal = new Proxy(controller.signal, { get(target, property, receiver) { if (property === 'aborted') { reads++; return reads === 1 ? false : true } if (property === 'addEventListener') return (...args: Parameters<AbortSignal['addEventListener']>) => { Reflect.apply(target.addEventListener, target, args); controller.abort(new Error('race')) }; const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value } })
    await expect(runGit(ctx, process.execPath, ['-e', 'process.exit(0)'], { ...commandOptions, cwd: root, signal: racingSignal })).rejects.toMatchObject({ code: 'git-cancelled' }); expect(subprocess.specs).toHaveLength(0)
    const active = new AbortController(); const running = runGit(ctx, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...commandOptions, cwd: root, signal: active.signal }); await new Promise((resolve) => setTimeout(resolve, 50)); active.abort(new Error('stop')); active.abort(new Error('again'))
    await expect(running).rejects.toMatchObject({ code: 'git-cancelled' }); expect(subprocess.handles[0]?.terminateCalls).toBeGreaterThan(0); expect(subprocess.handles[0]?.exited).toBe(true)
  })
})
