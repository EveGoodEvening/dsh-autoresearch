import { readFileSync, watch } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { vi } from 'vitest'

export const exitedParentEvaluator = new URL('./loader/evaluator-exited-parent.mjs', import.meta.url).pathname
export interface ExitedParentMarker { parent: number; child: number; score: number }

export async function exitingParentMarker() {
  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-exited-parent-'))
  const path = join(directory, 'ready.json')
  const ready = Promise.withResolvers<ExitedParentMarker>()
  const watcher = watch(directory, (_event, filename) => {
    if (filename !== 'ready.json') return
    void readFile(path, 'utf8').then(text => {
      const value = JSON.parse(text) as ExitedParentMarker
      if (![value.parent, value.child].every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('invalid exited-parent PID marker')
      ready.resolve(value)
    }).catch(ready.reject)
  })
  watcher.once('error', ready.reject)
  void ready.promise.catch(() => {})
  return { path, ready: ready.promise, async dispose() { watcher.close(); await rm(directory, { recursive: true, force: true }) } }
}

export function processIsRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0] !== 'Z'
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

export function observeExitingEvaluators(ctx: Context, marker: string, forceFallback = false) {
  const runtime = ctx.subprocess
  // Disclosed test-only selector seam. The normal Host rows forward selection unchanged.
  const selectorHost = runtime as unknown as { selectContainmentMode(kind: string): string }
  const select = selectorHost.selectContainmentMode
  const spawn = runtime.spawn
  let observing = false
  let selected = ''
  const selection = vi.spyOn(selectorHost, 'selectContainmentMode').mockImplementation(function (kind) {
    const mode = forceFallback && observing ? 'fallback' : select.call(this, kind)
    if (observing) selected = mode
    return mode
  })
  const captures: Array<{ handle: SubprocessHandle; spec: SubprocessSpawnSpec; mode: string; waiting: Promise<void> }> = []
  const spawning = vi.spyOn(runtime, 'spawn').mockImplementation(function (spec) {
    if (spec.argv[1] !== exitedParentEvaluator || spec.argv[2] !== marker) return spawn.call(this, spec)
    let handle: SubprocessHandle
    observing = true
    try { handle = spawn.call(this, spec) } finally { observing = false }
    const waiting = Promise.withResolvers<void>()
    captures.push({ handle, spec, mode: selected, waiting: waiting.promise })
    // Never spy on handle.waitForExit: the provider has its own internal release wait.
    return {
      stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control,
      done: handle.done, collected: handle.collected,
      terminate: () => handle.terminate(),
      waitForExit: signal => { waiting.resolve(); return handle.waitForExit(signal) },
    }
  })
  return {
    captures,
    async drain() {
      // Do this before owner disposal, even on assertion failure: caller abort alone
      // cannot clean up the pre-fix direct-exit/held-descendant hang.
      for (const { handle } of captures) handle.terminate()
      await Promise.all(captures.map(async ({ handle }) => {
        await handle.done.catch(() => {})
        if (!await handle.waitForExit()) throw new Error('owned evaluator tree did not drain')
      }))
    },
    restore() { spawning.mockRestore(); selection.mockRestore() },
  }
}

export function operationDeadline(ms: number) {
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error(`exited-parent scenario exceeded ${ms}ms`)), ms)
  void deadline.promise.catch(() => {})
  return { wait: <T>(pending: Promise<T>) => Promise.race([pending, deadline.promise]), dispose: () => clearTimeout(timer) }
}

export function controlWatchdog(timeoutMs: number) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let watchdog: NodeJS.Timeout | undefined
  let cleared = false
  // Observe only this handle; provider, I/O, and termination-grace clocks stay real.
  const clearing = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
    if (watchdog !== undefined && handle === watchdog) cleared = true
    realClearTimeout(handle)
  })
  let fire: (() => void) | undefined
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(callback, ms, ...args)
    if (ms === timeoutMs) {
      if (fire) throw new Error('evaluator watchdog was restarted')
      watchdog = handle
      fire = () => {
        if (cleared) throw new Error('evaluator watchdog was cleared before tree quiescence')
        clearTimeout(handle)
        callback(...args)
      }
    }
    return handle
  }) as typeof setTimeout)
  return { fire() { if (!fire) throw new Error('evaluator watchdog was not armed'); fire() }, restore() { timer.mockRestore(); clearing.mockRestore() } }
}
