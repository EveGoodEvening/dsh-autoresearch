import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, composeEntries, createRuntimeResolution, initProfile, loadOverlayPatches, loadProfile, PluginPackages, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/dsh-hmr'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

export const packageRoot = process.env.DSH_AUTORESEARCH_INSTALLED_ROOT
  ? fileURLToPath(pathToFileURL(process.env.DSH_AUTORESEARCH_INSTALLED_ROOT))
  : fileURLToPath(new URL('../..', import.meta.url))
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
const baseEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base'))
const basePackage = join(baseEntry, '..', '..')
const modelPlugin = fileURLToPath(new URL('./loader/model-provider.ts', import.meta.url))
const shippedStandardPatch = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml'))
const webPackage = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))
const webRequire = createRequire(webPackage)

export const COMPOSITION_TERMINATION_GRACE_MS = 5_000

export interface RealHarness {
  readonly ctx: Context
  readonly root: string
  readonly home: string
  readonly entries: readonly EntryOptions[]
  dispose(): Promise<void>
  reloadAutoresearch(): Promise<void>
  setAutoresearchEnabled(enabled: boolean): Promise<void>
}

function providerOverlay(): PatchOptions[] {
  return [{ insert: [{ id: 'autoresearch-test-model', name: modelPlugin }] }]
}
function standardAgentPlaneOverlay(): PatchOptions[] {
  const hostIds = ['subagent-model-selection-settings', 'agent-preset-registry']
  const hostRows = loadOverlayPatches('dsh-autoresearch-test', fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => hostIds.includes(row.id))
  if (hostRows.length !== hostIds.length) throw new Error('shipped Web Host agent prerequisites are missing')
  return [
    { id: 'tool-jobs', disabled: true },
    { insert: hostRows },
    ...loadOverlayPatches('dsh-autoresearch-test', shippedStandardPatch),
  ]
}
async function linkStandardPresetModules(modulesDir: string, patches: readonly PatchOptions[]): Promise<void> {
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const preset = rows.find(row => row.id === 'preset-standard')
  if (!preset || !preset.config || typeof preset.config !== 'object' || !('plugins' in preset.config)) throw new Error('shipped standard preset has no plugin rows')
  const plugins = preset.config.plugins
  if (!Array.isArray(plugins)) throw new Error('shipped standard preset plugins must be rows')
  const visit = async (entries: unknown[]): Promise<void> => {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      if ('group' in entry && entry.group === true && 'config' in entry && Array.isArray(entry.config)) { await visit(entry.config); continue }
      if (!('name' in entry) || typeof entry.name !== 'string' || entry.name.startsWith('cordis:')) continue
      const name = entry.name.startsWith('@') ? entry.name.split('/').slice(0, 2).join('/') : entry.name.split('/')[0]!
      const manifest = webRequire.resolve(`${name}/package.json`)
      const destination = join(modulesDir, name)
      await mkdir(join(destination, '..'), { recursive: true })
      await symlink(join(manifest, '..'), destination, 'dir').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  }
  await visit(rows)
  await visit(plugins)
}
function configureBootEntry(entry: EntryOptions, autoresearchConfig?: Readonly<Record<string, unknown>>): EntryOptions {
  if (entry.id === 'hmr') {
    return { ...entry, disabled: false, config: { root: [], ignored: [], debounce: 10 } }
  }
  if (entry.id === 'autoresearch') {
    const evaluator = fileURLToPath(new URL('./loader/evaluator.mjs', import.meta.url))
    const evaluatorRegistrations = [{ id: 'judge', command: process.execPath, args: [evaluator], metricName: 'score', metricDirection: 'minimize', metricParserVersion: 'final-line-json-v1', evaluatorFiles: [] }]
    return { ...entry, config: { ...entry.config, terminationGraceMs: COMPOSITION_TERMINATION_GRACE_MS, evaluatorRegistrations, ...autoresearchConfig } }
  }
  return entry
}


