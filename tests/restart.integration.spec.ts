import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { AutoresearchRunController } from '../src/controller.ts'
import { DurableTracker } from '../src/tracker.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoresearch-restart-')); roots.push(root)
  execFileSync('git', ['init', '-b', 'main', root]); execFileSync('git', ['-C', root, 'config', 'user.name', 'Restart Test']); execFileSync('git', ['-C', root, 'config', 'user.email', 'restart@example.invalid'])
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'value.ts'), 'export const value = 1\n'); writeFileSync(join(root, 'evaluate.mjs'), readFileSync(join(import.meta.dirname, 'fixtures/restart/evaluator.mjs')))
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  const ctx = new Context(); const subprocess = ctx.plugin(LocalSubprocessRuntime, {}); await subprocess
  const parent = { id: 'restart-parent', session: { header: { id: 'restart-session', cwd: root } }, ctx } as unknown as Agent
  return { root, ctx, parent, dispose: () => subprocess.dispose() }
}

interface RestartFixture { root: string; ctx: Context; parent: Agent; dispose(): Promise<void> }
function controller(f: RestartFixture, tag: string, maxActiveRunsPerRepository = 2, resumeRunId?: string, hang = false) {
  const input = {
    repository: f.root, ...(resumeRunId ? { resume_run_id: resumeRunId } : { run_tag: tag }), objective: 'exercise restart', mutable_globs: ['src/**'],
    evaluation: hang ? { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } : { command: process.execPath, args: ['evaluate.mjs'] }, metric_name: 'score', metric_direction: 'minimize' as const, max_experiments: 1, mode: 'foreground' as const,
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

  it('resumes through the public controller after allocation with the same durable identity and one baseline attempt', async () => {
    const f = await fixture()
    try {
      const interrupted = controller(f, 'resume', 1); const ready = await interrupted.prepare()
      const resumed = controller(f, '', 1, ready.runId); const result = await resumed.run(); const resumedReady = await resumed.ready
      expect(resumedReady).toEqual(ready); expect(result.runId).toBe(ready.runId); expect(result.counts.attempts).toBe(1)
      const tracker = DurableTracker.open(ready.tracker)
      expect(tracker.database.prepare('SELECT COUNT(*) AS count FROM experiments WHERE run_id = ?').get(ready.runId)?.['count']).toBe(1)
      expect(tracker.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(ready.runId)?.['count']).toBe(1)
      tracker.close(); await interrupted.dispose()
    } finally { await f.dispose() }
  })
})
