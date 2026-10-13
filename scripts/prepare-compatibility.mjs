#!/usr/bin/env node
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const [destination, ...extra] = process.argv.slice(2)
if (!destination || extra.length) throw new Error('usage: node scripts/prepare-compatibility.mjs <new-workspace-outside-checkout>')
const workspace = resolve(destination)
if (workspace === repoRoot || workspace.startsWith(`${repoRoot}${sep}`)) {
  throw new Error('compatibility workspace must be outside the source checkout')
}

// A new directory prevents a local reproduction from overwriting an existing checkout.
await mkdir(workspace)
await cp(repoRoot, workspace, {
  recursive: true,
  filter: source => !['.git', 'node_modules', 'lib'].includes(relative(repoRoot, source).split(sep)[0]),
})

const manifestPath = resolve(workspace, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const isDsh = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const isCordis = name => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-')
const names = [...new Set(sections.flatMap(section => Object.keys(manifest[section] ?? {})))].sort()
const declaredPeerDependencies = { ...manifest.peerDependencies }
const dshVersion = await latestVersion('@deepseek-ai/dsh')
const versions = Object.fromEntries(await Promise.all(names.filter(name => isDsh(name) || isCordis(name)).map(async name => [
  name,
  // Service dist-tags can lag the CLI. DSH publishes one synchronized family.
  isDsh(name) ? dshVersion : await latestVersion(name),
])))

for (const section of sections) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (versions[name]) manifest[section][name] = versions[name]
  }
}

// Repin peers only in the disposable candidate, so packed consumers use the same
// upstream versions as source tests rather than silently installing the old peers.
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(resolve(workspace, 'upstream-versions.json'), `${JSON.stringify({
  checkedAt: new Date().toISOString(),
  channel: 'latest',
  package: `${manifest.name}@${manifest.version}`,
  declaredPeerDependencies,
  versions,
}, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `dsh=${dshVersion}\ncordis=${versions['@deepseek-ai/cordis']}\n`)
}
console.log(JSON.stringify({ workspace, versions }, null, 2))

async function latestVersion(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`npm latest resolution failed for ${name}: HTTP ${response.status}`)
  const manifest = await response.json()
  if (manifest.name !== name || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error(`npm returned an invalid package version for ${name}`)
  }
  return manifest.version
}
