#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const dshExecutable = process.env.DSH_BIN || join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}

async function main(args) {
  const packageManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const { tarball, profile } = resolveReleaseSmokeOptions(args, packageManifest)
  const root = await mkdtemp(join(tmpdir(), 'dsh-autoresearch-release-'))
  const home = join(root, 'home')
  const consumer = join(root, 'consumer')

  try {
    const entries = (await run('tar', ['-tzf', tarball])).stdout.trim().split('\n').sort()
    const required = ['package/LICENSE', 'package/README.md', 'package/cordis.patch.yml', 'package/package.json']
    for (const entry of required) if (!entries.includes(entry)) throw new Error(`packed artifact is missing ${entry}`)
    if (!entries.includes('package/lib/index.js') || !entries.includes('package/lib/index.d.ts')) throw new Error('packed artifact is missing generated root JavaScript or declarations')
    if (!entries.some(entry => entry.endsWith('.js.map')) || !entries.some(entry => entry.endsWith('.d.ts.map'))) throw new Error('packed artifact is missing generated source maps')
    if (entries.some(entry => entry.startsWith('package/src/') || entry.includes('/node_modules/'))) throw new Error('packed artifact contains source or node_modules')

    const manifestText = (await run('tar', ['-xOzf', tarball, 'package/package.json'])).stdout
    const manifest = JSON.parse(manifestText)
    assertManifest(manifest)

    await run(dshExecutable, ['plugin', '--profile', profile, 'add', tarball], { env: { HOME: home } })
    const dump = await run(dshExecutable, ['--profile', profile, '--dump-config'], { env: { HOME: home } })
    if (!dump.stdout.includes('id: autoresearch') || !dump.stdout.includes('name: dsh-autoresearch')) throw new Error('dumped profile does not contain the autoresearch row')
    for (const expected of ['defaultMaxExperiments: 20', 'maxExperiments: 100', 'stateRoot: dsh-autoresearch']) {
      if (!dump.stdout.includes(expected)) throw new Error(`dumped profile is missing ${expected}`)
    }

    await mkdir(consumer, { recursive: true })
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'dsh-autoresearch-consumer-smoke', private: true, type: 'module' }, null, 2))
    await run('npm', ['install', '--ignore-scripts', '--no-package-lock', tarball], { cwd: consumer })
    const installedManifestPath = join(consumer, 'node_modules', 'dsh-autoresearch', 'package.json')
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'))
    assertManifest(installedManifest)
    const smokePath = join(consumer, 'smoke.mjs')
    await writeFile(smokePath, `
import * as rootModule from 'dsh-autoresearch'
import * as invariantModule from 'dsh-autoresearch/invariant'

if (rootModule.name !== 'autoresearch' || typeof rootModule.apply !== 'function') {
  throw new Error('installed root export did not load')
}
if (invariantModule.name !== 'autoresearch-invariant' || typeof invariantModule.apply !== 'function') {
  throw new Error('installed invariant export did not load')
}
`)
    await run(process.execPath, [smokePath], { cwd: consumer })

    console.log(JSON.stringify({ ok: true, tarball: basename(tarball), profile, files: entries.length }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function resolveReleaseSmokeOptions(args, packageManifest, cwd = process.cwd()) {
  const positional = []
  let tarballOverride
  let profileOverride

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--tarball' || argument === '--profile') {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === '--tarball') tarballOverride = value
      else profileOverride = value
      index += 1
    } else if (argument.startsWith('--tarball=')) {
      tarballOverride = argument.slice('--tarball='.length)
    } else if (argument.startsWith('--profile=')) {
      profileOverride = argument.slice('--profile='.length)
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length > 2 || (tarballOverride && positional[0]) || (profileOverride && positional[1])) {
    throw new Error('usage: node scripts/release-smoke.mjs [packed-tarball] [profile-name] [--tarball <path>] [--profile <name>]')
  }

  const name = packageManifest?.name
  const version = packageManifest?.version
  if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) throw new Error('package.json must contain a package name and version')
  const expectedFilename = `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`

  return {
    tarball: resolve(cwd, tarballOverride ?? positional[0] ?? join(repoRoot, expectedFilename)),
    profile: profileOverride ?? positional[1] ?? 'autoresearch-release-smoke',
  }
}

function assertManifest(manifest) {
  if (manifest.type !== 'module' || manifest.main !== 'lib/index.js' || manifest.types !== 'lib/index.d.ts') throw new Error('packed manifest root ESM entry is invalid')
  if (manifest.exports?.['.']?.default !== './lib/index.js' || manifest.exports?.['./invariant']?.default !== './lib/invariant.js') throw new Error('packed manifest exports are invalid')
  if (!Array.isArray(manifest.files) || !['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'].every(item => manifest.files.includes(item))) throw new Error('packed manifest files allowlist is incomplete')
  const serialized = JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, exports: manifest.exports, files: manifest.files })
  if (/\b(?:link|file|workspace):/u.test(serialized) || serialized.includes('/src/')) throw new Error('packed runtime manifest contains a local link or source-tree path')
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}`)))
  })
}
