#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const dshExecutable = process.env.DSH_BIN || join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const MODULES = ['agent', 'config', 'controller', 'evaluator-artifacts', 'evaluator', 'git', 'index', 'invariant', 'recovery', 'render', 'state-layout', 'tracker', 'types']
export const EXPECTED_TARBALL_ENTRIES = Object.freeze([
  'package/LICENSE', 'package/README.md', 'package/cordis.patch.yml', 'package/package.json',
  ...MODULES.flatMap(name => [`package/lib/${name}.d.ts`, `package/lib/${name}.d.ts.map`, `package/lib/${name}.js`, `package/lib/${name}.js.map`]),
].sort())

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))

async function main(args) {
  const packageManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const { tarball, profile } = resolveReleaseSmokeOptions(args, packageManifest)
  const root = await mkdtemp(join(tmpdir(), 'dsh-autoresearch-release-'))
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const consumer = join(root, 'consumer')
  const externalDshHome = process.env.DSH_HOME
  const evidence = { ok: false, tarball: basename(tarball), profile, package: {}, profileBoot: {}, scenarios: {} }

  try {
    const entries = (await run('tar', ['-tzf', tarball])).stdout.trim().split('\n').filter(Boolean).sort()
    assertExactTarballEntries(entries)
    const manifest = JSON.parse((await run('tar', ['-xOzf', tarball, 'package/package.json'])).stdout)
    assertManifest(manifest)
    const externalDshHomeBefore = externalDshHome ? await stat(externalDshHome).catch(() => undefined) : undefined
    evidence.package = { files: entries, manifest: { name: manifest.name, version: manifest.version, exports: manifest.exports } }

    const isolatedEnv = isolatedDshEnvironment(process.env, home, dshHome)
    await run(dshExecutable, ['plugin', '--profile', profile, 'add', tarball], { env: isolatedEnv, replaceEnv: true })
    const dump = await run(dshExecutable, ['--profile', profile, '--dump-config'], { env: isolatedEnv, replaceEnv: true })
    if (!dump.stdout.includes('id: autoresearch') || !dump.stdout.includes('name: dsh-autoresearch')) throw new Error('dumped profile does not contain the autoresearch row')
    for (const expected of ['defaultMaxExperiments: 20', 'maxExperiments: 100', 'stateRoot: dsh-autoresearch']) if (!dump.stdout.includes(expected)) throw new Error(`dumped profile is missing ${expected}`)

    if (externalDshHomeBefore && externalDshHome) {
      const after = await stat(externalDshHome)
      const changed = after.mtimeMs !== externalDshHomeBefore.mtimeMs
        || after.ctimeMs !== externalDshHomeBefore.ctimeMs
      if (changed) throw new Error('external DSH_HOME changed during isolated smoke')
    }
    const installedRoot = await findInstalledPackage(dshHome, manifest.name)
    const installed = await import(pathToFileURL(join(installedRoot, 'lib', 'index.js')).href)
    const registrations = { tools: [], prompts: [] }
    const ctx = activationContext(registrations)
    installed.apply(ctx, {})
    if (!registrations.tools.includes('autoresearch')) throw new Error('installed profile package did not register the autoresearch tool')
    if (!registrations.prompts.includes('tool:autoresearch')) throw new Error('installed profile package did not register prompt guidance')
    evidence.profileBoot = { installedRoot, sourceTreeResolved: installedRoot.startsWith(repoRoot), tools: registrations.tools, prompts: registrations.prompts }
    if (evidence.profileBoot.sourceTreeResolved) throw new Error('installed profile resolved the source tree instead of its installed tarball')

    await mkdir(consumer, { recursive: true })
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'dsh-autoresearch-consumer-smoke', private: true, type: 'module', scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' } }, null, 2))
    await run('npm', ['install', '--ignore-scripts', '--no-package-lock', tarball, `typescript@${packageManifest.devDependencies.typescript}`], { cwd: consumer })
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false }, include: ['smoke.ts'] }, null, 2))
    await writeFile(join(consumer, 'smoke.ts'), "import * as rootModule from 'dsh-autoresearch'\nimport * as invariantModule from 'dsh-autoresearch/invariant'\nif (rootModule.name !== 'autoresearch' || invariantModule.name !== 'autoresearch-invariant') throw new Error('installed exports failed')\n")
    await run(join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd: consumer })
    await assertDeclarationGraph(join(consumer, 'node_modules', manifest.name, 'lib'))
    await run(process.execPath, ['--input-type=module', '--eval', "const root=await import('dsh-autoresearch');const invariant=await import('dsh-autoresearch/invariant');if(root.name!=='autoresearch'||invariant.name!=='autoresearch-invariant')throw new Error('imports failed')"], { cwd: consumer })

    evidence.scenarios = await runInstalledScenarios(installedRoot, root)
    evidence.ok = true
    console.log(JSON.stringify(evidence))
  } finally { await rm(root, { recursive: true, force: true }) }
}

