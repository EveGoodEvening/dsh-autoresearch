import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { DurableTracker } from '../src/tracker.ts'
import { acquireRunLock, allocateRunWorktree, commitCandidate, discoverRepository, GitBoundaryError, makeRunGitIdentity, reconcileAcceptedHead, recoverTerminalRunLock, releaseTerminalRunLock, removeRunWorktree, runGit, snapshotCandidate, validateCandidate, type GitContext } from '../src/git.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

class Reader implements SubprocessOutputReader {
  constructor(private readonly get: () => Buffer, private readonly maxBytes: number) {}
  readFrom(fromByte: number) { const whole = this.get(); const retained = whole.subarray(Math.max(0, whole.length - this.maxBytes)); return { text: retained.toString('utf8'), nextOffset: whole.length, lossy: fromByte < whole.length - retained.length } }
}
class LocalHandle implements SubprocessHandle {
  readonly stdin = undefined; readonly stdout = undefined; readonly stderr = undefined
  readonly pid: number; readonly collected; readonly done: Promise<SubprocessOutcome>
  private exited = false
  constructor(private readonly child: ReturnType<typeof spawn>, stdout: Buffer[], stderr: Buffer[], maxOut: number, maxErr: number) {
    this.pid = child.pid ?? -1
    this.collected = { stdout: new Reader(() => Buffer.concat(stdout), maxOut), stderr: new Reader(() => Buffer.concat(stderr), maxErr) }
    this.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { this.exited = true; resolve({ exitCode, signal }) }) })
  }
  terminate(): void { if (!this.exited && this.pid > 0) { try { process.kill(-this.pid, 'SIGTERM') } catch { /* already gone */ } } }
  async waitForExit(): Promise<boolean> { await this.done; return true }
}
class LocalSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const handle = new LocalHandle(child, stdout, stderr, typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0, typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 0)
    spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
    return handle
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
function policy(mutableGlobs = ['src/**']) { return { mutableGlobs, exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], submodules: [], gitConfig: [] }, evaluation: { command: 'evaluate.mjs', args: [] }, provenance: {} } }
function faultingGit(root: string, match: string): string {
  const script = join(root, `fault-git-${Math.random().toString(16).slice(2)}.cjs`)
  const marker = `${script}.fired`
  writeFileSync(script, `#!/usr/bin/env node\nconst { existsSync, writeFileSync } = require('node:fs'); const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); if (!existsSync(${JSON.stringify(marker)}) && args.join(' ').includes(${JSON.stringify(match)})) { writeFileSync(${JSON.stringify(marker)}, '1'); process.stderr.write('injected git failure\\n'); process.exit(91) } const result = spawnSync('git', args, { stdio: 'inherit', env: process.env }); process.exit(result.status ?? 1)\n`)
  chmodSync(script, 0o700)
  return script
}

async function setupRun() {
  const f = fixture(); const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'speed', 'run-001')
  const trackerPath = join(f.root, '.tracker', 'tracker.sqlite'); mkdirSync(join(f.root, '.tracker'), { mode: 0o700 }); const tracker = DurableTracker.open(trackerPath)
  tracker.createRun({ runId: identity.runId, repositoryId: discovery.repositoryId, repository: discovery.repository, gitCommonDir: discovery.gitCommonDir, callerCwd: discovery.callerCwd, startCommit: discovery.startCommit, runTag: identity.runTag, branch: identity.branch, worktree: identity.worktree, policy: {}, policySha256: 'a'.repeat(64), provenance: {}, provenanceSha256: 'b'.repeat(64) })
  acquireRunLock(tracker, identity, discovery.repositoryId, 1); await allocateRunWorktree(f.ctx, 'git', discovery, identity, commandOptions)
  return { ...f, discovery, identity, tracker }
}

