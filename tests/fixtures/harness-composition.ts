import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, composeEntries, initProfile, loadOverlayPatches, loadProfile, writeProfileManifest, type Profile } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const packageAnchor = fileURLToPath(new URL('../../package.json', import.meta.url))
const modelPlugin = fileURLToPath(new URL('./loader/model-provider.ts', import.meta.url))
const autoresearchPlugin = fileURLToPath(new URL('../../lib/index.js', import.meta.url))

export interface RealHarness {
  readonly ctx: Context
  readonly root: string
  readonly home: string
  readonly profile: Profile
  readonly entries: readonly EntryOptions[]
  dispose(): Promise<void>
  setAutoresearchEnabled(enabled: boolean): Promise<void>
}

function providerOverlay(): PatchOptions[] {
  return [{ insert: [{ id: 'autoresearch-test-model', name: modelPlugin }] }]
}

export async function composeHarness(options: { autoresearch?: boolean; omitEntry?: string } = {}): Promise<RealHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autoresearch-loader-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'integration')
  initProfile(profileDir, ['@deepseek-ai/dsh-base'])
  writeProfileManifest(profileDir, {
    name: 'dsh-autoresearch-loader-profile',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const baseProfile = loadProfile('dsh-autoresearch-test', 'integration', packageAnchor, home, { userLayer: false })
  writeProfileManifest(profileDir, {
    name: 'dsh-autoresearch-loader-profile',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(options.autoresearch === false ? [] : ['dsh-autoresearch'])] } },
  })
  const profile: Profile = options.autoresearch === false ? baseProfile : {
    ...baseProfile,
    layers: [...baseProfile.layers, { packageName: 'dsh-autoresearch', packageDir: dirname(packageAnchor), patchPath: join(dirname(packageAnchor), 'cordis.patch.yml'), patches: loadOverlayPatches('dsh-autoresearch-test', join(dirname(packageAnchor), 'cordis.patch.yml')) }],
  }
  const layers = profile.layers.map(layer => layer.patches)
  const entries = composeEntries([...layers, profile.patches, providerOverlay()])
  const selected = options.omitEntry ? entries.filter(entry => entry.id !== options.omitEntry) : entries
  const bootEntries = selected.map(entry => entry.id === 'hmr'
    ? { ...entry, disabled: true }
    : entry.id === 'autoresearch' ? { ...entry, name: autoresearchPlugin } : entry)
  const configPath = join(profileDir, 'cordis.yml')
  await writeFile(configPath, '[]\n')
  const patches: PatchOptions[] = [{ insert: bootEntries }]
  const ctx = await boot('dsh-autoresearch-test', configPath, patches, bootCtx => {
    bootCtx.dshHomePath = (...segments: string[]) => join(home, ...segments)
  }, pathToFileURL(packageAnchor).href)
  let disposed = false
  return {
    ctx,
    root,
    home,
    profile,
    entries: selected,
    async setAutoresearchEnabled(enabled: boolean) {
      const include = ctx.loader.resolve('include').subtree
      if (!include) throw new Error('root include subtree not found')
      await include.resolve('autoresearch').update({ disabled: !enabled }, false, true)
      await ctx.loader.await()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await ctx.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function assembledPrompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

export async function shippedPatchText(): Promise<string> {
  return readFile(fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)), 'utf8')
}
