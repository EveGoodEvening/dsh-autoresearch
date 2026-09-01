import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { assertExactTarballEntries, EXPECTED_TARBALL_ENTRIES, isolatedDshEnvironment, resolveReleaseSmokeOptions } from '../scripts/release-smoke.mjs'
import { TRACKER_SCHEMA_VERSION } from '../src/tracker.ts'
import { ACTIVATION_AUTORESEARCH_TOOL_SCHEMA } from '../src/types.ts'

const root = join(import.meta.dirname, '..')
const run = promisify(execFile)

const VERSIONED_TARBALL = /\bdsh-autoresearch-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.tgz\b/u
const LITERAL_TRACKER_SCHEMA = /\bschema v\d+\b/iu
const LEGACY_NONTERMINAL_RESUME_BLOCKER = 'legacy-evaluator-policy-unsupported'
function affirmativeSentence(claim: string) {
  return new RegExp(
    String.raw`(?:^|[.!?]\s+)(?![^.!?\n]*\b(?:no|not|never|cannot|can't|doesn't|isn't|aren't|won't|without)\b)[^.!?\n]*(?:${claim})`,
    'imu',
  )
}


function assertBoundedControllerReadme(readme: string) {
  for (const requiredQualification of [
    'TRACKER_SCHEMA_VERSION in src/tracker.ts',
    'artifact emitted by `pnpm pack` (the filename is derived from `package.json`)',
    'does not provide hostile-code filesystem, process, same-UID, privilege, or network isolation',
    'external sandbox or read-only execution provider',
    'Linux `/proc/<pid>/stat` start-token evidence',
    'on non-Linux systems a stale claim remains conservatively blocked; lease expiry alone is not proof that its owner died',
    'Comparable compute methodology belongs to the trusted evaluator and remains identical through the frozen registration',
    'Strict improvement of the configured scalar metric against the current best',
    'They are not a Host-enforced simplicity criterion, complexity field, authoritative report field, or acceptance tie-breaker',
    'Configured deployment maximum candidate cap (the shipped default, not a universal code constant)',
    'not full logs or patches',
    'Only exact configured secret values are redacted',
    'never automatically converted or reinterpreted as satisfying the current Host-registration contract',
    'Ordinary SQLite tracker schema migrations may still occur during retention or other writable maintenance; those migrations do not create an evaluator registration or grant resume authority',
    'There is no indefinite mode or automatic run chaining',
    'permits the next bounded candidate',
    'exact pre-cancellation run state (`lastState`)',
  ]) expect(readme).toContain(requiredQualification)

  for (const forbiddenPositiveClaim of [
    affirmativeSentence(String.raw`(?:provides?|guarantees?) hostile-code (?:filesystem, process, same-UID, privilege, or network )?isolation`),
    affirmativeSentence(String.raw`(?:controller|plugin) (?:enforces?|guarantees?) (?:an? )?(?:exact )?fair-compute budget`),
    affirmativeSentence(String.raw`(?:complexity|simplicity) (?:score )?(?:is|as) (?:an? )?(?:acceptance )?tie-breaker`),
    affirmativeSentence(String.raw`lease expiry (?:proves|establishes|is) (?:that )?(?:the )?owner (?:has )?died`),
    affirmativeSentence(String.raw`automatic takeover[^.\n]*non-Linux`),
    affirmativeSentence(String.raw`research memory (?:includes?|contains?|receives?) full logs (?:and|or) patches`),
    affirmativeSentence(String.raw`(?:(?:all|every) secrets? (?:are|is) redacted|secret-free)`),
    affirmativeSentence(String.raw`(?:universal|hard-coded) (?:maximum |candidate )?(?:cap (?:of )?)?100`),
    affirmativeSentence(String.raw`legacy runs? (?:are |is )?automatically (?:converted|reinterpreted) (?:as|into|under) (?:the )?(?:current )?Host-registration contract`),
    affirmativeSentence(String.raw`automatically chains? runs? indefinitely`),
  ]) expect(readme).not.toMatch(forbiddenPositiveClaim)

  expect(readme).not.toMatch(LITERAL_TRACKER_SCHEMA)
  expect(readme).not.toMatch(VERSIONED_TARBALL)
  expect(readme).toContain(`fails closed with \`${LEGACY_NONTERMINAL_RESUME_BLOCKER}\``)
  expect(readme).not.toContain('never auto-migrated')
}

