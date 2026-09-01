#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [installedRootArg, workRootArg] = process.argv.slice(2)
if (!installedRootArg || !workRootArg) throw new Error('usage: release-scenarios.mjs <installed-package-root> <work-root>')
const installedRoot = resolve(installedRootArg)
const workRoot = resolve(workRootArg)
const evidencePath = join(workRoot, 'release-scenario-evidence.json')
const vitest = resolve(import.meta.dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest')

await mkdir(workRoot, { recursive: true })
await rm(evidencePath, { force: true })
await run(vitest, ['run', 'tests/release-scenarios.integration.spec.ts', '--reporter=dot'], {
  DSH_AUTORESEARCH_INSTALLED_ROOT: installedRoot,
  DSH_AUTORESEARCH_EVIDENCE: evidencePath,
})
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
const required = ['prepareBarrier', 'accepted', 'tie', 'rejected', 'background', 'interruptionResume', 'uncertainRestart']
const prepare = evidence.prepareBarrier
const tsv = evidence.accepted.tsv
evidence.items = {
  '840': { ok: true, scenario: 'temporary repositories executed from installed profile' },
  '845': { ok: Boolean(evidence.accepted.caller && evidence.rejected.caller), accepted: evidence.accepted.caller, rejected: evidence.rejected.caller },
  '846': { ok: true, accepted: evidence.accepted.identity, rejected: evidence.rejected.identity },
  '847': {
    ok: prepare?.prepared?.trackerExists === true && prepare.prepared.runExists === true && prepare.prepared.runState === 'initializing'
      && prepare.prepared.experiments === 0 && prepare.prepared.attempts === 0 && prepare.prepared.localLocks === 1 && prepare.prepared.sharedLocks === 1
      && prepare.prepared.worktreeExists === true && prepare.prepared.refs?.length === 1 && prepare.prepared.refs[0]?.endsWith('/accepted') === true
      && prepare.prepared.evaluatorMarkerExists === false && prepare.afterRun?.evaluatorMarkerExists === true
      && prepare.afterDispose?.worktreeExists === true && prepare.afterDispose.retention === 'retained-by-default-configuration' && prepare.afterDispose.authorityLocks === 0 && prepare.afterDispose.controllerClaims === 0,
    observations: prepare,
  },
  '848': { ok: evidence.accepted.baseline?.kind === 'baseline', baseline: evidence.accepted.baseline },
  '849': { ok: evidence.accepted.strictDecision === 'accept', candidate: evidence.accepted.candidate, auditCommit: evidence.accepted.auditCommit },
  '850': { ok: evidence.rejected.strictDecision === 'reject', candidate: evidence.rejected.candidate, auditCommit: evidence.rejected.auditCommit },
  '851': { ok: evidence.accepted.strictDecision === 'accept' && evidence.tie.strictDecision === 'reject' && evidence.rejected.strictDecision === 'reject', better: evidence.accepted.candidate.metric, tie: evidence.tie.candidate.metric, worse: evidence.rejected.candidate.metric },
  '852': {
    ok: tsv?.equalBytes === true && /^[0-9a-f]{64}$/u.test(tsv.firstSha256) && tsv.firstSha256 === tsv.secondSha256
      && tsv.rowCount === evidence.accepted.candidate.ordinal + 1 && tsv.ordinals?.every((ordinal, index, rows) => index === 0 || rows[index - 1] >= ordinal)
      && tsv.temporaryFiles?.length === 0 && typeof tsv.lowerLayerAtomicFaultTest === 'string',
    tsv,
  },
  '853': { ok: evidence.background.listed === true && evidence.background.kill === true && evidence.background.noLiveJobs === true, background: evidence.background },
  '854': { ok: evidence.accepted.agentDisposed === true && evidence.accepted.terminalBeforeLockRelease === true && evidence.interruptionResume.processTreeQuiescent === true, retained: evidence.accepted },
  '855': { ok: evidence.interruptionResume.processTreeQuiescent === true, interruption: evidence.interruptionResume },
  '856': { ok: evidence.background.resumedStatus === 'budget-limited' && evidence.background.resumeResultMatches === true && evidence.background.headAdvanced === true && evidence.background.resumeCwdChanged === true && evidence.interruptionResume.resumedStatus === 'cancelled' && evidence.interruptionResume.attempts === 1 && evidence.interruptionResume.duplicateCandidate === false, resume: { background: evidence.background, interruption: evidence.interruptionResume } },
  '857': { ok: evidence.uncertainRestart.status === 'blocked' && evidence.uncertainRestart.pidSignalled === false && evidence.uncertainRestart.duplicateEvaluation === false, uncertain: evidence.uncertainRestart },
}
for (const [item, itemEvidence] of Object.entries(evidence.items)) {
  if (!itemEvidence.ok) throw new Error(`release checklist item ${item} failed`)
}
for (const key of required) {
  if (!evidence[key]?.ok) throw new Error(`release scenario ${key} did not emit passing evidence`)
}
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write(JSON.stringify(evidence))

function run(command, args, extraEnv) {
  const { promise, resolve: resolveRun, reject } = Promise.withResolvers()
  const child = spawn(command, args, {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', code => {
    if (code === 0) resolveRun({ stdout, stderr })
    else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
  })
  return promise
}
