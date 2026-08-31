import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.js'
import { normalizeEvaluatorRegistration, normalizeFrozenFileDeclarations, normalizeRegistrationManifest, type EvaluatorRegistration, type FrozenFileDeclarations, type NormalizedRunPolicy, type RegistrationManifest } from './types.js'
import { DurableTracker } from './tracker.js'
import { deriveRegistrationManifest } from './evaluator.js'

const FULL_SHA = /^[0-9a-f]{40}$/u
const ZERO_SHA = '0'.repeat(40)
const PROTECTED_DEFAULTS = ['.git', '.gitmodules', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'cordis.patch.yml'] as const
const GIT_CONFIG_LOGICAL_PATHS = ['.git/config', '.git/config.worktree'] as const

export class GitBoundaryError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: readonly string[] = []) { super(message); this.name = 'GitBoundaryError' }
}
export interface GitContext { readonly subprocess: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'> }
export interface GitEnvironmentOverrides { readonly GIT_INDEX_FILE?: string; readonly GIT_AUTHOR_NAME?: string; readonly GIT_AUTHOR_EMAIL?: string; readonly GIT_COMMITTER_NAME?: string; readonly GIT_COMMITTER_EMAIL?: string; readonly GIT_AUTHOR_DATE?: string; readonly GIT_COMMITTER_DATE?: string }
export interface GitCommandOptions { readonly cwd: string; readonly timeoutMs: number; readonly graceMs: number; readonly maxStdoutBytes: number; readonly maxStderrBytes: number; readonly signal?: AbortSignal; readonly env?: GitEnvironmentOverrides; readonly stdinData?: string }
export interface GitCommandResult { readonly argv: readonly string[]; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean }
export interface RepositoryDiscovery { readonly repository: string; readonly callerCwd: string; readonly gitCommonDir: string; readonly repositoryId: string; readonly startCommit: string }
export interface RunGitIdentity { readonly runId: string; readonly runTag: string; readonly branch: string; readonly worktree: string; readonly acceptedRef: string; readonly candidateRefPrefix: string }
export interface DurableGitIdentity { readonly runId: string; readonly repositoryId: string; readonly startCommit: string; readonly branch: string; readonly worktree: string }
export interface ChangedPath { readonly path: string; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean; readonly submodule: boolean }
export interface CandidateSnapshot { readonly parentCommit: string; readonly changed: readonly ChangedPath[]; readonly ignoredUntracked: readonly string[]; readonly gitConfig: GitConfigBaseline }
export interface GitConfigSnapshot { readonly logicalPath: string; readonly path: string; readonly exists: boolean; readonly sha256?: string }
export interface GitConfigBaseline { readonly files: readonly GitConfigSnapshot[]; readonly allowedPaths: readonly string[] }
export interface CandidateCommit { readonly parentCommit: string; readonly candidateCommit: string; readonly auditRef: string; readonly changedPaths: readonly string[] }
export interface PreparedCandidateTree extends CandidateCommit {}
export interface RunGitInspection {
  readonly acceptedCommit?: string
  readonly branchCommit?: string
  readonly headCommit?: string
  readonly auditCommits: readonly string[]
  readonly worktreeRegistered: boolean
  readonly registeredBranch?: string
}


export async function resolveGitExecutable(ctx: GitContext, configured: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(configured) && /[\\/]/u.test(configured)) throw new TypeError('Configured Git executable must be a bare name or absolute path')
  return ctx.subprocess.resolveExecutable(configured, closedGitEnvironment(), signal)
}

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
    const env = closedGitEnvironment(options.env)
    handle = ctx.subprocess.spawn({
      argv: [executable, ...safeGitArgs(args)], cwd: options.cwd, graceMs: options.graceMs, signal: deadline.signal, env,
      stdio: { stdin: options.stdinData === undefined ? 'ignore' : { data: options.stdinData }, stdout: { maxBytes: options.maxStdoutBytes }, stderr: { maxBytes: options.maxStderrBytes } },
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
  await rejectExecutableGitConfig(ctx, executable, repository, options)
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
export interface ControllerProcessIdentity { readonly pid: number; readonly startToken?: string }
export interface ControllerClaim extends ControllerProcessIdentity { readonly ownerId: string; readonly expiresAt: string }

export function currentControllerProcessIdentity(pid = process.pid): ControllerProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('controller PID must be a positive integer')
  const startToken = linuxProcessStartToken(pid)
  return { pid, ...(startToken === undefined ? {} : { startToken }) }
}

export function acquireControllerClaim(tracker: DurableTracker, runId: string, ownerId: string, leaseMs: number, now = new Date(), processIdentity = currentControllerProcessIdentity()): ControllerClaim {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('controller claim lease must be a positive integer')
  validateControllerProcessIdentity(processIdentity)
  const authority = openLockAuthority(tracker, runId); const expiresAt = new Date(now.getTime() + leaseMs).toISOString()
  try {
    authority.exec('BEGIN IMMEDIATE')
    const claim = authority.prepare('SELECT owner_id, owner_pid, owner_start_token FROM controller_claims WHERE run_id = ?').get(runId)
    if (claim && claim['owner_id'] !== ownerId && !priorControllerIsProvablyGone(claim)) throw new GitBoundaryError('run-controller-active', 'Another controller instance owns this run')
    authority.prepare('INSERT INTO controller_claims (run_id, owner_id, owner_pid, owner_start_token, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET owner_id=excluded.owner_id, owner_pid=excluded.owner_pid, owner_start_token=excluded.owner_start_token, acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at').run(runId, ownerId, processIdentity.pid, processIdentity.startToken ?? null, now.toISOString(), now.toISOString(), expiresAt)
    authority.exec('COMMIT')
    return { ownerId, ...processIdentity, expiresAt }
  } catch (error) { try { authority.exec('ROLLBACK') } catch {} throw error } finally { authority.close() }
}

export function heartbeatControllerClaim(tracker: DurableTracker, runId: string, ownerId: string, leaseMs: number, now = new Date(), processIdentity = currentControllerProcessIdentity()): ControllerClaim {
  validateControllerProcessIdentity(processIdentity)
  const authority = openLockAuthority(tracker, runId); const expiresAt = new Date(now.getTime() + leaseMs).toISOString()
  try {
    const changed = authority.prepare('UPDATE controller_claims SET heartbeat_at = ?, expires_at = ? WHERE run_id = ? AND owner_id = ? AND owner_pid = ? AND owner_start_token IS ?').run(now.toISOString(), expiresAt, runId, ownerId, processIdentity.pid, processIdentity.startToken ?? null).changes
    if (changed !== 1) throw new GitBoundaryError('run-controller-claim-lost', 'Controller instance no longer owns this run')
    return { ownerId, ...processIdentity, expiresAt }
  } finally { authority.close() }
}

export function releaseControllerClaim(tracker: DurableTracker, runId: string, ownerId: string, processIdentity = currentControllerProcessIdentity()): boolean {
  validateControllerProcessIdentity(processIdentity)
  const authority = openLockAuthority(tracker, runId)
  try { return authority.prepare('DELETE FROM controller_claims WHERE run_id = ? AND owner_id = ? AND owner_pid = ? AND owner_start_token IS ?').run(runId, ownerId, processIdentity.pid, processIdentity.startToken ?? null).changes === 1 } finally { authority.close() }
}


export function acquireRunLock(tracker: DurableTracker, identity: RunGitIdentity, repositoryId: string, maxActiveRunsPerRepository: number): void {
  const run = tracker.getRun(identity.runId)
  if (!run || run['repository_id'] !== repositoryId || run['run_tag'] !== identity.runTag) throw new GitBoundaryError('run-lock-identity', 'Active lock identity must match the durable run')
  const authority = openLockAuthority(tracker, identity.runId)
  try {
    authority.exec('BEGIN IMMEDIATE')
    const owner = authority.prepare('SELECT run_id FROM active_locks WHERE repository_id = ? AND run_tag = ?').get(repositoryId, identity.runTag)
    if (owner && owner['run_id'] !== identity.runId) throw new GitBoundaryError('run-tag-active', 'The repository/run-tag is already active')
    if (!owner) {
      const active = Number(authority.prepare('SELECT COUNT(*) AS count FROM active_locks WHERE repository_id = ?').get(repositoryId)?.['count'] ?? 0)
      if (active >= maxActiveRunsPerRepository) throw new GitBoundaryError('repository-active-limit', 'Repository active-run limit reached')
      authority.prepare('INSERT INTO active_locks (repository_id, run_tag, run_id, acquired_at) VALUES (?, ?, ?, ?)').run(repositoryId, identity.runTag, identity.runId, new Date().toISOString())
    }
    authority.exec('COMMIT')
  } catch (error) { try { authority.exec('ROLLBACK') } catch {} throw error } finally { authority.close() }
  try { tracker.acquireActiveLock(identity.runId, repositoryId, identity.runTag) }
  catch (error) { releaseAuthorityLock(tracker, identity.runId); throw error }
}
export function rollbackRunActivationAuthority(tracker: DurableTracker, runId: string): void {
  const authority = openLockAuthority(tracker, runId)
  try {
    authority.exec('BEGIN IMMEDIATE')
    authority.prepare('DELETE FROM controller_claims WHERE run_id = ?').run(runId)
    authority.prepare('DELETE FROM active_locks WHERE run_id = ?').run(runId)
    authority.exec('COMMIT')
  } catch (error) {
    try { authority.exec('ROLLBACK') } catch { /* preserve rollback failure */ }
    throw error
  } finally { authority.close() }
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
  await rejectExecutableGitConfig(ctx, executable, discovery.repository, options); await invoke(['worktree', 'add', '-b', identity.branch, identity.worktree, durable.startCommit]); await invoke(['update-ref', identity.acceptedRef, durable.startCommit, ZERO_SHA])
}

export async function captureGitConfigBaseline(ctx: GitContext, executable: string, worktree: string, policy: Pick<NormalizedRunPolicy, 'exceptionalAllowlists'>, options: Omit<GitCommandOptions, 'cwd'>): Promise<GitConfigBaseline> {
  const allowedPaths = [...new Set(policy.exceptionalAllowlists.gitConfig.map(normalizeGitConfigAllowlist))].sort(); const files = await snapshotGitConfig(ctx, executable, worktree, options)
  await rejectExecutableGitConfig(ctx, executable, worktree, options)
  return { files, allowedPaths }
}

export async function deriveRegistrationManifestAtStartCommit(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, registration: EvaluatorRegistration, options: Omit<GitCommandOptions, 'cwd'>): Promise<RegistrationManifest> {
  const [canonicalWorktree, canonicalCaller, canonicalRepository] = await Promise.all([realpath(resolve(identity.worktree)), realpath(resolve(discovery.callerCwd)), realpath(resolve(discovery.repository))])
  if (canonicalWorktree === canonicalCaller || canonicalWorktree === canonicalRepository) throw new GitBoundaryError('git-manifest-worktree-not-isolated', 'Registration manifest must be derived from the allocated run worktree')
  const before = await stat(canonicalWorktree)
  if (!before.isDirectory()) throw new GitBoundaryError('git-manifest-worktree-identity', 'Allocated run worktree is not a directory')
  const worktrees = parseWorktreeList((await runGit(ctx, executable, ['worktree', 'list', '--porcelain'], { ...options, cwd: canonicalRepository })).stdout)
  const branchRef = `refs/heads/${identity.branch}`
  const registered = worktrees.find(item => item.branch === branchRef)
  if (!registered || await realpath(resolve(registered.path)) !== canonicalWorktree) throw new GitBoundaryError('git-manifest-worktree-identity', 'Registration manifest worktree is not the allocated run worktree')
  await verifyExactWorktree(ctx, executable, canonicalWorktree, discovery.startCommit, options)

  const normalized = normalizeEvaluatorRegistration(registration)
  const declarations = normalizeFrozenFileDeclarations({ evaluatorFiles: normalized.evaluatorFiles, datasetFiles: normalized.dataset.kind === 'local' ? normalized.dataset.files : [] })
  const paths = [...declarations.evaluatorFiles, ...declarations.datasetFiles].sort()
  if (paths.length === 0) return {}
  const literalPaths = paths.map(path => `:(literal)${path}`)
  const treeEntries = parseDeclaredTreeEntries((await runGit(ctx, executable, ['ls-tree', '-z', discovery.startCommit, '--', ...literalPaths], { ...options, cwd: canonicalRepository })).stdout)
  if (treeEntries.length !== paths.length || treeEntries.some((entry, index) => entry.path !== paths[index])) throw new GitBoundaryError('git-manifest-path-missing', 'Every declared registration path must exist at the immutable start commit')
  for (const entry of treeEntries) {
    if ((entry.mode !== '100644' && entry.mode !== '100755') || entry.type !== 'blob') throw new GitBoundaryError('git-manifest-path-type', `Declared registration path is not a regular blob: ${entry.path}`)
    const actualType = (await runGit(ctx, executable, ['cat-file', '-t', entry.object], { ...options, cwd: canonicalRepository })).stdout.trim()
    if (actualType !== 'blob') throw new GitBoundaryError('git-manifest-path-type', `Declared registration path is not a blob object: ${entry.path}`)
  }

  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-manifest-'))
  const indexEnv = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await runGit(ctx, executable, ['read-tree', discovery.startCommit], { ...options, cwd: canonicalRepository, env: indexEnv })
    await runGit(ctx, executable, ['checkout-index', '--all', `--prefix=${directory}/`], { ...options, cwd: canonicalRepository, env: indexEnv })
    const manifest = deriveRegistrationManifest(directory, normalized)
    const after = await stat(canonicalWorktree)
    if (after.dev !== before.dev || after.ino !== before.ino || await realpath(resolve(identity.worktree)) !== canonicalWorktree) throw new GitBoundaryError('git-manifest-worktree-identity', 'Allocated run worktree identity changed during manifest derivation')
    await verifyExactWorktree(ctx, executable, canonicalWorktree, discovery.startCommit, options)
    return normalizeRegistrationManifest(manifest)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export function validateFrozenCandidatePaths(snapshot: CandidateSnapshot, declarations: FrozenFileDeclarations): void {
  const normalized = normalizeFrozenFileDeclarations(declarations)
  const frozen = new Set([...normalized.evaluatorFiles, ...normalized.datasetFiles])
  const violations = [...snapshot.changed.map(change => change.path), ...snapshot.ignoredUntracked]
    .map(normalizeRepoPath)
    .filter(path => frozen.has(path))
    .map(path => `${path}: frozen evaluator/dataset file`)
  if (violations.length > 0) throw new GitBoundaryError('candidate-policy-violation', 'Candidate changed frozen evaluator or dataset files', [...new Set(violations)].sort())
}

export async function snapshotCandidate(ctx: GitContext, executable: string, worktree: string, gitConfig: GitConfigBaseline, options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateSnapshot> {
  await enforceGitConfigBaseline(ctx, executable, worktree, gitConfig, options); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree })
  const parentCommit = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(); requireSha(parentCommit, 'candidate parent')
  const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z', '--ignore-submodules=none'])).stdout); const unstaged = parseNameStatus((await invoke(['diff', '--name-status', '-z', '--ignore-submodules=none'])).stdout); const untracked = parseNulPaths((await invoke(['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
  const ignoredUntracked = parseNulPaths((await invoke(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout)
  const submodules = new Set((await invoke(['ls-files', '--stage', '-z'])).stdout.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => normalizeRepoPath(entry.slice(entry.indexOf('\t') + 1))))
  const paths = new Map<string, ChangedPath>()
  for (const [kind, values] of [['staged', staged], ['unstaged', unstaged], ['untracked', untracked]] as const) for (const path of values) { const previous = paths.get(path); paths.set(path, { path, staged: previous?.staged ?? kind === 'staged', unstaged: previous?.unstaged ?? kind === 'unstaged', untracked: previous?.untracked ?? kind === 'untracked', submodule: previous?.submodule ?? submodules.has(path) }) }
  return { parentCommit, changed: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)), ignoredUntracked, gitConfig }
}