describe('release and consumer contract', () => {
  it('publishes explicit ESM exports, peers, and files without local runtime paths', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(manifest).toMatchObject({
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/index.d.ts',
      engines: { node: '^22.19.0 || >=24.0.0' },
      exports: {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
        './invariant': { types: './lib/invariant.d.ts', default: './lib/invariant.js' },
      },
      files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
      dependencies: { '@deepseek-ai/schemastery': '^3.18.1' },
    })
    expect(Object.keys(manifest.peerDependencies)).toEqual(expect.arrayContaining([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tools',
    ]))
    const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.every(([, version]) => version === '^0.1.1-rc.2')).toBe(true)
    const dshDevDependencies = Object.entries(manifest.devDependencies).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(dshDevDependencies.every(([, version]) => version === '0.1.1-rc.2')).toBe(true)
    expect(manifest.devDependencies['@deepseek-ai/dsh-agent-presets']).toBe('0.1.1-rc.2')
    expect(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, exports: manifest.exports })).not.toMatch(/\b(?:file|link|workspace):|\/src\//u)
  })

  it('cleans generated output before every pack', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(manifest.scripts.prepack).toBe('node scripts/clean-lib.mjs && pnpm run build')
  })

  it('enforces the deterministic packed-file allowlist', () => {
    expect(() => assertExactTarballEntries(EXPECTED_TARBALL_ENTRIES)).not.toThrow()
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
        accepted: { ok: true, strictDecision: 'accept', terminalBeforeLockRelease: true, agentDisposed: true, tsv: { equalBytes: true, firstSha256: expect.stringMatching(/^[0-9a-f]{64}$/), secondSha256: expect.stringMatching(/^[0-9a-f]{64}$/), temporaryFiles: [], lowerLayerAtomicFaultTest: expect.stringContaining('publishes deterministic run-scoped TSV atomically') } },
        tie: { ok: true, strictDecision: 'reject', terminalBeforeLockRelease: true, agentDisposed: true },
        rejected: { ok: true, strictDecision: 'reject', terminalBeforeLockRelease: true, agentDisposed: true },
        background: { ok: true, listed: true, kill: true, noLiveJobs: true, resumedStatus: 'budget-limited', resumeResultMatches: true, headAdvanced: true, resumeCwdChanged: true },
        interruptionResume: { ok: true, processTreeQuiescent: true, resumedStatus: 'cancelled', attempts: 1, duplicateCandidate: false },
        uncertainRestart: { ok: true, status: 'blocked', pidSignalled: false, duplicateEvaluation: false, lockRetained: true },
        items: Object.fromEntries(['840','845','846','847','848','849','850','851','852','853','854','855','856','857'].map(item => [item, { ok: true }])),
      })
      expect(evidence.accepted.tsv.firstSha256).toBe(evidence.accepted.tsv.secondSha256)
      expect(evidence.items['847'].observations).toEqual(evidence.prepareBarrier)
      expect(evidence.items['852'].tsv).toEqual(evidence.accepted.tsv)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 20_000)

  it('has generated declarations and source maps for both public entry points', async () => {
    const files = await readdir(join(root, 'lib'))
    expect(files).toEqual(expect.arrayContaining([
      'index.js', 'index.js.map', 'index.d.ts', 'index.d.ts.map',
      'invariant.js', 'invariant.js.map', 'invariant.d.ts', 'invariant.d.ts.map',
    ]))
  })

  it('ships truthful bounded-controller documentation from source authorities', async () => {
    const [readme, patch, license] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'cordis.patch.yml'), 'utf8'),
      readFile(join(root, 'LICENSE'), 'utf8'),
    ])

    expect(readme).toContain('AutoresearchRunController')
    expect(readme).toContain('dsh plugin --profile <name> add dsh-autoresearch')
    expect(readme).toContain('dsh --profile <name> --dump-config')
    expect(readme).toContain('DeepSeek Harness `0.1.1-rc.2`')
    expect(readme).toContain('Web `standard` Agent preset')
    assertBoundedControllerReadme(readme)
    expect(TRACKER_SCHEMA_VERSION).toBeGreaterThan(0)
    for (const parameter of Object.keys(ACTIVATION_AUTORESEARCH_TOOL_SCHEMA)) expect(readme).toContain(`\`${parameter}\``)
    for (const removedAuthority of ['evaluation', 'metric_name', 'metric_direction', 'provenance', 'environment', 'exceptional_allowlists']) expect(ACTIVATION_AUTORESEARCH_TOOL_SCHEMA).not.toHaveProperty(removedAuthority)
    expect(readme).not.toContain('ctx.workflowEngine')
    expect(readme).not.toContain('ctx.subagents')
    expect(patch).toContain('id: autoresearch')
    expect(patch).toContain('name: dsh-autoresearch')
    expect(patch).toContain('defaultMaxExperiments: 20')
    expect(patch).toContain('maxExperiments: 100')
    expect(license).toContain('MIT License')
  })

  it('packs the same version-neutral README contract', async () => {
    const work = await mkdtemp(join(tmpdir(), 'autoresearch-packed-readme-'))
    try {
      const { stdout } = await run('pnpm', ['pack', '--silent', '--pack-destination', work], { cwd: root })
      const packed = stdout.trim().split(/\r?\n/u).at(-1)
      expect(packed).toBeTruthy()
      const tarball = packed!.startsWith('/') ? packed! : join(work, packed!)
      const { stdout: packedReadme } = await run('tar', ['-xOf', tarball, 'package/README.md'])
      const checkoutReadme = await readFile(join(root, 'README.md'), 'utf8')
      expect(packedReadme).toBe(checkoutReadme)
      assertBoundedControllerReadme(packedReadme)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 20_000)

  it('derives the canonical release tarball while preserving explicit overrides', () => {
    const manifest = { name: '@deepseek-ai/dsh-autoresearch', version: '1.2.3' }

    expect(resolveReleaseSmokeOptions([], manifest, '/ignored-cwd')).toEqual({
      tarball: join(root, 'deepseek-ai-dsh-autoresearch-1.2.3.tgz'),
      profile: 'autoresearch-release-smoke',
      pack: true,
    })
    expect(resolveReleaseSmokeOptions(['./custom.tgz', 'custom-profile'], manifest, '/tmp/consumer')).toEqual({
      tarball: '/tmp/consumer/custom.tgz',
      profile: 'custom-profile',
      pack: false,
    })
    expect(resolveReleaseSmokeOptions(['--profile', 'flag-profile'], manifest, '/ignored-cwd')).toEqual({
      tarball: join(root, 'deepseek-ai-dsh-autoresearch-1.2.3.tgz'),
      profile: 'flag-profile',
      pack: true,
    })
    expect(resolveReleaseSmokeOptions(['--', './custom.tgz', 'dash-profile'], manifest, '/tmp/consumer')).toEqual({
      tarball: '/tmp/consumer/custom.tgz',
      profile: 'dash-profile',
      pack: false,
    })
  })
})
