import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileRecovery, type RecoveryRequest } from '../src/recovery.ts'
import { DurableTracker } from '../src/tracker.ts'
import type { NormalizedRunPolicy } from '../src/types.ts'

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
  const policy = { repository, objective: 'improve', constraints: [], mutableGlobs: ['src/**'], exceptionalAllowlists: { dependencies: [], evaluators: [], datasets: [], gitConfig: [], submodules: [] }, evaluation: { command: 'node', args: ['evaluate.mjs'] }, metricName: 'score', metricDirection: 'minimize', timeoutMs: 1_000, maxExperiments: 2, provenance: {}, environment: {}, mode: 'foreground' } satisfies NormalizedRunPolicy
  const discovery = { repository, callerCwd: repository, gitCommonDir, repositoryId: 'repo-id', startCommit: SHA }
  const identity = { runId, runTag: 'tag', branch: 'autoresearch/tag-run-1', worktree, acceptedRef: 'refs/autoresearch/runs/run-1/accepted', candidateRefPrefix: 'refs/autoresearch/runs/run-1/candidates/' }
  const request = { tracker, runId, discovery, identity, policy, policySha256: HASH, provenanceSha256: HASH, gitExecutable: '/usr/bin/git', gitOptions: { timeoutMs: 1_000, graceMs: 100, maxStdoutBytes: 10_000, maxStderrBytes: 10_000 }, signal: new AbortController().signal } satisfies RecoveryRequest
  return { tracker, request }
}

function createRun(tracker: DurableTracker, request: RecoveryRequest): void {
  tracker.createRun({ runId: request.runId, repositoryId: request.discovery.repositoryId, repository: request.discovery.repository, gitCommonDir: request.discovery.gitCommonDir, callerCwd: request.discovery.callerCwd, startCommit: request.discovery.startCommit, runTag: request.identity.runTag, branch: request.identity.branch, worktree: request.identity.worktree, policy: request.policy, policySha256: request.policySha256, provenance: {}, provenanceSha256: request.provenanceSha256 })
}

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
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'initialize', runId: request.runId, startCommit: SHA })
    tracker.close()
  })

  it.each(['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'] as const)('classifies terminal %s and releases only a retained safe lock', async state => {
    const { tracker, request } = fixture(); createRun(tracker, request)
    tracker.acquireActiveLock(request.runId, request.discovery.repositoryId, request.identity.runTag)
    if (state === 'completed' || state === 'round-failed') tracker.transitionRun(request.runId, 'baseline-running')
    tracker.transitionRun(request.runId, state, state === 'completed' ? { best: { metric: 1, commit: SHA, experimentId: 'baseline' } } : { terminalReason: state, blockedCode: state })
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'terminal', runId: request.runId, state, lock: 'release' })
    tracker.releaseActiveLock(request.runId)
    await expect(reconcileRecovery(unusedContext, request)).resolves.toEqual({ kind: 'terminal', runId: request.runId, state, lock: 'already-released' })
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
})