export function resolveReleaseSmokeOptions(args, packageManifest, cwd = process.cwd()) {
  const positional = []
  let tarballOverride
  let profileOverride
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (parseOptions && argument === '--') {
      parseOptions = false
      continue
    }
    if (parseOptions && (argument === '--tarball' || argument === '--profile')) {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      index += 1
      if (argument === '--tarball') tarballOverride = value
      else profileOverride = value
    } else if (parseOptions && argument.startsWith('--tarball=')) {
      tarballOverride = argument.slice(10)
    } else if (parseOptions && argument.startsWith('--profile=')) {
      profileOverride = argument.slice(10)
    } else if (parseOptions && argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length > 2 || (tarballOverride && positional[0]) || (profileOverride && positional[1])) {
    throw new Error('usage: node scripts/release-smoke.mjs [--] [packed-tarball] [profile-name] [--tarball <path>] [--profile <name>]')
  }

  const { name, version } = packageManifest ?? {}
  if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) {
    throw new Error('package.json must contain a package name and version')
  }
  const expectedFilename = `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`
  return {
    tarball: resolve(cwd, tarballOverride ?? positional[0] ?? join(repoRoot, expectedFilename)),
    profile: profileOverride ?? positional[1] ?? 'autoresearch-release-smoke',
  }
}

export function isolatedDshEnvironment(source, home, dshHome) {
  const isolated = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('DSH_')))
  return { ...isolated, HOME: home, DSH_HOME: dshHome }
}

export function assertExactTarballEntries(entries) {
  const actual = [...entries].sort()
  if (JSON.stringify(actual) === JSON.stringify(EXPECTED_TARBALL_ENTRIES)) return

  const expected = new Set(EXPECTED_TARBALL_ENTRIES)
  const received = new Set(actual)
  const missing = EXPECTED_TARBALL_ENTRIES.filter(path => !received.has(path))
  const unexpected = actual.filter(path => !expected.has(path))
  throw new Error(`packed artifact entries differ from the release allowlist; missing=${missing.join(',')}; unexpected=${unexpected.join(',')}`)
}
function assertManifest(manifest) {
  const rootEntryIsValid = manifest.type === 'module'
    && manifest.main === 'lib/index.js'
    && manifest.types === 'lib/index.d.ts'
  if (!rootEntryIsValid) throw new Error('packed manifest root ESM entry is invalid')

  const exportsAreValid = manifest.exports?.['.']?.default === './lib/index.js'
    && manifest.exports?.['./invariant']?.default === './lib/invariant.js'
  if (!exportsAreValid) throw new Error('packed manifest exports are invalid')

  const serialized = JSON.stringify({
    dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies,
    exports: manifest.exports,
    files: manifest.files,
  })
  if (/\b(?:link|file|workspace):/u.test(serialized) || serialized.includes('/src/')) {
    throw new Error('packed runtime manifest contains a local link or source-tree path')
  }
}

async function assertDeclarationGraph(lib) {
  const declarations = (await readdir(lib)).filter(name => name.endsWith('.d.ts'))
  for (const file of declarations) {
    const text = await readFile(join(lib, file), 'utf8')
    for (const match of text.matchAll(/from ['"](\.\/[^'"]+)['"]/gu)) {
      const specifier = match[1]
      if (specifier.endsWith('.ts')) throw new Error(`${file} contains a source-only declaration specifier ${specifier}`)
      const target = resolve(lib, specifier)
      if (!await exists(target) && !await exists(target.replace(/\.js$/u, '.d.ts'))) {
        throw new Error(`${file} declaration import does not resolve: ${specifier}`)
      }
    }
  }
}

async function findInstalledPackage(root, name) {
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      const matchesName = entry.name === name || (name.startsWith('@') && path.endsWith(name))
      if (matchesName && await exists(join(path, 'package.json'))) return path
      queue.push(path)
    }
  }
  throw new Error(`installed profile package ${name} not found below ${root}`)
}

function activationContext(registrations) {
  return {
    agents: { create() {} },
    jobs: { start() {} },
    subprocess: {},
    tools: {
      get: () => ({}),
      register(tool) {
        registrations.tools.push(tool.name)
        return () => {}
      },
    },
    systemPrompt: {
      section(spec) {
        registrations.prompts.push(spec.name)
        return () => {}
      },
    },
    effect(runEffect) { return runEffect() },
    on() { return () => {} },
  }
}

async function runInstalledScenarios(installedRoot, root) {
  const runner = join(import.meta.dirname, 'release-scenarios.mjs')
  const result = await run(process.execPath, [runner, installedRoot, join(root, 'scenario-work')])
  return JSON.parse(result.stdout.trim())
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  const { promise, resolve: resolveRun, reject } = Promise.withResolvers()
  const env = options.replaceEnv ? options.env : { ...process.env, ...options.env }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', code => {
    if (code === 0) resolveRun({ stdout, stderr })
    else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}`))
  })
  return promise
}
