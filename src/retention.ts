import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedConfig } from './config.js'
import { acquireControllerClaim, GitBoundaryError, releaseControllerClaim } from './git.js'
import { StateLayout } from './state-layout.js'
import { DurableTracker, TRACKER_SCHEMA_VERSION } from './tracker.js'
import { classifyDurableRegistration } from './recovery.js'

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
    const inspection = DurableTracker.openReadOnly(trackerPath)
    let runId = ''
    let acceptedIdentity: RetentionIdentity | undefined
    let acceptedClassification: 'legacy' | 'registered' = 'legacy'
    try {
      const rows = inspection.database.prepare('SELECT * FROM runs ORDER BY run_id').all()
      if (rows.length === 0) continue
      if (rows.length !== 1) throw new TypeError(`run tracker ${trackerPath} must contain exactly one run`)
      const row = rows[0]!
      runId = String(row['run_id'] ?? '')
      if (!runId || runId !== entry.name) throw new TypeError(`run tracker identity does not match directory ${entry.name}`)
      if (runId === excludedRunId) continue
      const classification = classifyDurableRegistration(inspection, runId)
      const terminal = ['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(String(row['state']))
      if (!terminal) continue
      if (classification.kind === 'blocked') throw new TypeError(`run tracker ${trackerPath} has corrupt evaluator registration: ${classification.evidence.message}`)
      acceptedClassification = classification.kind
      acceptedIdentity = retentionIdentity(row, classification.kind === 'registered' ? classification.identity : null)
    } finally {
      inspection.close()
    }
    const tracker = DurableTracker.open(trackerPath)
    try {
      const row = tracker.getRun(runId)
      if (!row) throw new TypeError(`run tracker ${trackerPath} lost its accepted run row before writable retention open`)
      const classification = classifyDurableRegistration(tracker, runId)
      if (classification.kind === 'blocked') throw new TypeError(`run tracker ${trackerPath} has corrupt evaluator registration after writable open: ${classification.evidence.message}`)
      const currentIdentity = retentionIdentity(row, classification.kind === 'registered' ? classification.identity : null)
      if (tracker.schemaVersion() !== TRACKER_SCHEMA_VERSION) throw new TypeError(`run tracker ${trackerPath} did not reach the canonical current schema after writable open`)
      if (acceptedIdentity === undefined || JSON.stringify(currentIdentity) !== JSON.stringify(acceptedIdentity) || classification.kind !== acceptedClassification) throw new TypeError(`run tracker ${trackerPath} changed between read-only retention classification and writable open`)
      if (!['completed', 'baseline-blocked', 'blocked', 'round-failed', 'cancelled'].includes(String(row['state']))) continue
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

interface RetentionIdentity {
  readonly run: Readonly<Record<string, unknown>>
  readonly registration: unknown
}

const RETENTION_RUN_FIELDS = [
  'run_id', 'repository_id', 'repository', 'git_common_dir', 'caller_cwd', 'start_commit', 'run_tag', 'branch', 'worktree',
  'agent_id', 'session_id', 'policy_json', 'policy_sha256', 'provenance_json', 'provenance_sha256', 'state',
  'best_metric', 'best_commit', 'best_experiment_id', 'terminal_reason', 'blocked_code', 'terminal_at', 'created_at', 'updated_at',
] as const

/** Compares every v1 semantic fact and normalizes the sole runs field added by canonical v2-v8 migrations. */
function retentionIdentity(row: Readonly<Record<string, unknown>>, registration: unknown): RetentionIdentity {
  const run: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of RETENTION_RUN_FIELDS) run[field] = row[field]
  run['terminal_quiescent'] = row['terminal_quiescent'] ?? null
  return { run, registration }
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
