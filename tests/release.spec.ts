import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { assertExactTarballEntries, EXPECTED_TARBALL_ENTRIES, isolatedDshEnvironment } from '../scripts/release-smoke.mjs'

const root = join(import.meta.dirname, '..')
const run = promisify(execFile)

describe('release and consumer contract', () => {
  it('enforces the deterministic packed-file allowlist', () => {
    expect(() => assertExactTarballEntries([...EXPECTED_TARBALL_ENTRIES, 'package/lib/stale.js'])).toThrow(/unexpected=.*stale\.js/)
    expect(() => assertExactTarballEntries(EXPECTED_TARBALL_ENTRIES.filter(path => path !== 'package/lib/index.d.ts'))).toThrow(/missing=.*index\.d\.ts/)
  })

  it('overrides inherited profile roots and removes unrelated DSH controls', () => {
    expect(isolatedDshEnvironment({ PATH: '/bin', HOME: '/real', DSH_HOME: '/external', DSH_PROFILE: 'real', DSH_CONFIG: '/real/config' }, '/tmp/home', '/tmp/dsh-home')).toEqual({ PATH: '/bin', HOME: '/tmp/home', DSH_HOME: '/tmp/dsh-home' })
  })

  it('emits structured real Git/SQLite/subprocess scenario evidence', async () => {
    const work = await mkdtemp(join(tmpdir(), 'release-scenarios-test-'))
    try {
      const { stdout } = await run(process.execPath, [join(root, 'scripts', 'release-scenarios.mjs'), root, work])
      const evidence = JSON.parse(stdout)
      expect(evidence).toMatchObject({
        ok: true,
        prepareBarrier: { ok: true, prepared: { trackerExists: true, runExists: true, runState: 'initializing', experiments: 0, attempts: 0, localLocks: 1, sharedLocks: 1, worktreeExists: true, refs: [expect.stringMatching(/^refs\/autoresearch\/runs\/[0-9a-f-]+\/accepted$/)], evaluatorMarkerExists: false }, afterRun: { evaluatorMarkerExists: true }, afterDispose: { worktreeExists: true, authorityLocks: 0, controllerClaims: 0 } },
        accepted: { ok: true, strictDecision: 'accept', terminalBeforeLockRelease: true, agentDisposed: true, tsv: { equalBytes: true, firstSha256: expect.stringMatching(/^[0-9a-f]{64}$/), secondSha256: expect.stringMatching(/^[0-9a-f]{64}$/), temporaryFiles: [] } },
        tie: { ok: true, strictDecision: 'reject', terminalBeforeLockRelease: true, agentDisposed: true },
        rejected: { ok: true, strictDecision: 'reject', terminalBeforeLockRelease: true, agentDisposed: true },
        continuedFailure: { ok: true, attempts: 3, candidates: 2, resumedEqual: true },
        background: { ok: true, listed: true, kill: true, noLiveJobs: true, resumedStatus: 'budget-limited', resumeResultMatches: true, headAdvanced: true, resumeCwdChanged: true },
        interruptionResume: { ok: true, processTreeQuiescent: true, resumedStatus: 'cancelled', attempts: 1, duplicateCandidate: false },
        uncertainRestart: { ok: true, status: 'blocked', pidSignalled: false, duplicateEvaluation: false, lockRetained: true },
        items: Object.fromEntries(['840','845','846','847','848','849','850','851','852','853','854','855','856','857'].map(item => [item, { ok: true }])),
      })
      expect(evidence.accepted.tsv.firstSha256).toBe(evidence.accepted.tsv.secondSha256)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 500_000)

})
