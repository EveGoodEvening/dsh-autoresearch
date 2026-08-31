import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, composeEntries, healProfilesModuleFallback, initProfile, loadProfile, writeProfileManifest, type Profile } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

export const packageRoot = process.env.DSH_AUTORESEARCH_INSTALLED_ROOT
  ? fileURLToPath(pathToFileURL(process.env.DSH_AUTORESEARCH_INSTALLED_ROOT))
  : fileURLToPath(new URL('../..', import.meta.url))
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
const baseEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base'))
const basePackage = join(baseEntry, '..', '..')
const modelPlugin = fileURLToPath(new URL('./loader/model-provider.ts', import.meta.url))
const shippedPresetManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/config/agent-presets/standard/preset.yml'))
const shippedPresetRoot = dirname(dirname(shippedPresetManifest))
const dshInstallAnchor = join(dirname(dirname(shippedPresetRoot)), 'package.json')

export const COMPOSITION_TERMINATION_GRACE_MS = 5_000

export interface RealHarness {
  readonly ctx: Context
  readonly root: string
  readonly home: string
  readonly profile: Profile
  readonly entries: readonly EntryOptions[]
  dispose(): Promise<void>
  reloadAutoresearch(): Promise<void>
  setAutoresearchEnabled(enabled: boolean): Promise<void>
}

function providerOverlay(): PatchOptions[] {
  return [{ insert: [{ id: 'autoresearch-test-model', name: modelPlugin }] }]
}
function standardAgentPlaneOverlay(): PatchOptions[] {
  return [
    { id: 'tool-jobs', disabled: true },
    {
      insert: [{
        id: 'agent-presets',
        name: '@deepseek-ai/dsh-agent-presets',
        config: {
          default: 'standard',
          roots: [{ path: shippedPresetRoot, trust: 'system' }],
          includeUserRoot: false,
        },
      }],
    },
  ]
}
function configureBootEntry(entry: EntryOptions, autoresearchConfig?: Readonly<Record<string, unknown>>): EntryOptions {
  if (entry.id === 'hmr') {
    return { ...entry, config: { root: [], ignored: [], debounce: 10 } }
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
    dependencies: { 'dsh-autoresearch': `link:${relative(profileDir, packageRoot)}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(options.autoresearch === false ? [] : ['dsh-autoresearch'])] } },
  })
  if (options.standardPreset) healProfilesModuleFallback(dshInstallAnchor, home)
  const modulesDir = join(profileDir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  await symlink(packageRoot, join(modulesDir, 'dsh-autoresearch'), 'dir')
  const baseModules = join(basePackage, 'node_modules')
  await mkdir(baseModules, { recursive: true })
  await symlink(packageRoot, join(baseModules, 'dsh-autoresearch'), 'dir').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const profile = loadProfile('dsh-autoresearch-test', 'integration', installAnchor, home, { userLayer: false })
  const entries = composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    ...(options.standardPreset ? [standardAgentPlaneOverlay()] : []),
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
  const ctx = await boot('dsh-autoresearch-test', configPath, patches, bootCtx => {
    bootCtx.dshHomePath = (...segments: string[]) => join(home, ...segments)
  }, pathToFileURL(join(basePackage, 'package.json')).href)
  let disposed = false
  return {
    ctx,
    root,
    home,
    profile,
    entries: selected,
    async reloadAutoresearch() {
      const trigger = join(root, `autoresearch-hmr-${crypto.randomUUID()}.trigger`)
      const { promise: reloaded, resolve, reject } = Promise.withResolvers<void>()
      let refreshing = false
      const releaseConfig = await ctx.hmr.registerConfig(trigger, async () => {
        if (refreshing) return
        refreshing = true
        try {
          const include = ctx.loader.resolve('include').subtree
          if (!include) throw new Error('root include subtree not found')
          const entry = include.resolve('autoresearch')
          await entry.update({ disabled: true }, false, true)
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
      await include.resolve('autoresearch').update({ disabled: !enabled }, false, true)
      await ctx.loader.await()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try { await ctx.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

export async function assembledPrompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

export async function shippedPatchText(): Promise<string> {
  return readFile(fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)), 'utf8')
}
