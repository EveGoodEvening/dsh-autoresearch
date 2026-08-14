import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.js'
import type { NormalizedRunPolicy } from './types.js'
import { DurableTracker } from './tracker.js'

const FULL_SHA = /^[0-9a-f]{40}$/u
const ZERO_SHA = '0'.repeat(40)
const PROTECTED_DEFAULTS = ['.git', '.gitmodules', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'cordis.patch.yml'] as const
const GIT_CONFIG_LOGICAL_PATHS = ['.git/config', '.git/config.worktree'] as const

export class GitBoundaryError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: readonly string[] = []) { super(message); this.name = 'GitBoundaryError' }
}
export interface GitContext { readonly subprocess: Pick<SubprocessRuntime, 'spawn'> }
export interface GitCommandOptions { readonly cwd: string; readonly timeoutMs: number; readonly graceMs: number; readonly maxStdoutBytes: number; readonly maxStderrBytes: number; readonly signal?: AbortSignal; readonly env?: Readonly<Record<string, string | undefined>> }
export interface GitCommandResult { readonly argv: readonly string[]; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean }
export interface RepositoryDiscovery { readonly repository: string; readonly callerCwd: string; readonly gitCommonDir: string; readonly repositoryId: string; readonly startCommit: string }
export interface RunGitIdentity { readonly runId: string; readonly runTag: string; readonly branch: string; readonly worktree: string; readonly acceptedRef: string; readonly candidateRefPrefix: string }
export interface DurableGitIdentity { readonly runId: string; readonly repositoryId: string; readonly startCommit: string; readonly branch: string; readonly worktree: string }
export interface ChangedPath { readonly path: string; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean; readonly submodule: boolean }
export interface CandidateSnapshot { readonly parentCommit: string; readonly changed: readonly ChangedPath[]; readonly gitConfig: GitConfigBaseline }
export interface GitConfigSnapshot { readonly logicalPath: string; readonly path: string; readonly exists: boolean; readonly sha256?: string }
export interface GitConfigBaseline { readonly files: readonly GitConfigSnapshot[]; readonly allowedPaths: readonly string[] }
export interface CandidateCommit { readonly parentCommit: string; readonly candidateCommit: string; readonly auditRef: string; readonly changedPaths: readonly string[] }

export async function runGit(ctx: GitContext, executable: string, args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
  if (options.graceMs <= 0 || !Number.isFinite(options.graceMs)) throw new TypeError('Git termination grace must be positive')
  if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) throw new TypeError('Git timeout must be positive')
  if (options.signal?.aborted) throw new GitBoundaryError('git-cancelled', `Git command cancelled before spawn: ${args.join(' ')}`)
  const deadline = new AbortController()
  let handle: SubprocessHandle | undefined
  let cancellation = false
  let timedOut = false
  const abort = (reason: unknown, timeout: boolean) => {
    if (deadline.signal.aborted) return
    cancellation = !timeout; timedOut = timeout
    deadline.abort(reason)
    handle?.terminate()
  }
  const onAbort = () => abort(options.signal?.reason ?? new Error('Git command cancelled'), false)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) { options.signal.removeEventListener('abort', onAbort); throw new GitBoundaryError('git-cancelled', `Git command cancelled before spawn: ${args.join(' ')}`) }
  const timer = setTimeout(() => abort(new Error('Git command timed out'), true), options.timeoutMs)
  let outcome: SubprocessOutcome
  try {
    if (deadline.signal.aborted) throw new GitBoundaryError(cancellation ? 'git-cancelled' : 'git-timeout', `Git command aborted before spawn: ${args.join(' ')}`)
    handle = ctx.subprocess.spawn({
      argv: [executable, ...safeGitArgs(args)], cwd: options.cwd, graceMs: options.graceMs, signal: deadline.signal,
      env: { ...scrubbedParentEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...options.env },
      stdio: { stdin: 'ignore', stdout: { maxBytes: options.maxStdoutBytes }, stderr: { maxBytes: options.maxStderrBytes } },
    })
    if (deadline.signal.aborted) handle.terminate()
    outcome = await handle.done
    await handle.waitForExit()
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort)
    if (handle && deadline.signal.aborted) { handle.terminate(); await handle.waitForExit() }
  }
  const stdout = handle.collected.stdout?.readFrom(0); const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout?.lossy || stderr?.lossy) throw new GitBoundaryError('git-output-limit', 'Git output exceeded configured byte cap', [stdout?.spillPath, stderr?.spillPath].filter((value): value is string => Boolean(value)))
  const result = { argv: [executable, ...safeGitArgs(args)], stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', exitCode: outcome.exitCode, signal: outcome.signal, timedOut }
  if (result.exitCode !== 0 || deadline.signal.aborted) throw new GitBoundaryError(timedOut ? 'git-timeout' : cancellation || options.signal?.aborted ? 'git-cancelled' : 'git-command-failed', `Git command failed: ${args.join(' ')}: ${result.stderr.trim()}`, [result.stdout, result.stderr])
  return result
}

