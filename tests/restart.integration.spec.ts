import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { AutoresearchRunController } from '../src/controller.ts'
import { DurableTracker } from '../src/tracker.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-restart-')); roots.push(root)
  execFileSync('git', ['init', '-b', 'main', root]); execFileSync('git', ['-C', root, 'config', 'user.name', 'Restart Test']); execFileSync('git', ['-C', root, 'config', 'user.email', 'restart@example.invalid'])
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'value.ts'), 'export const value = 1\n'); writeFileSync(join(root, 'evaluate.mjs'), readFileSync(join(import.meta.dirname, 'fixtures/restart/evaluator.mjs'))); writeFileSync(join(root, 'evaluate-descendant.mjs'), readFileSync(join(import.meta.dirname, 'fixtures/restart/evaluator-descendant.mjs')))
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  const ctx = new Context(); const subprocess = ctx.plugin(LocalSubprocessRuntime, {}); await subprocess
  const parent = { id: 'restart-parent', session: { header: { id: 'restart-session', cwd: root } }, ctx } as unknown as Agent
  return { root, ctx, parent, dispose: () => subprocess.dispose() }
}

interface RestartFixture { root: string; ctx: Context; parent: Agent; dispose(): Promise<void> }
function controller(f: RestartFixture, tag: string, maxActiveRunsPerRepository = 2, resumeRunId?: string, hang = false, descendantMarker?: string) {
  const input = {
    repository: f.root, ...(resumeRunId ? { resume_run_id: resumeRunId } : { run_tag: tag }), objective: 'exercise restart', mutable_globs: ['src/**'],
    evaluation: descendantMarker ? { command: process.execPath, args: ['evaluate-descendant.mjs'] } : hang ? { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } : { command: process.execPath, args: ['evaluate.mjs'] },
    ...(descendantMarker ? { environment: { AUTORESEARCH_MARKER: descendantMarker } } : {}), metric_name: 'score', metric_direction: 'minimize' as const, max_experiments: 1, mode: 'foreground' as const,
  }
  return new AutoresearchRunController(f.ctx, { config: resolveConfig({ stateRoot: '.restart-state', maxActiveRunsPerRepository, cleanupWorktreesOnSuccess: false, retainWorktrees: true, exportTsv: false }), input, parent: f.parent, signal: new AbortController().signal })
}

