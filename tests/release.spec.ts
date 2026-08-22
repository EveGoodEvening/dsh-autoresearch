import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { assertExactTarballEntries, EXPECTED_TARBALL_ENTRIES, isolatedDshEnvironment, resolveReleaseSmokeOptions } from '../scripts/release-smoke.mjs'

const root = join(import.meta.dirname, '..')
const run = promisify(execFile)

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
        prepareBarrier: { ok: true, prepared: { trackerExists: true, runExists: true, runState: 'initializing', experiments: 0, localLocks: 0, sharedLocks: 0, worktreeExists: false, refs: [], evaluatorMarkerExists: false }, afterRun: { evaluatorMarkerExists: true } },
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

  it('ships current controller documentation and stable opt-in patch defaults', async () => {
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
    expect(readme).not.toContain('ctx.workflowEngine')
    expect(readme).not.toContain('ctx.subagents')
    expect(patch).toContain('id: autoresearch')
    expect(patch).toContain('name: dsh-autoresearch')
    expect(patch).toContain('defaultMaxExperiments: 20')
    expect(license).toContain('MIT License')
  })

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