export async function discoverRepository(ctx: GitContext, executable: string, requestedPath: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<RepositoryDiscovery> {
  const callerCwd = await realpath(resolve(requestedPath)); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: callerCwd })
  const repository = await canonicalGitPath((await invoke(['rev-parse', '--show-toplevel'])).stdout, callerCwd)
  const commonRaw = (await invoke(['rev-parse', '--git-common-dir'])).stdout.trim(); const gitCommonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(callerCwd, commonRaw))
  const startCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(); requireSha(startCommit, 'start commit')
  return { repository, callerCwd, gitCommonDir, repositoryId: createHash('sha256').update(`${gitCommonDir}\0${repository}`).digest('hex'), startCommit }
}

export function makeRunGitIdentity(config: Pick<ResolvedConfig, 'branchPrefix' | 'stateRoot'>, discovery: RepositoryDiscovery, runTag: string, runId: string): RunGitIdentity {
  const component = safeIdentity(runId, 'runId'); const tag = safeIdentity(runTag, 'runTag'); const branch = `${config.branchPrefix}${tag}-${component}`
  return { runId, runTag, branch, worktree: join(discovery.gitCommonDir, config.stateRoot, 'worktrees', component), acceptedRef: `refs/autoresearch/runs/${component}/accepted`, candidateRefPrefix: `refs/autoresearch/runs/${component}/candidates/` }
}

export function durableGitIdentity(tracker: DurableTracker, runId: string): DurableGitIdentity {
  const run = tracker.getRun(runId); if (!run) throw new GitBoundaryError('git-run-missing', `Unknown durable run ${runId}`)
  return { runId, repositoryId: String(run['repository_id']), startCommit: String(run['start_commit']), branch: String(run['branch']), worktree: String(run['worktree']) }
}

export function acquireRunLock(tracker: DurableTracker, identity: RunGitIdentity, repositoryId: string, maxActiveRunsPerRepository: number): void {
  const database = tracker.database; database.exec('BEGIN IMMEDIATE')
  try {
    const run = tracker.getRun(identity.runId)
    if (!run || run['repository_id'] !== repositoryId || run['run_tag'] !== identity.runTag) throw new GitBoundaryError('run-lock-identity', 'Active lock identity must match the durable run')
    const active = Number(database.prepare('SELECT COUNT(*) AS count FROM active_locks WHERE repository_id = ? AND released_at IS NULL').get(repositoryId)?.['count'] ?? 0)
    if (active >= maxActiveRunsPerRepository) throw new GitBoundaryError('repository-active-limit', 'Repository active-run limit reached')
    database.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, identity.runTag, identity.runId, new Date().toISOString()); database.exec('COMMIT')
  } catch (error) { try { database.exec('ROLLBACK') } catch {} if (isUniqueConstraint(error)) throw new GitBoundaryError('run-tag-active', 'The repository/run-tag is already active'); throw error }
}

