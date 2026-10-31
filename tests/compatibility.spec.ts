import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
type Manifest = {
  name: string
  version: string
  engines: Record<string, string>
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest
// The disposable upstream probe repins engines/peers to exact latest and records
// the declared support contract; evaluate that contract instead of the probe pins.
const probePath = join(root, 'upstream-versions.json')
const probe = existsSync(probePath)
  ? JSON.parse(await readFile(probePath, 'utf8')) as { declaredEngines: Record<string, string>, declaredPeerDependencies: Record<string, string> }
  : undefined
const manifest: Manifest = probe
  ? { ...installed, engines: probe.declaredEngines, peerDependencies: probe.declaredPeerDependencies }
  : installed

const accepted = ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.1-rc.9', '0.2.1']
const rejected = ['0.2.2-alpha.2', '0.2.0-rc.2']
const isDsh = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

describe('DSH plugin compatibility gate', () => {
  it('declares one engines.dsh range shared by every DSH peer', () => {
    const range = manifest.engines.dsh
    expect(range).toBe('>=0.2.1-rc.2 <0.2.2-0')
    const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) => isDsh(name))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [, peerRange] of dshPeers) expect(peerRange).toBe(range)
  })

  it.each(accepted)('dsh-app-boot accepts DSH %s', runtimeVersion => {
    expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toBeUndefined()
  })

  it.each(rejected)('dsh-app-boot rejects DSH %s through engines.dsh', runtimeVersion => {
    expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toEqual({
      name: manifest.name,
      version: manifest.version,
      runtimeVersion,
      requirements: { 'engines.dsh': manifest.engines.dsh },
      exempted: false,
    })
  })

  it('peer ranges alone give the same verdicts when engines.dsh is absent', () => {
    const { engines: _engines, ...peersOnly } = manifest
    for (const runtimeVersion of accepted) expect(evaluatePluginCompatibility(peersOnly, {}, runtimeVersion)).toBeUndefined()
    for (const runtimeVersion of rejected) {
      expect(Object.keys(evaluatePluginCompatibility(peersOnly, {}, runtimeVersion)?.requirements ?? {}).sort())
        .toEqual(Object.keys(manifest.peerDependencies).filter(isDsh).sort())
    }
  })

  it('accepts the installed development DSH runtime', () => {
    expect(getDshRuntimeVersion()).toBe(installed.devDependencies['@deepseek-ai/dsh'])
    expect(evaluatePluginCompatibility(installed)).toBeUndefined()
  })
})
