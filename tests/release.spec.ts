import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveReleaseSmokeOptions } from '../scripts/release-smoke.mjs'

const root = join(import.meta.dirname, '..')

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
    expect(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, exports: manifest.exports })).not.toMatch(/\b(?:file|link|workspace):|\/src\//u)
  })

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
    expect(readme).toContain('dsh plugin --profile <name> add <tarball-or-package>')
    expect(readme).toContain('dsh --profile <name> --dump-config')
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
    })
    expect(resolveReleaseSmokeOptions(['./custom.tgz', 'custom-profile'], manifest, '/tmp/consumer')).toEqual({
      tarball: '/tmp/consumer/custom.tgz',
      profile: 'custom-profile',
    })
    expect(resolveReleaseSmokeOptions(['--profile', 'flag-profile'], manifest, '/ignored-cwd')).toEqual({
      tarball: join(root, 'deepseek-ai-dsh-autoresearch-1.2.3.tgz'),
      profile: 'flag-profile',
    })
  })
})