export async function allocateRunWorktree(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, durable: DurableGitIdentity, options: Omit<GitCommandOptions, 'cwd'>, resume = false): Promise<void> {
  assertDurableIdentity(discovery, identity, durable)
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: discovery.repository }); const branchRef = `refs/heads/${identity.branch}`
  const branchCommit = await readOptionalRef(ctx, executable, branchRef, discovery.repository, options); const worktrees = parseWorktreeList((await invoke(['worktree', 'list', '--porcelain'])).stdout)
  const registered = worktrees.find((item) => item.path === identity.worktree); const branchRegistration = worktrees.find((item) => item.branch === branchRef)
  if (branchCommit || registered || branchRegistration) {
    if (!resume || !branchCommit || !registered || branchRegistration?.path !== identity.worktree || registered.branch !== branchRef) throw new GitBoundaryError('git-identity-collision', 'Run branch/worktree identity collides with another allocation')
    const head = (await runGit(ctx, executable, ['rev-parse', '--verify', 'HEAD^{commit}'], { ...options, cwd: identity.worktree })).stdout.trim(); const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, discovery.repository, options)
    if (branchCommit !== head) throw new GitBoundaryError('git-resume-mismatch', 'Run branch and worktree HEAD disagree')
    if (!await isAncestor(ctx, executable, durable.startCommit, branchCommit, discovery.repository, options)) throw new GitBoundaryError('git-resume-mismatch', 'Run branch is not descended from immutable start commit')
    if (accepted === undefined) { if (branchCommit !== durable.startCommit) throw new GitBoundaryError('git-resume-mismatch', 'Missing accepted ref cannot be recovered after branch advancement'); await invoke(['update-ref', identity.acceptedRef, durable.startCommit, ZERO_SHA]) }
    else if (accepted !== branchCommit || !await isAncestor(ctx, executable, durable.startCommit, accepted, discovery.repository, options)) throw new GitBoundaryError('git-resume-mismatch', 'Accepted ref, branch, HEAD, or immutable start disagree')
    return
  }
  if (await readOptionalRef(ctx, executable, identity.acceptedRef, discovery.repository, options)) throw new GitBoundaryError('git-identity-collision', 'Run accepted ref exists without branch/worktree')
  await invoke(['worktree', 'add', '-b', identity.branch, identity.worktree, durable.startCommit]); await invoke(['update-ref', identity.acceptedRef, durable.startCommit, ZERO_SHA])
}

export async function captureGitConfigBaseline(ctx: GitContext, executable: string, worktree: string, policy: Pick<NormalizedRunPolicy, 'exceptionalAllowlists'>, options: Omit<GitCommandOptions, 'cwd'>): Promise<GitConfigBaseline> {
  const allowedPaths = [...new Set(policy.exceptionalAllowlists.gitConfig.map(normalizeGitConfigAllowlist))].sort(); const files = await snapshotGitConfig(ctx, executable, worktree, options)
  await rejectExecutableGitConfig(ctx, executable, worktree, options)
  return { files, allowedPaths }
}

export async function snapshotCandidate(ctx: GitContext, executable: string, worktree: string, gitConfig: GitConfigBaseline, options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateSnapshot> {
  await enforceGitConfigBaseline(ctx, executable, worktree, gitConfig, options); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree })
  const parentCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(); requireSha(parentCommit, 'candidate parent')
  const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z', '--ignore-submodules=none'])).stdout); const unstaged = parseNameStatus((await invoke(['diff', '--name-status', '-z', '--ignore-submodules=none'])).stdout); const untracked = parseNulPaths((await invoke(['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
  const submodules = new Set((await invoke(['ls-files', '--stage', '-z'])).stdout.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => normalizeRepoPath(entry.slice(entry.indexOf('\t') + 1))))
  const paths = new Map<string, ChangedPath>()
  for (const [kind, values] of [['staged', staged], ['unstaged', unstaged], ['untracked', untracked]] as const) for (const path of values) { const previous = paths.get(path); paths.set(path, { path, staged: previous?.staged ?? kind === 'staged', unstaged: previous?.unstaged ?? kind === 'unstaged', untracked: previous?.untracked ?? kind === 'untracked', submodule: previous?.submodule ?? submodules.has(path) }) }
  return { parentCommit, changed: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)), gitConfig }
}

