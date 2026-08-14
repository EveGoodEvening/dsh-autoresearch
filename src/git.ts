import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.js'
import type { NormalizedRunPolicy } from './types.js'
import { DurableTracker } from './tracker.js'
const FULL_SHA = /^[0-9a-f]{40}$/u
const PROTECTED_DEFAULTS = ['.git', '.gitmodules', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'cordis.patch.yml'] as const

export class GitBoundaryError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: readonly string[] = []) { super(message); this.name = 'GitBoundaryError' }
}
export interface GitContext { readonly subprocess: Pick<SubprocessRuntime, 'spawn'> }
export interface GitCommandOptions { readonly cwd: string; readonly timeoutMs: number; readonly graceMs: number; readonly maxStdoutBytes: number; readonly maxStderrBytes: number; readonly signal?: AbortSignal; readonly env?: Readonly<Record<string, string | undefined>> }
export interface GitCommandResult { readonly argv: readonly string[]; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean }
export interface RepositoryDiscovery { readonly repository: string; readonly callerCwd: string; readonly gitCommonDir: string; readonly repositoryId: string; readonly startCommit: string }
export interface RunGitIdentity { readonly runId: string; readonly runTag: string; readonly branch: string; readonly worktree: string; readonly acceptedRef: string; readonly candidateRefPrefix: string }
export interface ChangedPath { readonly path: string; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean; readonly submodule: boolean }
export interface CandidateSnapshot { readonly parentCommit: string; readonly changed: readonly ChangedPath[] }
export interface CandidateCommit { readonly parentCommit: string; readonly candidateCommit: string; readonly auditRef: string; readonly changedPaths: readonly string[] }

export async function runGit(ctx: GitContext, executable: string, args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
  if (options.graceMs <= 0 || !Number.isFinite(options.graceMs)) throw new TypeError('Git termination grace must be positive')
  if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) throw new TypeError('Git timeout must be positive')
  const deadline = new AbortController()
  const onAbort = () => deadline.abort(options.signal?.reason ?? new Error('Git command cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => deadline.abort(new Error('Git command timed out')), options.timeoutMs)
  let handle: SubprocessHandle | undefined
  let outcome: SubprocessOutcome
  try {
    handle = ctx.subprocess.spawn({ argv: [executable, ...args], cwd: options.cwd, graceMs: options.graceMs, signal: deadline.signal, env: { ...scrubbedParentEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...options.env }, stdio: { stdin: 'ignore', stdout: { maxBytes: options.maxStdoutBytes }, stderr: { maxBytes: options.maxStderrBytes } } })
    outcome = await handle.done
    await handle.waitForExit()
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort)
    if (handle && deadline.signal.aborted) { handle.terminate(); await handle.waitForExit() }
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout?.lossy || stderr?.lossy) throw new GitBoundaryError('git-output-limit', 'Git output exceeded configured byte cap', [stdout?.spillPath, stderr?.spillPath].filter((value): value is string => Boolean(value)))
  const result = { argv: [executable, ...args], stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', exitCode: outcome.exitCode, signal: outcome.signal, timedOut: deadline.signal.aborted && !options.signal?.aborted }
  if (result.exitCode !== 0) throw new GitBoundaryError(result.timedOut ? 'git-timeout' : options.signal?.aborted ? 'git-cancelled' : 'git-command-failed', `Git command failed: ${args.join(' ')}: ${result.stderr.trim()}`, [result.stdout, result.stderr])
  return result
}

export async function discoverRepository(ctx: GitContext, executable: string, requestedPath: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<RepositoryDiscovery> {
  const callerCwd = await realpath(resolve(requestedPath))
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: callerCwd })
  const repository = await canonicalGitPath((await invoke(['rev-parse', '--show-toplevel'])).stdout, callerCwd)
  const commonRaw = (await invoke(['rev-parse', '--git-common-dir'])).stdout.trim()
  const gitCommonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(callerCwd, commonRaw))
  const startCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (!FULL_SHA.test(startCommit)) throw new GitBoundaryError('git-invalid-sha', 'Git returned a non-full start commit')
  const repositoryId = createHash('sha256').update(`${gitCommonDir}\0${repository}`).digest('hex')
  return { repository, callerCwd, gitCommonDir, repositoryId, startCommit }
}

