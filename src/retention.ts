import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedConfig } from './config.js'
import { acquireControllerClaim, GitBoundaryError, releaseControllerClaim } from './git.js'
import { StateLayout } from './state-layout.js'
import { DurableTracker } from './tracker.js'

const DAY_MS = 86_400_000
const RETENTION_CLAIM_MS = 30_000

type RetentionConfig = Pick<ResolvedConfig, 'artifactRetentionDays' | 'retainFailedArtifacts' | 'tsvRetentionDays'>

export interface RetentionSummary {
  readonly artifactsPruned: number
  readonly tsvDeleted: number
}

export function applyRunRetention(tracker: DurableTracker, runId: string, config: RetentionConfig, now = new Date()): RetentionSummary {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new TypeError('retention time must be valid')
  const artifactsPruned = tracker.pruneArtifacts(runId, cutoff(nowMs, config.artifactRetentionDays), config.retainFailedArtifacts)
  const tsvDeleted = Number(tracker.pruneTsv(runId, cutoff(nowMs, config.tsvRetentionDays)))
  return { artifactsPruned, tsvDeleted }
}

/** Lazily enforces repository-local retention without racing a live run controller. */
export function sweepRepositoryRetention(
  gitCommonDir: string,
  stateRoot: string,
  config: RetentionConfig,
  excludedRunId?: string,
  now = new Date(),
): RetentionSummary {
  const statePath = join(gitCommonDir, stateRoot)
  if (!exists(statePath)) return { artifactsPruned: 0, tsvDeleted: 0 }
  const state = StateLayout.open(statePath)
  const runsPath = join(state.root, 'runs')
  if (!exists(runsPath)) return { artifactsPruned: 0, tsvDeleted: 0 }
  const runs = StateLayout.open(runsPath)
  let artifactsPruned = 0
  let tsvDeleted = 0

  for (const entry of readdirSync(runs.root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new TypeError(`retention run entry must not be a symlink: ${entry.name}`)
    if (!entry.isDirectory()) continue
    const trackerPath = join(runs.root, entry.name, 'tracker.sqlite')
    if (!exists(trackerPath)) continue
    const tracker = DurableTracker.open(trackerPath)
    try {
      const rows = tracker.database.prepare('SELECT run_id FROM runs ORDER BY run_id').all()
      if (rows.length !== 1) throw new TypeError(`run tracker ${trackerPath} must contain exactly one run`)
      const runId = String(rows[0]?.['run_id'] ?? '')
      if (!runId || runId !== entry.name) throw new TypeError(`run tracker identity does not match directory ${entry.name}`)
      if (runId === excludedRunId) continue
      const ownerId = randomUUID()
      try {
        acquireControllerClaim(tracker, runId, ownerId, RETENTION_CLAIM_MS)
      } catch (error) {
        if (error instanceof GitBoundaryError && error.code === 'run-controller-active') continue
        throw error
      }
      try {
        const result = applyRunRetention(tracker, runId, config, now)
        artifactsPruned += result.artifactsPruned
        tsvDeleted += result.tsvDeleted
      } finally {
        releaseControllerClaim(tracker, runId, ownerId)
      }
    } finally {
      tracker.close()
    }
  }

  return { artifactsPruned, tsvDeleted }
}

function cutoff(nowMs: number, days: number): number {
  const duration = days * DAY_MS
  return Number.isFinite(duration) ? nowMs - duration : Number.NEGATIVE_INFINITY
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