export function validateCandidate(snapshot: CandidateSnapshot, policy: Pick<NormalizedRunPolicy, 'mutableGlobs' | 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): readonly string[] {
  if (!snapshot.changed.length) throw new GitBoundaryError('candidate-empty', 'Candidate did not change any path')
  const violations: string[] = []
  for (const change of snapshot.changed) {
    const path = normalizeRepoPath(change.path); const exceptional = exceptionalCategory(path, change.submodule, policy)
    if (change.submodule && !matchesAny(path, policy.exceptionalAllowlists.submodules)) violations.push(`${path}: submodule not allowlisted`)
    if (!matchesAny(path, policy.mutableGlobs) && !exceptional) violations.push(`${path}: outside mutable paths`)
    if (isProtected(path) && !exceptional) violations.push(`${path}: protected surface`)
  }
  if (violations.length) throw new GitBoundaryError('candidate-policy-violation', 'Candidate changed forbidden paths', violations)
  return [...new Set(snapshot.changed.map((change) => normalizeRepoPath(change.path)))].sort()
}

export async function commitCandidate(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, experimentId: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateCommit> {
  await enforceGitConfigBaseline(ctx, executable, worktree, snapshot.gitConfig, options)
  const invoke = (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => runGit(ctx, executable, args, { ...options, cwd: worktree, ...(env ? { env } : {}) })
  const auditRef = `${identity.candidateRefPrefix}${safeIdentity(experimentId, 'experimentId')}`; const current = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (current !== snapshot.parentCommit) throw new GitBoundaryError('candidate-parent-moved', 'Accepted worktree HEAD moved after candidate snapshot')
  const existingAudit = await readOptionalRef(ctx, executable, auditRef, worktree, options)
  if (existingAudit) { await verifyRecoverableCandidate(invoke, existingAudit, snapshot, validatedPaths, experimentId); return { parentCommit: snapshot.parentCommit, candidateCommit: existingAudit, auditRef, changedPaths: [...validatedPaths] } }
  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-index-')); const indexEnv = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await invoke(['read-tree', snapshot.parentCommit], indexEnv); await invoke(['add', '--', ...validatedPaths], indexEnv)
    const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z'], indexEnv)).stdout); if (!sameSet(staged, validatedPaths)) throw new GitBoundaryError('candidate-stage-mismatch', 'Staged paths differ from validated paths', staged)
    const tree = (await invoke(['write-tree'], indexEnv)).stdout.trim(); const parentDate = (await invoke(['show', '-s', '--format=%aI', snapshot.parentCommit])).stdout.trim()
    const commitEnv = { ...indexEnv, GIT_AUTHOR_NAME: 'dsh-autoresearch', GIT_AUTHOR_EMAIL: 'autoresearch@localhost', GIT_COMMITTER_NAME: 'dsh-autoresearch', GIT_COMMITTER_EMAIL: 'autoresearch@localhost', GIT_AUTHOR_DATE: parentDate, GIT_COMMITTER_DATE: parentDate }
    const candidateCommit = (await invoke(['commit-tree', tree, '-p', snapshot.parentCommit, '-m', `autoresearch candidate ${experimentId}`], commitEnv)).stdout.trim(); requireSha(candidateCommit, 'candidate commit')
    await verifyRecoverableCandidate(invoke, candidateCommit, snapshot, validatedPaths, experimentId); await invoke(['update-ref', auditRef, candidateCommit, ZERO_SHA])
    return { parentCommit: snapshot.parentCommit, candidateCommit, auditRef, changedPaths: [...validatedPaths] }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function reconcileAcceptedHead(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, expectedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(expectedCommit, 'expected accepted commit'); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree }); const branchRef = `refs/heads/${identity.branch}`
  const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options); const branch = await readOptionalRef(ctx, executable, branchRef, worktree, options); const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (accepted === expectedCommit && branch === expectedCommit && head === expectedCommit) { await requireClean(invoke); return }
  await requireCandidateAudit(ctx, executable, worktree, identity, expectedCommit, options); const parent = (await invoke(['rev-parse', '--verify', `${expectedCommit}^`])).stdout.trim()
  if (accepted !== parent) throw new GitBoundaryError('accepted-reconcile-lineage', 'Candidate parent is not the durable accepted ref')
  if (branch === parent && head === parent) { await requireWorktreeMatches(invoke, expectedCommit); await invoke(['reset', '--hard', expectedCommit]) }
  else if (branch !== expectedCommit || head !== expectedCommit) throw new GitBoundaryError('accepted-reconcile-identity', 'Accepted ref, branch, and worktree HEAD are not a recoverable promotion state')
  await requireClean(invoke); await invoke(['update-ref', identity.acceptedRef, expectedCommit, parent])
}

