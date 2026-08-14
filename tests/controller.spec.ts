import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
})
