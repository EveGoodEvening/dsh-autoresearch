import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, composeEntries, initProfile, loadProfile, writeProfileManifest, type Profile } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
const baseEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base'))
const basePackage = join(baseEntry, '..', '..')
const modelPlugin = fileURLToPath(new URL('./loader/model-provider.ts', import.meta.url))

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

export async function composeHarness(options: { autoresearch?: boolean; omitEntry?: string; reverseEntries?: boolean } = {}): Promise<RealHarness> {
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
  const modulesDir = join(profileDir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  await symlink(packageRoot, join(modulesDir, 'dsh-autoresearch'), 'dir')
  const baseModules = join(basePackage, 'node_modules')
  await mkdir(baseModules, { recursive: true })
  await symlink(packageRoot, join(baseModules, 'dsh-autoresearch'), 'dir').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const profile = loadProfile('dsh-autoresearch-test', 'integration', installAnchor, home, { userLayer: false })
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, providerOverlay()])
  const selected = (options.omitEntry ? entries.filter(entry => entry.id !== options.omitEntry) : entries).toSorted((left, right) => options.reverseEntries ? right.id.localeCompare(left.id) : 0)
  const bootEntries = selected.map(entry => entry.id === 'hmr'
    ? { ...entry, config: { root: [], ignored: [], debounce: 10 } }
    : entry)
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