export async function reconcileRejectedHead(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, candidateCommit: string, expectedAcceptedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(candidateCommit, 'rejected candidate'); requireSha(expectedAcceptedCommit, 'expected accepted commit'); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree }); const branchRef = `refs/heads/${identity.branch}`
  await requireCandidateAudit(ctx, executable, worktree, identity, candidateCommit, options); const parent = (await invoke(['rev-parse', '--verify', `${candidateCommit}^`])).stdout.trim(); if (parent !== expectedAcceptedCommit) throw new GitBoundaryError('rejected-reconcile-lineage', 'Rejected candidate is not based on expected accepted commit')
  const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options); const branch = await readOptionalRef(ctx, executable, branchRef, worktree, options); const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (accepted !== expectedAcceptedCommit) throw new GitBoundaryError('rejected-reconcile-accepted', 'Accepted ref changed before rejection')
  if (branch === expectedAcceptedCommit && head === expectedAcceptedCommit) { if (await isClean(invoke)) return; await requireWorktreeMatches(invoke, candidateCommit) }
  else if (branch !== candidateCommit || head !== candidateCommit) throw new GitBoundaryError('rejected-reconcile-identity', 'Branch and HEAD are not a recoverable rejection state')
  await invoke(['reset', '--hard', expectedAcceptedCommit]); await invoke(['clean', '-fd']); await requireClean(invoke)
}