export function makeRunGitIdentity(config: Pick<ResolvedConfig, 'branchPrefix' | 'stateRoot'>, discovery: RepositoryDiscovery, runTag: string, runId: string): RunGitIdentity {
  const component = safeIdentity(runId, 'runId'); const tag = safeIdentity(runTag, 'runTag')
  const branch = `${config.branchPrefix}${tag}-${component}`
  const worktree = join(discovery.gitCommonDir, config.stateRoot, 'worktrees', component)
  return { runId, runTag, branch, worktree, acceptedRef: `refs/autoresearch/runs/${component}/accepted`, candidateRefPrefix: `refs/autoresearch/runs/${component}/candidates/` }
}

export function acquireRunLock(tracker: DurableTracker, identity: RunGitIdentity, repositoryId: string, maxActiveRunsPerRepository: number): void {
  const database = tracker.database
  database.exec('BEGIN IMMEDIATE')
  try {
    const run = tracker.getRun(identity.runId)
    if (!run || run['repository_id'] !== repositoryId || run['run_tag'] !== identity.runTag) throw new GitBoundaryError('run-lock-identity', 'Active lock identity must match the durable run')
    const active = Number(database.prepare('SELECT COUNT(*) AS count FROM active_locks WHERE repository_id = ? AND released_at IS NULL').get(repositoryId)?.['count'] ?? 0)
    if (active >= maxActiveRunsPerRepository) throw new GitBoundaryError('repository-active-limit', 'Repository active-run limit reached')
    database.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, identity.runTag, identity.runId, new Date().toISOString())
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already aborted */ }
    if (isUniqueConstraint(error)) throw new GitBoundaryError('run-tag-active', 'The repository/run-tag is already active')
    throw error
  }
}

export async function allocateRunWorktree(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, options: Omit<GitCommandOptions, 'cwd'>, resume = false): Promise<void> {
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: discovery.repository })
  const branchExists = await gitSucceeds(ctx, executable, ['show-ref', '--verify', '--quiet', `refs/heads/${identity.branch}`], discovery.repository, options)
  const worktrees = (await invoke(['worktree', 'list', '--porcelain'])).stdout
  const registered = parseWorktreeList(worktrees).find((item) => item.path === identity.worktree)
  if (branchExists || registered) {
    if (!resume || !branchExists || !registered || registered.branch !== `refs/heads/${identity.branch}`) throw new GitBoundaryError('git-identity-collision', 'Run branch/worktree identity collides with another allocation')
    return
  }
  await invoke(['worktree', 'add', '-b', identity.branch, identity.worktree, discovery.startCommit])
  await invoke(['update-ref', identity.acceptedRef, discovery.startCommit, '0'.repeat(40)])
}