export function validateCandidate(snapshot: CandidateSnapshot, policy: Pick<NormalizedRunPolicy, 'mutableGlobs' | 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): readonly string[] {
  if (!snapshot.changed.length && !snapshot.ignoredUntracked.length) throw new GitBoundaryError('candidate-empty', 'Candidate did not change any path')
  const violations: string[] = []
  for (const change of snapshot.changed) {
    const path = normalizeRepoPath(change.path); const exceptional = exceptionalCategory(path, change.submodule, policy)
    if (change.submodule && !matchesAny(path, policy.exceptionalAllowlists.submodules)) violations.push(`${path}: submodule not allowlisted`)
    if (!matchesAny(path, policy.mutableGlobs) && !exceptional) violations.push(`${path}: outside mutable paths`)
    if (isProtected(path) && !exceptional) violations.push(`${path}: protected surface`)
  }
  for (const value of snapshot.ignoredUntracked) {
    const path = normalizeRepoPath(value); const exceptional = exceptionalCategory(path, false, policy)
    if (!matchesAny(path, policy.mutableGlobs) && !exceptional) violations.push(`${path}: ignored untracked path not allowlisted`)
    if (isProtected(path) && !exceptional) violations.push(`${path}: protected surface`)
  }
  if (violations.length) throw new GitBoundaryError('candidate-policy-violation', 'Candidate changed forbidden paths', violations)
  return [...new Set([...snapshot.changed.map((change) => normalizeRepoPath(change.path)), ...snapshot.ignoredUntracked.map(normalizeRepoPath)])].sort()
}
export async function prepareCandidateTree(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, experimentId: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], options: Omit<GitCommandOptions, 'cwd'>): Promise<PreparedCandidateTree> {
  await enforceGitConfigBaseline(ctx, executable, worktree, snapshot.gitConfig, options)
  const invoke = (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => runGit(ctx, executable, args, { ...options, cwd: worktree, ...(env ? { env } : {}) })
  const auditRef = `${identity.candidateRefPrefix}${safeIdentity(experimentId, 'experimentId')}`
  const current = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (current !== snapshot.parentCommit) throw new GitBoundaryError('candidate-parent-moved', 'Accepted worktree HEAD moved after candidate snapshot')
  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-index-'))
  const indexEnv = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await invoke(['read-tree', snapshot.parentCommit], indexEnv)
    await invoke(['add', '-f', '--', ...validatedPaths], indexEnv)
    const staged = parseNameStatus((await invoke(['diff', '--cached', '--name-status', '-z'], indexEnv)).stdout)
    if (!sameSet(staged, validatedPaths)) throw new GitBoundaryError('candidate-stage-mismatch', 'Staged paths differ from validated paths', staged)
    const tree = (await invoke(['write-tree'], indexEnv)).stdout.trim()
    const parentDate = (await invoke(['show', '-s', '--format=%aI', snapshot.parentCommit])).stdout.trim()
    const commitEnv = { ...indexEnv, GIT_AUTHOR_NAME: 'dsh-autoresearch', GIT_AUTHOR_EMAIL: 'autoresearch@localhost', GIT_COMMITTER_NAME: 'dsh-autoresearch', GIT_COMMITTER_EMAIL: 'autoresearch@localhost', GIT_AUTHOR_DATE: parentDate, GIT_COMMITTER_DATE: parentDate }
    const candidateCommit = (await invoke(['commit-tree', tree, '-p', snapshot.parentCommit, '-m', `autoresearch candidate ${experimentId}`], commitEnv)).stdout.trim()
    const prepared = { parentCommit: snapshot.parentCommit, candidateCommit, auditRef, changedPaths: [...validatedPaths] }
    await verifyCandidateTree(ctx, executable, worktree, experimentId, snapshot, prepared, options)
    return prepared
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function verifyCandidateTree(ctx: GitContext, executable: string, worktree: string, experimentId: string, snapshot: CandidateSnapshot, candidate: PreparedCandidateTree, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  const invoke = (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => runGit(ctx, executable, args, { ...options, cwd: worktree, ...(env ? { env } : {}) })
  if (candidate.parentCommit !== snapshot.parentCommit) throw new GitBoundaryError('candidate-lineage-invalid', 'Prepared candidate parent differs from the durable snapshot')
  await verifyRecoverableCandidate(invoke, candidate.candidateCommit, snapshot, candidate.changedPaths, experimentId)
  await requireWorktreeMatches(invoke, candidate.candidateCommit)
}


export async function commitCandidate(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, experimentId: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], options: Omit<GitCommandOptions, 'cwd'>): Promise<CandidateCommit> {
  const auditRef = `${identity.candidateRefPrefix}${safeIdentity(experimentId, 'experimentId')}`
  const existingAudit = await readOptionalRef(ctx, executable, auditRef, worktree, options)
  if (existingAudit) {
    const recovered = { parentCommit: snapshot.parentCommit, candidateCommit: existingAudit, auditRef, changedPaths: [...validatedPaths] }
    await verifyCandidateTree(ctx, executable, worktree, experimentId, snapshot, recovered, options)
    return recovered
  }
  const prepared = await prepareCandidateTree(ctx, executable, worktree, identity, experimentId, snapshot, validatedPaths, options)
  await runGit(ctx, executable, ['update-ref', prepared.auditRef, prepared.candidateCommit, ZERO_SHA], { ...options, cwd: worktree })
  return prepared
}
export async function checkoutCandidateForEvaluation(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, candidateCommit: string, expectedParent: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(candidateCommit, 'candidate commit'); requireSha(expectedParent, 'candidate parent')
  const invoke = (args: readonly string[], extra?: Pick<GitCommandOptions, 'stdinData'>) => runGit(ctx, executable, args, { ...options, ...extra, cwd: worktree })
  const branchRef = `refs/heads/${identity.branch}`
  const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  await requireCandidateAudit(ctx, executable, worktree, identity, candidateCommit, options)
  if (head !== candidateCommit && head !== expectedParent) throw new GitBoundaryError('candidate-execution-identity', 'Candidate execution HEAD is not recoverable')
  if (head === expectedParent) await invoke(['update-ref', branchRef, candidateCommit, expectedParent])
  await invoke(['read-tree', '--reset', '-u', candidateCommit]); await invoke(['clean', '-ffdx'])
  await verifyExactWorktree(ctx, executable, worktree, candidateCommit, options)
}



export async function reconcileAcceptedHead(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, expectedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(expectedCommit, 'expected accepted commit'); await rejectExecutableGitConfig(ctx, executable, worktree, options); const invoke = (args: readonly string[], extra?: Pick<GitCommandOptions, 'stdinData'>) => runGit(ctx, executable, args, { ...options, ...extra, cwd: worktree }); const branchRef = `refs/heads/${identity.branch}`
  await requireCandidateAudit(ctx, executable, worktree, identity, expectedCommit, options); const parent = (await invoke(['rev-parse', '--verify', `${expectedCommit}^`])).stdout.trim()
  const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options); const branch = await readOptionalRef(ctx, executable, branchRef, worktree, options); const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (accepted === expectedCommit && branch === expectedCommit && head === expectedCommit) { await verifyExactWorktree(ctx, executable, worktree, expectedCommit, options); return }
  if (accepted !== parent || !([parent, expectedCommit].includes(String(branch)) && [parent, expectedCommit].includes(head))) throw new GitBoundaryError('accepted-reconcile-identity', 'Accepted ref, branch, and worktree HEAD are not a recoverable promotion state')
  await requireWorktreeMatches(invoke, expectedCommit); await invoke(['read-tree', '--reset', '-u', expectedCommit]); await verifyPreparedWorktree(invoke, expectedCommit)
  const transaction = `start\nupdate ${branchRef} ${expectedCommit} ${branch === expectedCommit ? expectedCommit : parent}\nupdate ${identity.acceptedRef} ${expectedCommit} ${parent}\nprepare\ncommit\n`
  await invoke(['update-ref', '--stdin'], { stdinData: transaction }); await verifyExactWorktree(ctx, executable, worktree, expectedCommit, options)
}

export async function reconcileRejectedHead(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, candidateCommit: string, expectedAcceptedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(candidateCommit, 'rejected candidate'); requireSha(expectedAcceptedCommit, 'expected accepted commit'); await rejectExecutableGitConfig(ctx, executable, worktree, options); const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree }); const branchRef = `refs/heads/${identity.branch}`
  await requireCandidateAudit(ctx, executable, worktree, identity, candidateCommit, options); const parent = (await invoke(['rev-parse', '--verify', `${candidateCommit}^`])).stdout.trim(); if (parent !== expectedAcceptedCommit) throw new GitBoundaryError('rejected-reconcile-lineage', 'Rejected candidate is not based on expected accepted commit')
  const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options); const branch = await readOptionalRef(ctx, executable, branchRef, worktree, options); const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (accepted !== expectedAcceptedCommit || !([expectedAcceptedCommit, candidateCommit].includes(String(branch)) && [expectedAcceptedCommit, candidateCommit].includes(head))) throw new GitBoundaryError('rejected-reconcile-identity', 'Accepted ref, branch, and HEAD are not a recoverable rejection state')
  await invoke(['read-tree', '--reset', '-u', expectedAcceptedCommit]); if (branch === candidateCommit) await invoke(['update-ref', branchRef, expectedAcceptedCommit, candidateCommit]); await invoke(['clean', '-ffdx']); await verifyExactWorktree(ctx, executable, worktree, expectedAcceptedCommit, options)
}
export async function restoreAcceptedWorktree(ctx: GitContext, executable: string, worktree: string, identity: RunGitIdentity, expectedAcceptedCommit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  requireSha(expectedAcceptedCommit, 'expected accepted commit')
  await rejectExecutableGitConfig(ctx, executable, worktree, options)
  const invoke = (args: readonly string[]) => runGit(ctx, executable, args, { ...options, cwd: worktree })
  const branchRef = `refs/heads/${identity.branch}`
  const accepted = await readOptionalRef(ctx, executable, identity.acceptedRef, worktree, options)
  const branch = await readOptionalRef(ctx, executable, branchRef, worktree, options)
  const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  if (accepted !== expectedAcceptedCommit || branch !== expectedAcceptedCommit || head !== expectedAcceptedCommit) throw new GitBoundaryError('restore-accepted-identity', 'Accepted ref, branch, and HEAD are not the durable restoration target')
  await invoke(['read-tree', '--reset', '-u', expectedAcceptedCommit]); await invoke(['clean', '-ffdx']); await verifyExactWorktree(ctx, executable, worktree, expectedAcceptedCommit, options)
}
export function releaseTerminalRunLock(tracker: DurableTracker, runId: string): boolean {
  const released = tracker.releaseActiveLock(runId)
  return releaseTerminalAuthority(tracker, runId) || released
}
export function recoverTerminalRunLock(tracker: DurableTracker, runId: string): boolean {
  const recovery = tracker.recoveryState(runId)
  if (!['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(String(recovery.run['state'])) || recovery.run['terminal_quiescent'] !== 1 || recovery.processDisposition !== 'quiescent') return false
  const released = tracker.releaseActiveLock(runId)
  return releaseTerminalAuthority(tracker, runId) || released
}
export function recoverTerminalRunLockUnderControllerClaim(tracker: DurableTracker, runId: string, ownerId: string, process: ControllerProcessIdentity): boolean {
  const recovery = tracker.recoveryState(runId)
  if (!['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(String(recovery.run['state'])) || recovery.run['terminal_quiescent'] !== 1 || recovery.processDisposition !== 'quiescent') return false
  const repositoryId = String(recovery.run['repository_id']); const runTag = String(recovery.run['run_tag'])
  const authority = openLockAuthority(tracker, runId)
  try {
    authority.exec('BEGIN IMMEDIATE')
    const claim = authority.prepare('SELECT owner_id, owner_pid, owner_start_token FROM controller_claims WHERE run_id = ?').get(runId)
    if (!claim || claim['owner_id'] !== ownerId || claim['owner_pid'] !== process.pid || (claim['owner_start_token'] === null ? undefined : String(claim['owner_start_token'])) !== process.startToken) throw new GitBoundaryError('run-controller-lost', 'Controller instance no longer owns this run')
    const row = authority.prepare('SELECT repository_id, run_tag FROM active_locks WHERE run_id = ?').get(runId)
    if (row && (row['repository_id'] !== repositoryId || row['run_tag'] !== runTag)) throw new GitBoundaryError('run-lock-identity', 'Shared active lock identity differs from the durable run')
    const released = tracker.releaseActiveLock(runId)
    const lock = authority.prepare('DELETE FROM active_locks WHERE run_id = ? AND repository_id = ? AND run_tag = ?').run(runId, repositoryId, runTag).changes
    authority.exec('COMMIT')
    return released || lock === 1
  } catch (error) {
    try { authority.exec('ROLLBACK') } catch { /* preserve rollback failure */ }
    throw error
  } finally { authority.close() }
}
function openLockAuthority(tracker: DurableTracker, runId: string): DatabaseSync {
  const run = tracker.getRun(runId)
  if (!run) throw new GitBoundaryError('run-lock-identity', 'Shared lock authority requires a durable run')
  const gitCommonDir = String(run['git_common_dir'])
  if (!isAbsolute(gitCommonDir)) throw new GitBoundaryError('run-lock-identity', 'Shared lock authority requires a canonical Git common directory')
  const path = join(gitCommonDir, 'dsh-autoresearch-locks.sqlite')
  const database = new DatabaseSync(path, { timeout: 5_000 })
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS active_locks (repository_id TEXT NOT NULL, run_tag TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, acquired_at TEXT NOT NULL, PRIMARY KEY (repository_id, run_tag)) STRICT; CREATE TABLE IF NOT EXISTS controller_claims (run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_pid INTEGER, owner_start_token TEXT, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL) STRICT')
  const columns = new Set((database.prepare('PRAGMA table_info(controller_claims)').all() as Record<string, unknown>[]).map(column => String(column['name'])))
  if (!columns.has('owner_pid')) database.exec('ALTER TABLE controller_claims ADD COLUMN owner_pid INTEGER')
  if (!columns.has('owner_start_token')) database.exec('ALTER TABLE controller_claims ADD COLUMN owner_start_token TEXT')
  return database
}

function releaseAuthorityLock(tracker: DurableTracker, runId: string): boolean {
  const run = tracker.getRun(runId)
  if (!run) throw new GitBoundaryError('run-lock-identity', 'Shared lock release requires a durable run')
  const repositoryId = String(run['repository_id']); const runTag = String(run['run_tag'])
  const authority = openLockAuthority(tracker, runId)
  try {
    const row = authority.prepare('SELECT repository_id, run_tag FROM active_locks WHERE run_id = ?').get(runId)
    if (row && (row['repository_id'] !== repositoryId || row['run_tag'] !== runTag)) throw new GitBoundaryError('run-lock-identity', 'Shared active lock identity differs from the durable run')
    return authority.prepare('DELETE FROM active_locks WHERE run_id = ? AND repository_id = ? AND run_tag = ?').run(runId, repositoryId, runTag).changes === 1
  } finally { authority.close() }
}

function releaseTerminalAuthority(tracker: DurableTracker, runId: string): boolean {
  const run = tracker.getRun(runId)
  if (!run) throw new GitBoundaryError('run-lock-identity', 'Shared terminal release requires a durable run')
  const repositoryId = String(run['repository_id']); const runTag = String(run['run_tag'])
  const authority = openLockAuthority(tracker, runId)
  try {
    authority.exec('BEGIN IMMEDIATE')
    const row = authority.prepare('SELECT repository_id, run_tag FROM active_locks WHERE run_id = ?').get(runId)
    if (row && (row['repository_id'] !== repositoryId || row['run_tag'] !== runTag)) throw new GitBoundaryError('run-lock-identity', 'Shared active lock identity differs from the durable run')
    const lock = authority.prepare('DELETE FROM active_locks WHERE run_id = ? AND repository_id = ? AND run_tag = ?').run(runId, repositoryId, runTag).changes
    const claim = authority.prepare('DELETE FROM controller_claims WHERE run_id = ?').run(runId).changes
    authority.exec('COMMIT')
    return lock === 1 || claim === 1
  } catch (error) {
    try { authority.exec('ROLLBACK') } catch { /* preserve rollback failure */ }
    throw error
  } finally { authority.close() }
}


export async function inspectRunGitState(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, options: Omit<GitCommandOptions, 'cwd'>): Promise<RunGitInspection> {
  const acceptedCommit = await readOptionalRef(ctx, executable, identity.acceptedRef, discovery.repository, options)
  const branchCommit = await readOptionalRef(ctx, executable, `refs/heads/${identity.branch}`, discovery.repository, options)
  const auditCommits = (await runGit(ctx, executable, ['for-each-ref', '--format=%(objectname)', identity.candidateRefPrefix], { ...options, cwd: discovery.repository })).stdout.split('\n').filter(Boolean)
  const registered = parseWorktreeList((await runGit(ctx, executable, ['worktree', 'list', '--porcelain'], { ...options, cwd: discovery.repository })).stdout).find(item => item.path === identity.worktree)
  const headCommit = registered ? await readOptionalRef(ctx, executable, 'HEAD^{commit}', identity.worktree, options) : undefined
  return { ...(acceptedCommit ? { acceptedCommit } : {}), ...(branchCommit ? { branchCommit } : {}), ...(headCommit ? { headCommit } : {}), auditCommits, worktreeRegistered: registered !== undefined, ...(registered?.branch ? { registeredBranch: registered.branch } : {}) }
}

export async function removeRunWorktree(ctx: GitContext, executable: string, discovery: RepositoryDiscovery, identity: RunGitIdentity, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  const result = await runGit(ctx, executable, ['worktree', 'list', '--porcelain'], {
    ...options,
    cwd: discovery.repository,
  })
  const worktrees = parseWorktreeList(result.stdout)
  if (!worktrees.some(item => item.path === identity.worktree)) return
  await runGit(ctx, executable, ['worktree', 'remove', identity.worktree], {
    ...options,
    cwd: discovery.repository,
  })
}

function validateControllerProcessIdentity(identity: ControllerProcessIdentity): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new TypeError('controller PID must be a positive integer')
  if (identity.startToken !== undefined && !/^\d+$/u.test(identity.startToken)) throw new TypeError('controller process start token must be numeric')
}
function linuxProcessStartToken(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    return fields[19]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
    throw error
  }
}
function priorControllerIsProvablyGone(claim: Record<string, unknown>): boolean {
  const pid = Number(claim['owner_pid'])
  const expected = claim['owner_start_token'] === null || claim['owner_start_token'] === undefined ? undefined : String(claim['owner_start_token'])
  if (!Number.isSafeInteger(pid) || pid <= 0 || expected === undefined || process.platform !== 'linux') return false
  const actual = linuxProcessStartToken(pid)
  return actual === undefined || actual !== expected
}
function safeGitArgs(args: readonly string[]): readonly string[] { return args[0] === '-e' ? args : ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'interactive.diffFilter=', ...args] }
function closedGitEnvironment(overrides: GitEnvironmentOverrides = {}): Record<string, string> { const base = scrubbedParentEnv(); for (const key of Object.keys(base)) if (/^GIT_/iu.test(key)) delete base[key]; const allowed: Readonly<Record<string, true>> = { GIT_INDEX_FILE: true, GIT_AUTHOR_NAME: true, GIT_AUTHOR_EMAIL: true, GIT_COMMITTER_NAME: true, GIT_COMMITTER_EMAIL: true, GIT_AUTHOR_DATE: true, GIT_COMMITTER_DATE: true }; for (const key of Object.keys(overrides)) if (allowed[key] !== true) throw new TypeError(`Unsupported Git environment override ${key}`); const explicit = Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => entry[1] !== undefined)); return { ...base, ...explicit, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '1', GIT_PAGER: 'cat' } }
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
function exceptionalCategory(path: string, submodule: boolean, policy: Pick<NormalizedRunPolicy, 'exceptionalAllowlists' | 'evaluation' | 'provenance'>): boolean { const lists = policy.exceptionalAllowlists; if (submodule && matchesAny(path, lists.submodules)) return true; if ((path === '.gitmodules' || path.startsWith('.git/')) && matchesAny(path, lists.gitConfig)) return true; if (/^(?:package\.json|.*lock.*|pnpm-workspace\.yaml)$/u.test(path) && matchesAny(path, lists.dependencies)) return true; const evaluatorPath = policy.evaluation.cwd ? `${policy.evaluation.cwd}/${policy.evaluation.command}` : policy.evaluation.command; const repositoryEvaluatorPath = evaluatorPath.startsWith('/') ? undefined : normalizeRepoPath(evaluatorPath); if ((path === repositoryEvaluatorPath || /(^|\/)(?:eval|evaluator)(?:\.|\/|$)/iu.test(path)) && matchesAny(path, lists.evaluators)) return true; if (policy.provenance.evaluator === path && matchesAny(path, lists.evaluators)) return true; if (policy.provenance.dataset === path && matchesAny(path, lists.datasets)) return true; return false }
function sameSet(left: readonly string[], right: readonly string[]): boolean { const a = [...left].sort(); const b = [...right].sort(); return a.length === b.length && a.every((value, index) => value === b[index]) }
function isUniqueConstraint(error: unknown): boolean { return String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT') || String(error).includes('UNIQUE constraint failed') }
function parseWorktreeList(value: string): Array<{ path: string; branch?: string }> { return value.trim().split(/\n\n+/u).filter(Boolean).map((block) => { const lines = block.split('\n'); const path = lines[0]?.startsWith('worktree ') ? lines[0].slice(9) : ''; const branch = lines.find((line) => line.startsWith('branch '))?.slice(7); return { path, ...(branch ? { branch } : {}) } }) }
function parseDeclaredTreeEntries(value: string): Array<{ mode: string; type: string; object: string; path: string }> {
  return value.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t')
    const header = record.slice(0, tab).split(' ')
    if (tab < 0 || header.length !== 3) throw new GitBoundaryError('git-manifest-tree-output', 'Git returned malformed declared-path tree metadata')
    return { mode: header[0]!, type: header[1]!, object: header[2]!, path: normalizeRepoPath(record.slice(tab + 1)) }
  }).sort((left, right) => left.path.localeCompare(right.path))
}
async function readOptionalRef(ctx: GitContext, executable: string, ref: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<string | undefined> { try { return (await runGit(ctx, executable, ['rev-parse', '--verify', ref], { ...options, cwd })).stdout.trim() } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return undefined; throw error } }
async function isAncestor(ctx: GitContext, executable: string, ancestor: string, descendant: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<boolean> { try { await runGit(ctx, executable, ['merge-base', '--is-ancestor', ancestor, descendant], { ...options, cwd }); return true } catch (error) { if (error instanceof GitBoundaryError && error.code === 'git-command-failed') return false; throw error } }
async function snapshotGitConfig(ctx: GitContext, executable: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<readonly GitConfigSnapshot[]> { const files: GitConfigSnapshot[] = []; for (const logicalPath of GIT_CONFIG_LOGICAL_PATHS) { const selector = logicalPath === '.git/config' ? 'config' : 'config.worktree'; const raw = (await runGit(ctx, executable, ['rev-parse', '--git-path', selector], { ...options, cwd })).stdout.trim(); const path = resolve(cwd, raw); try { files.push({ logicalPath, path, exists: true, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push({ logicalPath, path, exists: false }); else throw error } } return files }
async function rejectExecutableGitConfig(ctx: GitContext, executable: string, cwd: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> {
  const files = await snapshotGitConfig(ctx, executable, cwd, options); const hostile: string[] = []
  for (const file of files.filter((item) => item.exists)) {
    const result = await runGit(ctx, executable, ['config', '--file', file.path, '--no-includes', '--null', '--list'], { ...options, cwd })
    for (const entry of result.stdout.split('\0').filter(Boolean)) { const separator = entry.indexOf('\n'); const key = entry.slice(0, separator < 0 ? entry.length : separator).toLowerCase(); const value = separator < 0 ? '' : entry.slice(separator + 1); if (/^(?:include|includeif\..*)\.path$/u.test(key) || key === 'core.hookspath' || key === 'core.fsmonitor' && !/^(?:false|no|off|0)$/iu.test(value) || /^filter\..*\.(?:clean|smudge|process|required)$/u.test(key) || /^diff\..*\.(?:command|textconv)$/u.test(key) || /^merge\..*\.driver$/u.test(key)) hostile.push(`${file.logicalPath}:${key}`) }
  }
  if (hostile.length) throw new GitBoundaryError('git-config-unsafe', 'Repository Git configuration defines includes or executable helpers', hostile)
}
async function enforceGitConfigBaseline(ctx: GitContext, executable: string, cwd: string, baseline: GitConfigBaseline, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { await rejectExecutableGitConfig(ctx, executable, cwd, options); const current = await snapshotGitConfig(ctx, executable, cwd, options); const changed = current.filter((item) => { const before = baseline.files.find((entry) => entry.logicalPath === item.logicalPath); return JSON.stringify(before) !== JSON.stringify(item) && !baseline.allowedPaths.includes(item.logicalPath) }); if (changed.length) throw new GitBoundaryError('git-config-mutated', 'Git configuration changed after trusted baseline', changed.map((item) => item.logicalPath)) }
async function verifyRecoverableCandidate(invoke: (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => Promise<GitCommandResult>, commit: string, snapshot: CandidateSnapshot, validatedPaths: readonly string[], experimentId: string): Promise<void> { requireSha(commit, 'candidate commit'); const parent = (await invoke(['rev-parse', '--verify', `${commit}^`])).stdout.trim(); const subject = (await invoke(['show', '-s', '--format=%s', commit])).stdout.trim(); const paths = parseNameStatus((await invoke(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', commit])).stdout); if (parent !== snapshot.parentCommit || subject !== `autoresearch candidate ${experimentId}` || !sameSet(paths, validatedPaths)) throw new GitBoundaryError('candidate-lineage-invalid', 'Candidate commit does not match durable experiment identity') }
async function requireCandidateAudit(ctx: GitContext, executable: string, cwd: string, identity: RunGitIdentity, commit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { const refs = (await runGit(ctx, executable, ['for-each-ref', '--format=%(objectname)', identity.candidateRefPrefix], { ...options, cwd })).stdout.split('\n').filter(Boolean); if (!refs.includes(commit)) throw new GitBoundaryError('accepted-reconcile-audit', 'Candidate has no run-owned audit ref') }
async function requireWorktreeMatches(invoke: (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => Promise<GitCommandResult>, commit: string): Promise<void> { const directory = await mkdtemp(join(tmpdir(), 'autoresearch-verify-')); const env = { GIT_INDEX_FILE: join(directory, 'index') }; try { await invoke(['read-tree', 'HEAD'], env); await invoke(['add', '-A'], env); const ignored = parseNulPaths((await invoke(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout); if (ignored.length) await invoke(['add', '-f', '--', ...ignored], env); const actualTree = (await invoke(['write-tree'], env)).stdout.trim(); const expectedTree = (await invoke(['rev-parse', `${commit}^{tree}`])).stdout.trim(); if (actualTree !== expectedTree) throw new GitBoundaryError('accepted-reconcile-dirty', 'Worktree does not exactly match the recorded candidate') } finally { await rm(directory, { recursive: true, force: true }) } }
async function verifyPreparedWorktree(invoke: (args: readonly string[]) => Promise<GitCommandResult>, commit: string): Promise<void> { const indexTree = (await invoke(['write-tree'])).stdout.trim(); const expectedTree = (await invoke(['rev-parse', `${commit}^{tree}`])).stdout.trim(); if (indexTree !== expectedTree) throw new GitBoundaryError('git-prepare-mismatch', 'Prepared index does not match reconciliation target'); const extras = (await invoke(['ls-files', '--others', '-z'])).stdout; if (extras) throw new GitBoundaryError('git-prepare-extras', 'Prepared worktree contains untracked or ignored extras', parseNulPaths(extras)); await requireWorktreeMatches(invoke, commit) }
export async function verifyExactWorktree(ctx: GitContext, executable: string, worktree: string, commit: string, options: Omit<GitCommandOptions, 'cwd'>): Promise<void> { requireSha(commit, 'verified commit'); await rejectExecutableGitConfig(ctx, executable, worktree, options); const invoke = (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => runGit(ctx, executable, args, { ...options, cwd: worktree, ...(env ? { env: env as GitEnvironmentOverrides } : {}) }); const head = (await invoke(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(); if (head !== commit) throw new GitBoundaryError('git-verify-head', 'Worktree HEAD does not match verified commit'); await verifyPreparedWorktree(invoke, commit) }
async function isClean(invoke: (args: readonly string[]) => Promise<GitCommandResult>): Promise<boolean> { return (await invoke(['status', '--porcelain=v1', '-z'])).stdout.length === 0 }
async function requireClean(invoke: (args: readonly string[]) => Promise<GitCommandResult>): Promise<void> { if (!await isClean(invoke)) throw new GitBoundaryError('accepted-reconcile-dirty', 'Run worktree is not clean after reconciliation') }