export function releaseTerminalRunLock(tracker: DurableTracker, runId: string): boolean { return tracker.releaseActiveLock(runId) }
export function recoverTerminalRunLock(tracker: DurableTracker, runId: string): boolean { return tracker.recoveryState(runId).safeToReleaseTerminalLock ? tracker.releaseActiveLock(runId) : false }
export async function removeRunWorktree(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { const listed = parseWorktreeList((await runGit(ctx, executable, ['worktree', 'list', '--porcelain'], { ...options, cwd: discovery.repository })).stdout); if (listed.some((item) => item.path === identity.worktree)) await runGit(ctx, executable, ['worktree', 'remove', identity.worktree], { ...options, cwd: discovery.repository }) }

function safeGitArgs(args: readonly string[]): readonly string[] { return args[0] === '-e' ? args : ['-c', 'core.hooksPath=/dev/null', ...args] }
function requireSha(value: string, label: string): void { if (!FULL_SHA.test(value)) throw new GitBoundaryError('git-invalid-sha', `Git returned a non-full ${label}`) }
function assertDurableIdentity(discovery: RepositoryDiscovery, identity: RunGitIdentity, durable: DurableGitIdentity): void { if (durable.runId !== identity.runId || durable.repositoryId !== discovery.repositoryId || durable.startCommit !== discovery.startCommit || durable.branch !== identity.branch || durable.worktree !== identity.worktree) throw new GitBoundaryError('git-durable-identity-mismatch', 'Allocation identity differs from the immutable durable run') }
async function canonicalGitPath(value: string, cwd: string): Promise<string> { const raw = value.trim(); return realpath(isAbsolute(raw) ? raw : resolve(cwd, raw)) }
function safeIdentity(value: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value.includes('..')) throw new TypeError(`${label} is not Git/path safe`); return value }
function normalizeRepoPath(value: string): string { const path = value.replaceAll('\\', '/').replace(/^\.\//u, ''); if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) throw new GitBoundaryError('git-invalid-path', `Invalid repository path ${value}`); return path }
function normalizeGitConfigAllowlist(value: string): string { const path = normalizeRepoPath(value); if (!(GIT_CONFIG_LOGICAL_PATHS as readonly string[]).includes(path)) throw new GitBoundaryError('git-config-allowlist-invalid', `Unsupported Git config allowlist path ${value}`); return path }
function parseNulPaths(value: string): string[] { return value.split('\0').filter(Boolean).map(normalizeRepoPath) }
function parseNameStatus(value: string): string[] { const fields = value.split('\0').filter(Boolean); const paths: string[] = []; for (let i = 0; i < fields.length;) { const status = fields[i++]!; const path = fields[i++]!; if (/^[RC]/u.test(status)) paths.push(normalizeRepoPath(path), normalizeRepoPath(fields[i++]!)); else paths.push(normalizeRepoPath(path)) } return [...new Set(paths)] }
function globRegex(glob: string): RegExp { let out = '^'; for (let i = 0; i < glob.length; i++) { const char = glob[i]!; if (char === '*') { if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?' } else out += '.*' } else out += '[^/]*' } else if (char === '?') out += '[^/]'; else out += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&') } return new RegExp(`${out}$`, 'u') }
function matchesAny(path: string, globs: readonly string[]): boolean { return globs.some((glob) => globRegex(normalizeRepoPath(glob)).test(path)) }
function isProtected(path: string): boolean { return PROTECTED_DEFAULTS.some((entry) => path === entry || path.startsWith(`${entry}/`)) || path.startsWith('.git/') || /(^|\/)(?:eval|evaluator|dataset|policy)(?:\.|\/|$)/iu.test(path) }
function exceptionalCategory(path: string, submodule: boolean, policy: Pick<NormalizedRunPolicy, 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): boolean { const lists = policy.exceptionalAllowlists; if (submodule && matchesAny(path, lists.submodules)) return true; if ((path === '.gitmodules' || path.startsWith('.git/')) && matchesAny(path, lists.gitConfig)) return true; if (/^(?:package\.json|.*lock.*|pnpm-workspace\.yaml)$/u.test(path) && matchesAny(path, lists.dependencies)) return true; const evaluatorPath = policy.evaluation.cwd ? `${policy.evaluation.cwd}/${policy.evaluation.command}` : policy.evaluation.command; if ((path === normalizeRepoPath(evaluatorPath) || /(^|\/)(?:eval|evaluator)(?:\.|\/|$)/iu.test(path)) && matchesAny(path, lists.evaluators)) return true; if ((policy.provenance.dataset && path.includes(policy.provenance.dataset)) || /(^|\/)dataset(?:\.|\/|$)/iu.test(path)) return matchesAny(path, lists.datasets); return false }
function sameSet(left: readonly string[], right: readonly string[]): boolean { const a = [...left].sort(); const b = [...right].sort(); return a.length === b.length && a.every((value, index) => value === b[index]) }
function isUniqueConstraint(error: unknown): boolean { return String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT') || String(error).includes('UNIQUE constraint failed') }
function parseWorktreeList(value: string): Array<{ path: string; branch?: string }> { return value.trim().split(/\n\n+/u).filter(Boolean).map((block) => { const lines = block.split('\n'); const path = lines[0]?.startsWith('worktree ') ? lines[0].slice(9) : ''; const branch = lines.find((line) => line.startsWith('branch '))?.slice(7); return { path, ...(branch ? { branch } : {}) } }) }
async function readOptionalRef(ctx: GitContext, executable: string, ref: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<string | undefined> { try { return (await runGit(ctx, executable, ['rev-parse', '--verify', ref], { ...options, cwd })).stdout.trim() } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return undefined; throw error } }
async function isAncestor(ctx: GitContext, executable: string, ancestor: string, descendant: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<boolean> { try { await runGit(ctx, executable, ['merge-base', '--is-ancestor', ancestor, descendant], { ...options, cwd }); return true } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return false; throw error } }
async function snapshotGitConfig(ctx: GitContext, executable: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<readonly GitConfigSnapshot[]> { const files: GitConfigSnapshot[] = []; for (const logicalPath of GIT_CONFIG_LOGICAL_PATHS) { const selector = logicalPath === '.git/config' ? 'config' : 'config.worktree'; const raw = (await runGit(ctx, executable, ['rev-parse', '--git-path', selector], { ...options, cwd })).stdout.trim(); const path = resolve(cwd, raw); try { files.push({ logicalPath, path, exists: true, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push({ logicalPath, path, exists: false }); else throw error } } return files }
async function rejectExecutableGitConfig(ctx: GitContext, executable: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { const result = await runGit(ctx, executable, ['config', '--local', '--no-includes', '--null', '--list'], { ...options, cwd }); const hostile = result.stdout.split('\0').filter(Boolean).filter((entry) => { const separator = entry.indexOf('\n'); const key = entry.slice(0, separator < 0 ? entry.length : separator); return key === 'core.hookspath' || /^filter\..*\.(?:clean|process|required)$/u.test(key) }); if (hostile.length) throw new GitBoundaryError('git-config-unsafe', 'Repository Git configuration defines executable hooks or content filters', hostile) }
async function enforceGitConfigBaseline(ctx: GitContext, executable: string, cwd: string, baseline: GitConfigBaseline, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { await rejectExecutableGitConfig(ctx, executable, cwd, options); const current = await snapshotGitConfig(ctx, executable, cwd, options); const changed = current.filter((item) => { const before = baseline.files.find((entry) => entry.logicalPath === item.logicalPath); return JSON.stringify(before) !== JSON.stringify(item) && !baseline.allowedPaths.includes(item.logicalPath) }); if (changed.length) throw new GitBoundaryError('git-config-mutated', 'Git configuration changed after trusted baseline', changed.map((item) => item.logicalPath)) }
async function verifyRecoverableCandidate(invoke: (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => Promise<GitCommandResult>, commit: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], experimentId: string): Promise<void> { requireSha(commit, 'candidate commit'); const parent = (await invoke(['rev-parse', '--verify', `${commit}^`])).stdout.trim(); const subject = (await invoke(['show', '-s', '--format=%s', commit])).stdout.trim(); const paths = parseNameStatus((await invoke(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', commit])).stdout); if (parent !== snapshot.parentCommit || subject !== `autoresearch candidate ${experimentId}` || !sameSet(paths, validatedPaths)) throw new GitBoundaryError('candidate-lineage-invalid', 'Candidate commit does not match durable experiment identity') }
async function requireCandidateAudit(ctx: GitContext, executable: string, cwd: string, identity: RunGitIdentity, commit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { const refs = (await runGit(ctx, executable, ['for-each-ref', '--format=%(objectname)', identity.candidateRefPrefix], { ...options, cwd })).stdout.split('\n').filter(Boolean); if (!refs.includes(commit)) throw new GitBoundaryError('accepted-reconcile-audit', 'Candidate has no run-owned audit ref') }
async function requireWorktreeMatches(invoke: (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => Promise<GitCommandResult>, commit: string): Promise<void> { const directory = await mkdtemp(join(tmpdir(), 'autoresearch-verify-')); const env = { GIT_INDEX_FILE: join(directory, 'index') }; try { await invoke(['read-tree', 'HEAD'], env); await invoke(['add', '-A'], env); const actualTree = (await invoke(['write-tree'], env)).stdout.trim(); const expectedTree = (await invoke(['rev-parse', `${commit}^{tree}`])).stdout.trim(); if (actualTree !== expectedTree) throw new GitBoundaryError('accepted-reconcile-dirty', 'Worktree does not exactly match the recorded candidate') } finally { await rm(directory, { recursive: true, force: true }) } }
async function isClean(invoke: (args: readonly string[]) => Promise<GitCommandResult>): Promise<boolean> { return (await invoke(['status', '--porcelain=v1', '-z'])).stdout.length === 0 }
async function requireClean(invoke: (args: readonly string[]) => Promise<GitCommandResult>): Promise<void> { if (!await isClean(invoke)) throw new GitBoundaryError('accepted-reconcile-dirty', 'Run worktree is not clean after reconciliation') }