export async function snapshotCandidate(ctx: GitContext, executable: string, worktree: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateSnapshot> {
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree })
  const parentCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (!FULL_SHA.test(parentCommit)) throw new GitBoundaryError('git-invalid-sha', 'Candidate parent is not a full commit SHA')
  const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z', '--ignore-submodules=none'])).stdout)
  const unstaged = parseNameStatus((await invoke(['diff', '--name-status', '-z', '--ignore-submodules=none'])).stdout)
  const untracked = parseNulPaths((await invoke(['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
  const submodules = new Set((await invoke(['ls-files', '--stage', '-z'])).stdout.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => normalizeRepoPath(entry.slice(entry.indexOf('\t') + 1))))
  const paths = new Map<string, ChangedPath>()
  for (const [kind, values] of [['staged', staged], ['unstaged', unstaged], ['untracked', untracked]] as const) for (const path of values) { const previous = paths.get(path); paths.set(path, { path, staged: previous?.staged ?? kind === 'staged', unstaged: previous?.unstaged ?? kind === 'unstaged', untracked: previous?.untracked ?? kind === 'untracked', submodule: previous?.submodule ?? submodules.has(path) }) }
  return { parentCommit, changed: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

export function validateCandidate(snapshot: CandidateSnapshot, policy: Pick<NormalizedRunPolicy, 'mutableGlobs' | 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): readonly string[] {
  if (snapshot.changed.length === 0) throw new GitBoundaryError('candidate-empty', 'Candidate did not change any path')
  const violations: string[] = []
  for (const change of snapshot.changed) {
    const path = normalizeRepoPath(change.path)
    const mutable = matchesAny(path, policy.mutableGlobs)
    const exceptional = exceptionalCategory(path, change.submodule, policy)
    if (!mutable && !exceptional) violations.push(`${path}: outside mutable paths`)
    if (isProtected(path) && !exceptional) violations.push(`${path}: protected surface`)
  }
  if (violations.length) throw new GitBoundaryError('candidate-policy-violation', 'Candidate changed forbidden paths', violations)
  return snapshot.changed.map((change) => normalizeRepoPath(change.path))
}

export async function commitCandidate(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, experimentId: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateCommit> {
  const invoke = (args: readonly string[], env?: Readonly<Record<string, string>>) => runGit(ctx, executable, args, { ...options, cwd: worktree, ...(env ? { env } : {}) })
  const current = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (current !== snapshot.parentCommit) throw new GitBoundaryError('candidate-parent-moved', 'Candidate parent changed after snapshot')
  await invoke(['add', '--', ...validatedPaths])
  const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z'])).stdout)
  if (!sameSet(staged, validatedPaths)) throw new GitBoundaryError('candidate-stage-mismatch', 'Staged paths differ from validated paths', staged)
  await invoke(['commit', '--no-gpg-sign', '-m', `autoresearch candidate ${experimentId}`], { GIT_AUTHOR_NAME: 'dsh-autoresearch', GIT_AUTHOR_EMAIL: 'autoresearch@localhost', GIT_COMMITTER_NAME: 'dsh-autoresearch', GIT_COMMITTER_EMAIL: 'autoresearch@localhost' })
  const candidateCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  const actualParent = (await invoke(['rev-parse', '--verify', `${candidateCommit}^`])).stdout.trim()
  if (!FULL_SHA.test(candidateCommit) || actualParent !== snapshot.parentCommit) throw new GitBoundaryError('candidate-lineage-invalid', 'Candidate commit lineage is invalid')
  const auditRef = `${identity.candidateRefPrefix}${safeIdentity(experimentId, 'experimentId')}`
  await invoke(['update-ref', auditRef, candidateCommit, '0'.repeat(40)])
  return { parentCommit: snapshot.parentCommit, candidateCommit, auditRef, changedPaths: [...validatedPaths] }
}

export async function reconcileAcceptedHead(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, expectedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  if (!FULL_SHA.test(expectedCommit)) throw new TypeError('expected accepted commit must be a full SHA')
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree })
  const currentRef = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options)
  if (currentRef !== expectedCommit) await invoke(['update-ref', identity.acceptedRef, expectedCommit, currentRef ?? '0'.repeat(40)])
  const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (head !== expectedCommit) {
    const dirty = (await invoke(['status', '--porcelain=v1', '-z'])).stdout
    if (dirty.length) throw new GitBoundaryError('accepted-reconcile-dirty', 'Cannot reconcile accepted HEAD over unpreserved changes')
    await invoke(['checkout', '--detach', expectedCommit])
    await invoke(['branch', '-f', identity.branch, expectedCommit])
    await invoke(['checkout', identity.branch])
  }
}

export function releaseTerminalRunLock(tracker: DurableTracker, runId: string): boolean { return tracker.releaseActiveLock(runId) }
export function recoverTerminalRunLock(tracker: DurableTracker, runId: string): boolean { const state = tracker.recoveryState(runId); return state.safeToReleaseTerminalLock ? tracker.releaseActiveLock(runId) : false }
export async function removeRunWorktree(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { if (await gitSucceeds(ctx, executable, ['worktree', 'list', '--porcelain'], discovery.repository, options).then(async (ok) => ok && (await runGit(ctx, executable, ['worktree', 'list', '--porcelain'], { ...options, cwd: discovery.repository })).stdout.includes(`worktree ${identity.worktree}\n`))) await runGit(ctx, executable, ['worktree', 'remove', identity.worktree], { ...options, cwd: discovery.repository }) }

async function canonicalGitPath(value: string, cwd: string): Promise<string> { const raw = value.trim(); return realpath(isAbsolute(raw) ? raw : resolve(cwd, raw)) }
function safeIdentity(value: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value.includes('..')) throw new TypeError(`${label} is not Git/path safe`); return value }
function normalizeRepoPath(value: string): string { const path = value.replaceAll('\\', '/').replace(/^\.\//u, ''); if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) throw new GitBoundaryError('git-invalid-path', `Invalid repository path ${value}`); return path }
function parseNulPaths(value: string): string[] { return value.split('\0').filter(Boolean).map(normalizeRepoPath) }
function parseNameStatus(value: string): string[] { const fields = value.split('\0').filter(Boolean); const paths: string[] = []; for (let i = 0; i < fields.length;) { const status = fields[i++]!; const path = fields[i++]!; if (/^[RC]/u.test(status)) { const destination = fields[i++]!; paths.push(normalizeRepoPath(path), normalizeRepoPath(destination)) } else paths.push(normalizeRepoPath(path)) } return [...new Set(paths)] }
function globRegex(glob: string): RegExp { let out = '^'; for (let i = 0; i < glob.length; i++) { const char = glob[i]!; if (char === '*') { if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?' } else out += '.*' } else out += '[^/]*' } else if (char === '?') out += '[^/]'; else out += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&') } return new RegExp(`${out}$`, 'u') }
function matchesAny(path: string, globs: readonly string[]): boolean { return globs.some((glob) => globRegex(normalizeRepoPath(glob)).test(path)) }
function isProtected(path: string): boolean { return PROTECTED_DEFAULTS.some((entry) => path === entry || path.startsWith(`${entry}/`)) || path.startsWith('.git/') || /(^|\/)(?:eval|evaluator|dataset|policy)(?:\.|\/|$)/iu.test(path) }
function exceptionalCategory(path: string, submodule: boolean, policy: Pick<NormalizedRunPolicy, 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): boolean { const lists = policy.exceptionalAllowlists; if (submodule && matchesAny(path, lists.submodules)) return true; if ((path === '.gitmodules' || path.startsWith('.git/')) && matchesAny(path, lists.gitConfig)) return true; if (/^(?:package\.json|.*lock.*|pnpm-workspace\.yaml)$/u.test(path) && matchesAny(path, lists.dependencies)) return true; const evaluatorPath = policy.evaluation.cwd ? `${policy.evaluation.cwd}/${policy.evaluation.command}` : policy.evaluation.command; if ((path === normalizeRepoPath(evaluatorPath) || /(^|\/)(?:eval|evaluator)(?:\.|\/|$)/iu.test(path)) && matchesAny(path, lists.evaluators)) return true; if ((policy.provenance.dataset && path.includes(policy.provenance.dataset)) || /(^|\/)dataset(?:\.|\/|$)/iu.test(path)) return matchesAny(path, lists.datasets); return false }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]) }
function isUniqueConstraint(error: unknown): boolean { return String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT') }
function parseWorktreeList(value: string): Array<{ path: string; branch?: string }> { return value.trim().split(/\n\n+/u).filter(Boolean).map((block) => { const lines = block.split('\n'); const path = lines[0]?.startsWith('worktree ') ? lines[0].slice(9) : ''; const branch = lines.find((line) => line.startsWith('branch '))?.slice(7); return { path, ...(branch ? { branch } : {}) } }) }
async function gitSucceeds(ctx: GitContext, executable: string, args: readonly string[], cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<boolean> { try { await runGit(ctx, executable, args, { ...options, cwd }); return true } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return false; throw error } }
async function readOptionalRef(ctx: GitContext, executable: string, ref: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<string | undefined> { try { return (await runGit(ctx, executable, ['rev-parse', '--verify', ref], { ...options, cwd })).stdout.trim() } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return undefined; throw error } }
