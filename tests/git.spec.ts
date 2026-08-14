import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { DurableTracker } from '../src/tracker.ts'
import { acquireControllerClaim, acquireRunLock, allocateRunWorktree, captureGitConfigBaseline, commitCandidate, discoverRepository, durableGitIdentity, GitBoundaryError, heartbeatControllerClaim, inspectRunGitState, makeRunGitIdentity, prepareCandidateTree, reconcileAcceptedHead, reconcileRejectedHead, recoverTerminalRunLock, releaseControllerClaim, releaseTerminalRunLock, removeRunWorktree, resolveGitExecutable, runGit, snapshotCandidate, validateCandidate, verifyCandidateTree, verifyExactWorktree, type GitContext } from '../src/git.ts'

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
  async resolveExecutable(command: string): Promise<string> { return execFileSync('which', [command]).toString().trim() }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec); const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: [typeof spec.stdio.stdin === 'object' ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data)
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
  writeFileSync(script, `#!/usr/bin/env node\nconst { existsSync, writeFileSync, readFileSync } = require('node:fs'); const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); const input = readFileSync(0); if (!existsSync(${JSON.stringify(marker)}) && (args.join(' ') + '\\n' + input).includes(${JSON.stringify(match)})) { writeFileSync(${JSON.stringify(marker)}, '1'); process.stderr.write('injected git failure\\n'); process.exit(91) } const result = spawnSync('git', args, { stdio: ['pipe', 'inherit', 'inherit'], input, env: process.env }); process.exit(result.status ?? 1)\n`)
  chmodSync(script, 0o700); return script
}
function markerCommand(path: string): string { return `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(path)},'ran')"` }

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
    expect(subprocess.specs.every((spec) => spec.env?.GIT_CONFIG_GLOBAL === '/dev/null' && spec.env?.GIT_TERMINAL_PROMPT === '0' && spec.env?.GIT_DIR === undefined && spec.argv.includes('core.hooksPath=/dev/null') && spec.argv.includes('core.fsmonitor=false'))).toBe(true)
    expect(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain']).toString().match(/^worktree /gmu)).toHaveLength(1)
  })

  it('resolves the configured executable through the provider and makes host controls non-overridable', async () => {
    const { root, ctx, subprocess } = fixture(); process.env.GIT_DIR = '/attacker/repository'
    try {
      const executable = await resolveGitExecutable(ctx, 'git'); expect(executable).toContain('/git')
      await expect(runGit(ctx, executable, ['rev-parse', '--is-inside-work-tree'], { ...commandOptions, cwd: root, env: { GIT_CONFIG_GLOBAL: '/attacker/config' } as never })).rejects.toThrow('Unsupported Git environment override')
      await runGit(ctx, executable, ['rev-parse', '--is-inside-work-tree'], { ...commandOptions, cwd: root, env: { GIT_INDEX_FILE: join(root, '.temporary-index') } })
      const spec = subprocess.specs.at(-1)!; expect(spec.env?.GIT_DIR).toBeUndefined(); expect(spec.env?.GIT_CONFIG_GLOBAL).toBe('/dev/null'); expect(spec.env?.GIT_INDEX_FILE).toBe(join(root, '.temporary-index'))
    } finally { delete process.env.GIT_DIR }
  })

  it('accepts bare and absolute Git executables but rejects relative paths with separators', async () => {
    const { ctx, subprocess } = fixture(); const absolute = execFileSync('which', ['git']).toString().trim()
    await expect(resolveGitExecutable(ctx, 'git')).resolves.toBe(absolute)
    await expect(resolveGitExecutable(ctx, absolute)).resolves.toBe(absolute)
    for (const configured of ['./git', 'bin/git', '..\\git']) await expect(resolveGitExecutable(ctx, configured)).rejects.toThrow('bare name or absolute path')
    expect(subprocess.specs).toHaveLength(0)
  })

  it('rejects includes and every executable config surface before helpers can run', async () => {
    for (const key of ['core.fsmonitor', 'core.hooksPath', 'filter.evil.clean', 'filter.evil.smudge', 'filter.evil.process', 'diff.evil.command', 'diff.evil.textconv', 'merge.evil.driver']) {
      const f = fixture(); const marker = join(f.root, `${key.replaceAll('.', '-')}.marker`); execFileSync('git', ['-C', f.root, 'config', key, markerCommand(marker)])
      await expect(discoverRepository(f.ctx, 'git', f.root, commandOptions)).rejects.toMatchObject({ code: 'git-config-unsafe' }); expect(existsSync(marker)).toBe(false)
    }
    const f = fixture(); const marker = join(f.root, 'included.marker'); const included = join(f.root, 'included.config'); writeFileSync(included, `[core]\n\tfsmonitor = ${markerCommand(marker)}\n`); execFileSync('git', ['-C', f.root, 'config', 'include.path', included])
    await expect(discoverRepository(f.ctx, 'git', f.root, commandOptions)).rejects.toMatchObject({ code: 'git-config-unsafe' }); expect(existsSync(marker)).toBe(false)
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
    expect(existsSync(join(first.discovery.gitCommonDir, 'dsh-autoresearch-locks.sqlite'))).toBe(true)
    expect(existsSync(join(f.root, '.tracker', 'locks.sqlite'))).toBe(false)
  })

  it('repairs authority-only acquisition, retries authority cleanup after local release, and fences controller claims', async () => {
    const f = await createRun(fixture(), 'repair', 'run-repair')
    const authorityPath = join(f.discovery.gitCommonDir, 'dsh-autoresearch-locks.sqlite')
    const authority = new DatabaseSync(authorityPath)
    f.tracker.database.prepare('DELETE FROM active_locks WHERE run_id = ?').run(f.identity.runId)
    expect(authority.prepare('SELECT run_id FROM active_locks WHERE run_id = ?').get(f.identity.runId)?.['run_id']).toBe(f.identity.runId)
    acquireRunLock(f.tracker, f.identity, f.discovery.repositoryId, 2)
    expect(f.tracker.recoveryState(f.identity.runId).activeLock).toBeDefined()

    const liveIdentity = { pid: process.pid, startToken: readFileSync(`/proc/${process.pid}/stat`, 'utf8').slice(readFileSync(`/proc/${process.pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[19]! }
    const first = acquireControllerClaim(f.tracker, f.identity.runId, 'owner-a', 1_000, new Date('2026-01-01T00:00:00.000Z'), liveIdentity)
    expect(first).toMatchObject({ ownerId: 'owner-a', pid: process.pid, startToken: liveIdentity.startToken })
    expect(() => acquireControllerClaim(f.tracker, f.identity.runId, 'owner-b', 1_000, new Date('2026-01-01T00:00:00.500Z'), liveIdentity)).toThrowError(expect.objectContaining({ code: 'run-controller-active' }))
    expect(heartbeatControllerClaim(f.tracker, f.identity.runId, 'owner-a', 1_000, new Date('2026-01-01T00:00:00.750Z'), liveIdentity).ownerId).toBe('owner-a')
    expect(() => acquireControllerClaim(f.tracker, f.identity.runId, 'owner-b', 1_000, new Date('2026-01-01T00:00:02.000Z'), liveIdentity)).toThrowError(expect.objectContaining({ code: 'run-controller-active' }))
    authority.prepare('UPDATE controller_claims SET owner_start_token = ? WHERE run_id = ?').run(`${BigInt(liveIdentity.startToken) + 1n}`, f.identity.runId)
    const replacement = acquireControllerClaim(f.tracker, f.identity.runId, 'owner-b', 1_000, new Date('2026-01-01T00:00:02.000Z'), liveIdentity)
    expect(replacement.ownerId).toBe('owner-b')
    expect(() => heartbeatControllerClaim(f.tracker, f.identity.runId, 'owner-a', 1_000, new Date(), liveIdentity)).toThrowError(expect.objectContaining({ code: 'run-controller-claim-lost' }))
    expect(releaseControllerClaim(f.tracker, f.identity.runId, 'owner-a', liveIdentity)).toBe(false)
    expect(releaseControllerClaim(f.tracker, f.identity.runId, 'owner-b', { pid: replacement.pid, startToken: replacement.startToken })).toBe(true)

    f.tracker.transitionRun(f.identity.runId, 'cancelled', { terminalReason: 'done', quiescent: true })
    expect(releaseTerminalRunLock(f.tracker, f.identity.runId)).toBe(true)
    authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(f.discovery.repositoryId, f.identity.runTag, f.identity.runId, new Date().toISOString())
    expect(recoverTerminalRunLock(f.tracker, f.identity.runId)).toBe(true)
    expect(authority.prepare('SELECT 1 FROM active_locks WHERE run_id = ?').get(f.identity.runId)).toBeUndefined()
    authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run('wrong-repository', f.identity.runTag, f.identity.runId, new Date().toISOString())
    expect(() => recoverTerminalRunLock(f.tracker, f.identity.runId)).toThrowError(expect.objectContaining({ code: 'run-lock-identity' }))
    expect(authority.prepare('SELECT repository_id FROM active_locks WHERE run_id = ?').get(f.identity.runId)?.['repository_id']).toBe('wrong-repository')
    authority.close()
  })

  it('enforces staged, unstaged, untracked, rename, dependency, and protected policy', async () => {
    const f = await createRun(); writeFileSync(join(f.identity.worktree, 'package.json'), '{}\n'); execFileSync('git', ['-C', f.identity.worktree, 'add', 'package.json']); writeFileSync(join(f.identity.worktree, 'src.txt'), 'unstaged\n'); writeFileSync(join(f.identity.worktree, 'policy.txt'), 'untracked\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions); expect(snapshot.changed.find((item) => item.path === 'src.txt')?.unstaged).toBe(true)
    expect(() => validateCandidate(snapshot, policy(['**']))).toThrowError(expect.objectContaining({ code: 'candidate-policy-violation', evidence: expect.arrayContaining(['package.json: protected surface', 'policy.txt: protected surface']) }))
    const dependency = { ...snapshot, changed: snapshot.changed.filter((item) => item.path === 'package.json') }; expect(validateCandidate(dependency, { ...policy(), exceptionalAllowlists: { dependencies: ['package.json'], evaluators: [], datasets: [], submodules: [], gitConfig: [] } })).toEqual(['package.json'])
    execFileSync('git', ['-C', f.identity.worktree, 'reset', '--hard']); execFileSync('git', ['-C', f.identity.worktree, 'mv', 'src/code.ts', 'forbidden.policy']); const rename = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)
    expect(() => validateCandidate(rename, policy(['src/**']))).toThrowError(expect.objectContaining({ evidence: expect.arrayContaining(['forbidden.policy: outside mutable paths']) }))
  })

  it('enumerates ignored untracked paths separately and requires policy permission before publication', async () => {
    const base = fixture(); writeFileSync(join(base.root, '.gitignore'), 'ignored/**\n'); execFileSync('git', ['-C', base.root, 'add', '.gitignore']); execFileSync('git', ['-C', base.root, 'commit', '-m', 'ignore generated paths'])
    const f = await createRun(base); mkdirSync(join(f.identity.worktree, 'ignored')); writeFileSync(join(f.identity.worktree, 'ignored', 'cache.bin'), 'candidate data\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)
    expect(snapshot.changed).toEqual([]); expect(snapshot.ignoredUntracked).toEqual(['ignored/cache.bin'])
    expect(() => validateCandidate(snapshot, policy())).toThrowError(expect.objectContaining({ code: 'candidate-policy-violation', evidence: ['ignored/cache.bin: ignored untracked path not allowlisted'] }))
    const allowedPaths = validateCandidate(snapshot, policy(['src/**', 'ignored/**'])); expect(allowedPaths).toEqual(['ignored/cache.bin'])
    const committed = await commitCandidate(f.ctx, 'git', f.identity.worktree, f.identity, 'ignored', snapshot, allowedPaths, commandOptions)
    expect(execFileSync('git', ['-C', f.root, 'show', `${committed.candidateCommit}:ignored/cache.bin`]).toString()).toBe('candidate data\n')
  })

  it('names an unstaged protected path and state in policy evidence', async () => {
    const base = fixture(); writeFileSync(join(base.root, 'package.json'), '{}\n'); execFileSync('git', ['-C', base.root, 'add', 'package.json']); execFileSync('git', ['-C', base.root, 'commit', '-m', 'add package manifest']); const f = await createRun(base)
    writeFileSync(join(f.identity.worktree, 'package.json'), '{"changed":true}\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions); expect(snapshot.changed.find((item) => item.path === 'package.json')).toMatchObject({ staged: false, unstaged: true, untracked: false })
    expect(() => validateCandidate(snapshot, policy(['**']))).toThrowError(expect.objectContaining({ code: 'candidate-policy-violation', evidence: expect.arrayContaining(['package.json: protected surface']) }))
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
    const marker = join(f.root, 'worktree-fsmonitor.marker'); execFileSync('git', ['-C', f.identity.worktree, 'config', '--worktree', 'core.fsmonitor', markerCommand(marker)]); await expect(captureGitConfigBaseline(f.ctx, 'git', f.identity.worktree, policy(), commandOptions)).rejects.toMatchObject({ code: 'git-config-unsafe' }); expect(existsSync(marker)).toBe(false); execFileSync('git', ['-C', f.identity.worktree, 'config', '--worktree', '--unset-all', 'core.fsmonitor'])
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
  it('prepares and verifies a complete candidate tree without publishing refs or moving HEAD', async () => {
    const f = await createRun(); writeFileSync(join(f.identity.worktree, 'src', 'code.ts'), 'export const n = 7\n')
    const snapshot = await snapshotCandidate(f.ctx, 'git', f.identity.worktree, f.gitConfig, commandOptions)
    const before = await inspectRunGitState(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    const prepared = await prepareCandidateTree(f.ctx, 'git', f.identity.worktree, f.identity, 'prepared', snapshot, validateCandidate(snapshot, policy()), commandOptions)
    const after = await inspectRunGitState(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    expect(after).toEqual(before)
    expect(() => ref(f.root, prepared.auditRef)).toThrow()
    expect(ref(f.identity.worktree, 'HEAD')).toBe(snapshot.parentCommit)
    await expect(verifyCandidateTree(f.ctx, 'git', f.identity.worktree, 'prepared', snapshot, prepared, commandOptions)).resolves.toBeUndefined()
  })


  it('promotes with restart recovery and leaves every identity unchanged on failed preconditions', async () => {
    const f = await createRun(); const accepted = f.discovery.startCommit; const c = await candidate(f, 'promote', 'export const n = 2\n'); writeFileSync(join(f.identity.worktree, 'unrelated.tmp'), 'dirty\n')
    await expect(reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'accepted-reconcile-dirty' }); assertState(f, accepted)
    rmSync(join(f.identity.worktree, 'unrelated.tmp')); const faulty = faultingGit(f.root, `update ${f.identity.acceptedRef}`); await expect(reconcileAcceptedHead(f.ctx, faulty, f.identity.worktree, f.identity, c.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' })
    assertState(f, accepted); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions); assertState(f, c.candidateCommit)
    await verifyExactWorktree(f.ctx, 'git', f.identity.worktree, c.candidateCommit, commandOptions)
  })

  it('explicitly rejects candidates idempotently while retaining audit refs', async () => {
    const f = await createRun(); const rejected = await candidate(f, 'rejected', 'export const n = 2\n'); await reconcileRejectedHead(f.ctx, 'git', f.identity.worktree, f.identity, rejected.candidateCommit, f.discovery.startCommit, commandOptions); await reconcileRejectedHead(f.ctx, 'git', f.identity.worktree, f.identity, rejected.candidateCommit, f.discovery.startCommit, commandOptions); assertState(f, f.discovery.startCommit)
    const accepted = await candidate(f, 'accepted', 'export const n = 3\n'); await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, accepted.candidateCommit, commandOptions); await removeRunWorktree(f.ctx, 'git', f.discovery, f.identity, commandOptions)
    expect(ref(f.root, rejected.auditRef)).toBe(rejected.candidateCommit); expect(ref(f.root, accepted.auditRef)).toBe(accepted.candidateCommit)
  })

  it('converges after faults at every acceptance and rejection mutation while retaining detached audits', async () => {
    for (const [ordinal, step] of ['read-tree --reset -u', 'update-ref --stdin'].entries()) {
      const f = await createRun(fixture(), `accept-${ordinal}`, `run-accept-${ordinal}`); const c = await candidate(f, 'candidate', 'export const n = 2\n'); const faulty = faultingGit(f.root, step)
      await expect(reconcileAcceptedHead(f.ctx, faulty, f.identity.worktree, f.identity, c.candidateCommit, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' }); expect(ref(f.root, c.auditRef)).toBe(c.candidateCommit); expect(ref(f.root, f.identity.acceptedRef)).toBe(f.discovery.startCommit)
      await reconcileAcceptedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, commandOptions); assertState(f, c.candidateCommit)
    }
    for (const [ordinal, step] of ['read-tree --reset -u', 'clean -ffdx'].entries()) {
      const f = await createRun(fixture(), `reject-${ordinal}`, `run-reject-${ordinal}`); const c = await candidate(f, 'candidate', 'export const n = 2\n'); writeFileSync(join(f.identity.worktree, '.ignored-extra'), 'extra'); writeFileSync(join(f.identity.worktree, '.gitignore'), '.ignored-extra\n')
      const faulty = faultingGit(f.root, step); await expect(reconcileRejectedHead(f.ctx, faulty, f.identity.worktree, f.identity, c.candidateCommit, f.discovery.startCommit, commandOptions)).rejects.toMatchObject({ code: 'git-command-failed' }); expect(ref(f.root, c.auditRef)).toBe(c.candidateCommit)
      await reconcileRejectedHead(f.ctx, 'git', f.identity.worktree, f.identity, c.candidateCommit, f.discovery.startCommit, commandOptions); assertState(f, f.discovery.startCommit); expect(existsSync(join(f.identity.worktree, '.ignored-extra'))).toBe(false); expect(existsSync(join(f.identity.worktree, '.gitignore'))).toBe(false)
    }
  })

  it('repairs same-run lock checkpoints, releases only terminal quiescent locks, and cleanup preserves refs', async () => {
    const f = await createRun(); expect(() => acquireRunLock(f.tracker, f.identity, f.discovery.repositoryId, 2)).not.toThrow(); expect(() => releaseTerminalRunLock(f.tracker, f.identity.runId)).toThrow()
    f.tracker.transitionRun(f.identity.runId, 'cancelled', { terminalReason: 'test', quiescent: true }); expect(releaseTerminalRunLock(f.tracker, f.identity.runId)).toBe(true); expect(recoverTerminalRunLock(f.tracker, f.identity.runId)).toBe(false)
    expect(releaseTerminalRunLock(f.tracker, f.identity.runId)).toBe(false)
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