export async function composeHarness(options: { autoresearch?: boolean; autoresearchConfig?: Readonly<Record<string, unknown>>; omitEntry?: string; reverseEntries?: boolean; standardPreset?: boolean } = {}): Promise<RealHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autoresearch-loader-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'integration')
  initProfile(profileDir, ['@deepseek-ai/dsh-base'])
  writeProfileManifest(profileDir, {
    name: 'dsh-autoresearch-loader-profile',
    private: true,
    dependencies: { 'dsh-autoresearch': `link:${relative(profileDir, packageRoot)}`, ...(options.standardPreset ? { '@deepseek-ai/dsh-web-app': `link:${relative(profileDir, dirname(webPackage))}` } : {}) },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(options.autoresearch === false ? [] : ['dsh-autoresearch'])] } },
  })
  const modulesDir = join(profileDir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  await symlink(packageRoot, join(modulesDir, 'dsh-autoresearch'), 'dir')
  if (options.standardPreset) {
    await mkdir(join(modulesDir, '@deepseek-ai'), { recursive: true })
    await symlink(dirname(webPackage), join(modulesDir, '@deepseek-ai', 'dsh-web-app'), 'dir')
  }
  const standardOverlay = options.standardPreset ? standardAgentPlaneOverlay() : []
  if (options.standardPreset) await linkStandardPresetModules(modulesDir, standardOverlay)
  const profile = loadProfile('dsh-autoresearch-test', 'integration', installAnchor, home, { userLayer: false })
  const entries = composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    standardOverlay,
    providerOverlay(),
  ])
  const selectedEntries = options.omitEntry
    ? entries.filter(entry => entry.id !== options.omitEntry)
    : entries
  const selected = selectedEntries.toSorted((left, right) => {
    if (!options.reverseEntries) return 0
    return right.id.localeCompare(left.id)
  })
  const bootEntries = selected.map(entry => configureBootEntry(entry, options.autoresearchConfig))
  const configPath = join(profileDir, 'cordis.yml')
  await writeFile(configPath, '[]\n')
  const patches: PatchOptions[] = [{ insert: bootEntries }]
  let ctx: Context
  try {
    const resolution = await createRuntimeResolution({ installAnchor: join(basePackage, 'package.json'), profile, home })
    ctx = await boot('dsh-autoresearch-test', configPath, patches, async bootCtx => {
      bootCtx.dshHomePath = (...segments: string[]) => join(home, ...segments)
      await bootCtx.plugin(PluginPackages, { resolution })
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  if (options.autoresearch !== false && !ctx.get('tools')?.schemas().some(tool => tool.name === 'autoresearch')) {
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'autoresearch')
    let reason = 'autoresearch did not activate'
    if (entry?.fiber) {
      try { await entry.fiber.await() } catch (error) { reason = error instanceof Error ? error.message : String(error) }
      const missing = Object.keys(entry.fiber.inject).filter(name => entry.fiber!.ctx.get(name) === undefined)
      if (missing.length) reason = `autoresearch waiting for services: ${missing.join(', ')}`
    }
    let cleanupError: unknown
    try { await ctx.fiber.dispose() } catch (error) { cleanupError = error }
    try { await rm(root, { recursive: true, force: true }) } catch (error) {
      cleanupError = cleanupError === undefined ? error : new AggregateError([cleanupError, error], 'failed to clean up inactive harness')
    }
    throw new Error(reason, cleanupError === undefined ? undefined : { cause: cleanupError })
  }
  let disposed = false
  return {
    ctx,
    root,
    home,
    entries: selected,
    async reloadAutoresearch() {
      const trigger = join(root, `autoresearch-hmr-${crypto.randomUUID()}.trigger`)
      const { promise: reloaded, resolve, reject } = Promise.withResolvers<void>()
      let refreshing = false
      const releaseConfig = await ctx.hmr.watchConfig(trigger, async () => {
        if (refreshing) return
        refreshing = true
        try {
          const include = ctx.loader.resolve('include').subtree
          if (!include) throw new Error('root include subtree not found')
          const entry = include.resolve('autoresearch')
          const previous = entry.fiber
          await entry.update({ disabled: true }, false, true)
          await previous?.await()
          await entry.update({ disabled: false }, false, true)
          await ctx.loader.await()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      await writeFile(trigger, 'reload\n')
      try { await reloaded } finally { await releaseConfig() }
    },
    async setAutoresearchEnabled(enabled: boolean) {
      const include = ctx.loader.resolve('include').subtree
      if (!include) throw new Error('root include subtree not found')
      const entry = include.resolve('autoresearch')
      const previous = entry.fiber
      await entry.update({ disabled: !enabled }, false, true)
      if (!enabled) await previous?.await()
      await ctx.loader.await()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try { await ctx.fiber.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

export async function assembledPrompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