describe('controller restart and repository concurrency integration', () => {
  it('enforces duplicate tags and repository capacity through one shared SQLite authority, then releases for reuse', async () => {
    const f = await fixture()
    try {
      const first = controller(f, 'shared', 2, undefined, true); const second = controller(f, 'distinct', 2, undefined, true)
      const firstRun = first.run(); const secondRun = second.run(); const [a, b] = await Promise.all([first.ready, second.ready])
      expect(a.runId).not.toBe(b.runId); expect(a.branch).not.toBe(b.branch); expect(a.worktree).not.toBe(b.worktree)
      const duplicate = controller(f, 'shared', 2, undefined, true); const duplicateRun = duplicate.run(); await expect(duplicateRun).rejects.toMatchObject({ code: 'run-tag-active' })
      const overLimit = controller(f, 'third', 2, undefined, true); const overLimitRun = overLimit.run(); await expect(overLimitRun).rejects.toMatchObject({ code: 'repository-active-limit' })
      expect(execFileSync('git', ['-C', f.root, 'status', '--porcelain']).toString()).toBe('')
      expect(execFileSync('git', ['-C', f.root, 'symbolic-ref', '--short', 'HEAD']).toString().trim()).toBe('main')
      first.cancel('terminal release'); await firstRun
      const reused = controller(f, 'shared', 2, undefined, true); const reusedRun = reused.run(); const reusedReady = await reused.ready; expect(reusedReady.runId).not.toBe(a.runId)
      second.cancel('cleanup'); reused.cancel('cleanup'); await Promise.all([secondRun, reusedRun])
    } finally { await f.dispose() }
  })

  it('recovers a crash after local terminal release and before shared authority deletion', async () => {
    const f = await fixture()
    const original = DurableTracker.prototype.releaseActiveLock
    let injected = false
    const fault = vi.spyOn(DurableTracker.prototype, 'releaseActiveLock').mockImplementation(function (runId, releasedAt) {
      const released = original.call(this, runId, releasedAt)
      if (!injected && released) { injected = true; throw new Error('fault after local release') }
      return released
    })
    try {
      const interrupted = controller(f, 'release-window', 1); const identity = await interrupted.prepare()
      await expect(interrupted.run()).rejects.toThrow('fault after local release')
      fault.mockRestore()
      const tracker = DurableTracker.open(identity.tracker)
      expect(tracker.recoveryState(identity.runId).activeLock).toBeUndefined()
      tracker.close()
      const authorityPath = join(f.root, '.git', 'dsh-autoresearch-locks.sqlite')
      const authority = new DatabaseSync(authorityPath)
      expect(authority.prepare('SELECT repository_id, run_tag FROM active_locks WHERE run_id = ?').get(identity.runId)).toMatchObject({ run_tag: 'release-window' })
      authority.close()

      const resumed = controller(f, '', 1, identity.runId); const terminal = await resumed.run()
      expect(terminal.runId).toBe(identity.runId)
      const reconciled = new DatabaseSync(authorityPath)
      expect(reconciled.prepare('SELECT 1 FROM active_locks WHERE run_id = ?').get(identity.runId)).toBeUndefined()
      reconciled.close()

      const reused = controller(f, 'release-window', 1, undefined, true); const running = reused.run(); const reusedIdentity = await reused.ready
      expect(reusedIdentity.runId).not.toBe(identity.runId)
      reused.cancel('cleanup'); await running
    } finally { fault.mockRestore(); await f.dispose() }
  })

  it('requires explicit controller release before resuming the same durable lineage exactly once', async () => {
    const f = await fixture()
    try {
      const interrupted = controller(f, 'resume', 1); const ready = await interrupted.prepare()
      const authority = new DatabaseSync(join(f.root, '.git', 'dsh-autoresearch-locks.sqlite'))
      authority.prepare('UPDATE controller_claims SET expires_at = ? WHERE run_id = ?').run('2000-01-01T00:00:00.000Z', ready.runId)
      authority.close()
      const before = DurableTracker.open(ready.tracker)
      const durableBefore = { run: before.getRun(ready.runId), transitions: before.listTransitions(ready.runId), experiments: before.database.prepare('SELECT * FROM experiments WHERE run_id = ?').all(ready.runId), attempts: before.database.prepare('SELECT * FROM attempts WHERE run_id = ?').all(ready.runId) }
      before.close()
      const competing = controller(f, '', 1, ready.runId)
      await expect(competing.run()).rejects.toMatchObject({ code: 'run-controller-active' })
      const after = DurableTracker.open(ready.tracker)
      expect({ run: after.getRun(ready.runId), transitions: after.listTransitions(ready.runId), experiments: after.database.prepare('SELECT * FROM experiments WHERE run_id = ?').all(ready.runId), attempts: after.database.prepare('SELECT * FROM attempts WHERE run_id = ?').all(ready.runId) }).toEqual(durableBefore)
      after.close()
      await interrupted.dispose()
      const resumed = controller(f, '', 1, ready.runId); const result = await resumed.run(); const resumedReady = await resumed.ready
      expect(resumedReady).toEqual(ready); expect(result.runId).toBe(ready.runId); expect(result.counts.attempts).toBe(1)
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare('SELECT COUNT(*) AS count FROM experiments WHERE run_id = ?').get(ready.runId)?.['count']).toBe(1)
      expect(tracker.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(ready.runId)?.['count']).toBe(1)
      tracker.close()
    } finally { await f.dispose() }
  })
  it('resumes after a public controller interruption following actual lock and worktree allocation', async () => {
    const f = await fixture()
    const original = DurableTracker.prototype.transitionRun
    let injected = false
    const fault = vi.spyOn(DurableTracker.prototype, 'transitionRun').mockImplementation(function (runId, to, facts, at) {
      const transition = original.call(this, runId, to, facts, at)
      if (!injected && to === 'baseline-running') { injected = true; throw new Error('fault after allocation') }
      return transition
    })
    try {
      const interrupted = controller(f, 'allocated', 1); const identity = await interrupted.prepare()
      await expect(interrupted.run()).rejects.toThrow('fault after allocation')
      fault.mockRestore()
      expect(execFileSync('git', ['-C', f.root, 'worktree', 'list', '--porcelain']).toString()).toContain(identity.worktree)
      const resumed = controller(f, '', 1, identity.runId); const result = await resumed.run()
      expect(result.runId).toBe(identity.runId)
      const tracker = DurableTracker.open(identity.tracker)
      expect(tracker.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(identity.runId)?.['count']).toBe(1)
      tracker.close()
    } finally { fault.mockRestore(); await f.dispose() }
  })

  it('cancels a real evaluator descendant tree and resumes the terminal lineage without duplicate attempts', async () => {
    const f = await fixture(); const marker = join(f.root, 'descendant.json')
    try {
      const interrupted = controller(f, 'descendant', 1, undefined, false, marker); const running = interrupted.run(); const ready = await interrupted.ready
      for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(10)
      const pids = JSON.parse(readFileSync(marker, 'utf8')) as { parent: number; descendant: number }
      interrupted.cancel('operator cancellation')
      const cancelled = await running
      expect(cancelled).toMatchObject({ runId: ready.runId, status: 'cancelled', quiescent: true, counts: { attempts: 1 } })
      for (const pid of [pids.parent, pids.descendant]) expect(() => process.kill(pid, 0)).toThrow()
      const resumed = controller(f, '', 1, ready.runId, false, marker); const terminal = await resumed.run()
      expect(terminal).toMatchObject({ runId: ready.runId, status: 'cancelled', counts: { attempts: 1 } })
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare('SELECT process_tree_quiescent FROM attempts WHERE run_id = ?').get(ready.runId)).toEqual({ process_tree_quiescent: 1 })
      tracker.close()
    } finally { await f.dispose() }
  })
  it('reruns exactly once after a proven-quiescent attempt with no durable outcome', async () => {
    const f = await fixture(); const original = DurableTracker.prototype.recordAttemptOutcome; let interruptions = 0
    const fault = vi.spyOn(DurableTracker.prototype, 'recordAttemptOutcome').mockImplementation(function (attemptId, facts) {
      if (interruptions < 2) {
        interruptions++
        this.database.prepare('UPDATE attempts SET process_tree_quiescent = 1 WHERE attempt_id = ?').run(attemptId)
        throw new Error(`fault after quiescence before outcome ${interruptions}`)
      }
      return original.call(this, attemptId, facts)
    })
    try {
      const interrupted = controller(f, 'incomplete', 1); const identity = await interrupted.prepare()
      await expect(interrupted.run()).rejects.toThrow('fault after quiescence before outcome 1')
      const rerun = controller(f, '', 1, identity.runId)
      await expect(rerun.run()).rejects.toThrow('fault after quiescence before outcome 2')
      fault.mockRestore()
      const resumed = controller(f, '', 1, identity.runId); const result = await resumed.run()
      expect(result).toMatchObject({ runId: identity.runId, status: 'round-failed' })
      const tracker = DurableTracker.open(identity.tracker)
      expect(tracker.database.prepare('SELECT ordinal, process_tree_quiescent, exited_at FROM attempts WHERE run_id = ? ORDER BY ordinal').all(identity.runId)).toEqual([
        { ordinal: 1, process_tree_quiescent: 1, exited_at: null },
        { ordinal: 2, process_tree_quiescent: 1, exited_at: null },
      ])
      expect(tracker.database.prepare('SELECT state, failure_code FROM experiments WHERE run_id = ?').get(identity.runId)).toEqual({ state: 'crashed', failure_code: 'recovery-rerun-exhausted' })
      tracker.close()
    } finally { fault.mockRestore(); await f.dispose() }
  })


})