describe('host-owned Git boundary', () => {
  it('discovers repository identity read-only through scrubbed argv subprocess calls', async () => {
    const { root, ctx, subprocess } = fixture(); writeFileSync(join(root, 'dirty.txt'), 'caller work\n')
    const before = execFileSync('git', ['-C', root, 'status', '--porcelain=v1']).toString()
    const discovery = await discoverRepository(ctx, 'git', join(root, 'src'), commandOptions)
    expect(discovery.startCommit).toMatch(/^[0-9a-f]{40}$/); expect(discovery.repository).toBe(root); expect(discovery.repositoryId).toMatch(/^[0-9a-f]{64}$/)
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain=v1']).toString()).toBe(before)
    expect(subprocess.specs.every((spec) => spec.argv[0] === 'git' && spec.env?.GIT_TERMINAL_PROMPT === '0' && !('NPM_TOKEN' in (spec.env ?? {})))).toBe(true)
    expect(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain']).toString().match(/^worktree /gmu)).toHaveLength(1)
  })

  it('allocates unique run-id branch/worktree without changing dirty caller state', async () => {
    const f = fixture(); writeFileSync(join(f.root, 'src.txt'), 'caller unstaged\n'); writeFileSync(join(f.root, 'caller.tmp'), 'untracked\n'); execFileSync('git', ['-C', f.root, 'add', 'src.txt'])
    const callerHead = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD']).toString().trim(); const callerStatus = execFileSync('git', ['-C', f.root, 'status', '--porcelain=v1']).toString()
    const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'tag', 'immutable-42')
    await allocateRunWorktree(f.ctx, 'git', discovery, identity, commandOptions)
    expect(identity.branch).toContain('tag-immutable-42'); expect(identity.worktree).toContain('immutable-42')
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD']).toString().trim()).toBe(callerHead); expect(execFileSync('git', ['-C', f.root, 'status', '--porcelain=v1']).toString()).toBe(callerStatus)
  })

  it('enforces staged, unstaged, untracked, dependency, and exceptional path policy before staging', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'package.json'), '{}\n'); execFileSync('git', ['-C', f.identity.worktree, 'add', 'package.json']); writeFileSync(join(f.identity.worktree, 'src.txt'), 'unstaged\n'); writeFileSync(join(f.identity.worktree, 'secret.policy'), 'untracked\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions)
    expect(snapshot.changed.find((item) => item.path === 'package.json')?.staged).toBe(true); expect(snapshot.changed.find((item) => item.path === 'src.txt')?.unstaged).toBe(true); expect(snapshot.changed.find((item) => item.path === 'secret.policy')?.untracked).toBe(true)
    expect(() => validateCandidate(snapshot, policy(['**']))).toThrowError(GitBoundaryError)
    const dependencyOnly = { parentCommit: snapshot.parentCommit, changed: snapshot.changed.filter((item) => item.path === 'package.json'), gitConfig: snapshot.gitConfig }
    expect(validateCandidate(dependencyOnly, { ...policy(['src/**']), exceptionalAllowlists: { dependencies: ['package.json'], evaluators: [], datasets: [], submodules: [], gitConfig: [] } })).toEqual(['package.json'])
  })

  it('creates full candidate commits and audit refs, then idempotently promotes accepted HEAD', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n'); writeFileSync(join(f.identity.worktree, 'src', 'new.ts'), 'export const added = true\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const paths = validateCandidate(snapshot, policy())
    const candidate = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'exp-1', snapshot, paths, commandOptions)
    expect(candidate.parentCommit).toBe(f.discovery.startCommit); expect(candidate.candidateCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', candidate.auditRef]).toString().trim()).toBe(candidate.candidateCommit)
    await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, candidate.candidateCommit, commandOptions); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, candidate.candidateCommit, commandOptions)
    expect(execFileSync('git', ['-C', f.identity.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(candidate.candidateCommit)
  })

  it('checks promotion preconditions before publishing the accepted ref', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const candidate = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'dirty', snapshot, validateCandidate(snapshot, policy()), commandOptions)
    writeFileSync(join(f.identity.worktree, 'src', 'unpreserved.ts'), 'dirty\n')
    await expect(reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, candidate.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'accepted-reconcile-dirty' })
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', f.identity.acceptedRef]).toString().trim()).toBe(f.discovery.startCommit)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', `refs/heads/${f.identity.branch}`]).toString().trim()).toBe(candidate.candidateCommit)
    expect(execFileSync('git', ['-C', f.identity.worktree, 'rev-parse', 'HEAD']).toString().trim()).toBe(candidate.candidateCommit)
  })

  it('recovers candidate audit refs idempotently across commit/ref failure windows', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const paths = validateCandidate(snapshot, policy())

    const faulty = faultingGit(f.root, `update-ref ${f.identity.candidateRefPrefix}recover`)
    await expect(commitCandidate(f.ctx, faulty, f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' })
    const orphan = execFileSync('git', ['-C', f.identity.worktree, 'rev-parse', 'HEAD']).toString().trim()
    const recovered = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions)
    expect(recovered.candidateCommit).toBe(orphan); expect(execFileSync('git', ['-C', f.root, 'rev-parse', recovered.auditRef]).toString().trim()).toBe(orphan)
    await expect(commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'recover', snapshot, paths, commandOptions)).resolves.toEqual(recovered)
  })
  it('retries accepted-ref publication after an interrupted promotion', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const candidate = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'promote', snapshot, validateCandidate(snapshot, policy()), commandOptions)
    const faulty = faultingGit(f.root, `update-ref ${f.identity.acceptedRef}`)
    await expect(reconcileAcceptedHead(f.ctx, faulty, f.identity.worktree, f.identity, candidate.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' })
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', f.identity.acceptedRef]).toString().trim()).toBe(f.discovery.startCommit)
    await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, candidate.candidateCommit, commandOptions)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', f.identity.acceptedRef]).toString().trim()).toBe(candidate.candidateCommit)
  })

  it('recovers interrupted allocation and blocks tampered same-run resume', async () => {
    const f = fixture(); const discovery = await discoverRepository(f.ctx, 'git', f.root, commandOptions); const identity = makeRunGitIdentity({ branchPrefix: 'autoresearch/', stateRoot: 'state' }, discovery, 'resume', 'run-resume')
    const faulty = faultingGit(f.root, `update-ref ${identity.acceptedRef}`)
    await expect(allocateRunWorktree(f.ctx, faulty, discovery, identity, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' })
    await allocateRunWorktree(f.ctx, 'git', discovery, identity, commandOptions, true)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', identity.acceptedRef]).toString().trim()).toBe(discovery.startCommit)
    execFileSync('git', ['-C', identity.worktree, 'checkout', '--detach']); expect(await allocateRunWorktree(f.ctx, 'git', discovery, identity, commandOptions, true).then(() => undefined, (error: unknown) => (error as GitBoundaryError).code)).toBe('git-identity-collision')
  })

  it('rejects Git config mutation after snapshot', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); execFileSync('git', ['-C', f.identity.worktree, 'config', 'autoresearch.tampered', 'true'])
    await expect(commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'config', snapshot, validateCandidate(snapshot, policy()), commandOptions)).rejects.toMatchObject({ code: 'git-config-mutated' })
  })

  it('retains rejected candidate audit refs through later promotion and cleanup', async () => {
    const f = await setupRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 2\n')
    const firstSnapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const rejected = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'rejected', firstSnapshot, validateCandidate(firstSnapshot, policy()), commandOptions)
    execFileSync('git', ['-C', f.identity.worktree, 'reset', '--hard', f.identity.acceptedRef]); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 3\n')
    const secondSnapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, commandOptions); const accepted = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'accepted', secondSnapshot, validateCandidate(secondSnapshot, policy()), commandOptions)
    await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, accepted.candidateCommit, commandOptions); await removeRunWorktree(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', rejected.auditRef]).toString().trim()).toBe(rejected.candidateCommit)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', accepted.auditRef]).toString().trim()).toBe(accepted.candidateCommit)
  })

  it('excludes active repository/tag runs, releases only terminal quiescent locks, and cleans worktree without deleting refs', async () => {
    const f = await setupRun()
    expect(() => acquireRunLock(f.tracker, f.identity, f.discovery.repositoryId, 1)).toThrowError(GitBoundaryError)
    expect(() => releaseTerminalRunLock(f.tracker, f.identity.runId)).toThrow()
    f.tracker.transitionRun(f.identity.runId, 'cancelled', { terminalReason: 'test', quiescent: true }); expect(releaseTerminalRunLock(f.tracker, f.identity.runId)).toBe(true); expect(recoverTerminalRunLock(f.tracker, f.identity.runId)).toBe(false)
    await removeRunWorktree(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    expect(execFileSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain']).toString()).not.toContain(f.identity.worktree)
    expect(execFileSync('git', ['-C', f.root, 'rev-parse', f.identity.acceptedRef]).toString().trim()).toBe(f.discovery.startCommit); expect(f.tracker.getRun(f.identity.runId)).toBeDefined(); f.tracker.close()
  })

  it('caps output and terminates timed-out process trees before settlement', async () => {
    const { ctx, root } = fixture()
    await expect(runGit(ctx, process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { ...commandOptions, cwd: root, maxStdoutBytes: 32 })).rejects.toMatchObject({ code: 'git-output-limit' })
    const started = Date.now(); await expect(runGit(ctx, process.execPath, ['-e', "setInterval(()=>{},1000)"], { ...commandOptions, cwd: root, timeoutMs: 50 })).rejects.toMatchObject({ code: 'git-timeout' }); expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does not spawn pre-aborted Git and quiesces in-flight cancellation', async () => {
    const { ctx, root, subprocess } = fixture(); const pre = new AbortController(); pre.abort(new Error('stop'))
    await expect(runGit(ctx, process.execPath, ['-e', 'process.exit(0)'], { ...commandOptions, cwd: root, signal: pre.signal })).rejects.toMatchObject({ code: 'git-cancelled' })
    expect(subprocess.specs).toHaveLength(0)
    const active = new AbortController(); const running = runGit(ctx, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...commandOptions, cwd: root, signal: active.signal }); await new Promise((resolve) => setTimeout(resolve, 50)); active.abort(new Error('stop'))
    await expect(running).rejects.toMatchObject({ code: 'git-cancelled' }); expect(subprocess.specs).toHaveLength(1)
  })
})
