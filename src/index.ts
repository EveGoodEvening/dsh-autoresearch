import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from './config.js'
import type { Config as AutoresearchConfig } from './config.js'
import { AutoresearchRunController, preflightAutoresearchRepository, validateAutoresearchRequest } from './controller.js'
import { renderToolResult } from './render.js'
import {
  ACTIVATION_AUTORESEARCH_TOOL_SCHEMA,
  AUTORESEARCH_TOOL_OUTPUT_SCHEMA,
  decodeActivationToolInput,
  type ActivationAutoresearchToolInput,
  type AutoresearchRunResult,
  type AutoresearchToolResult,
  type BackgroundStartFailedToolResult,
} from './types.js'

export { Config }

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    autoresearch: 'autoresearch'
  }
}

export const name = 'autoresearch'
export const inject = ['agents', 'jobs', 'subprocess', 'systemPrompt', 'tools']

const DESCRIPTION = 'Run a bounded, baseline-first metric optimization loop in an isolated Git worktree. Trusted host code owns evaluation, metric decisions, persistence, cancellation, and recovery.'
const GUIDANCE = 'Use autoresearch only when the direct human explicitly requests autonomous metric-driven experimentation. For a new run, select a Host-provided evaluator_id and provide a narrow mutable path set. To resume, provide resume_run_id instead; never supply evaluator_id or any other evaluator authority on resume. Runs are background jobs by default and can be inspected or stopped with the generic job tools. Do not invoke it for ordinary coding or open-ended research.'


interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function startupFailure(jobId: string, error: unknown, cancelled: boolean): BackgroundStartFailedToolResult {
  const message = reason(error)
  return {
    kind: 'background-start-failed',
    jobId,
    status: cancelled ? 'cancelled' : 'failed',
    reason: message,
    evidence: [{ code: cancelled ? 'cancelled' : 'startup-failed', message, artifacts: [] }],
  }
}

function jobOutcome(result: AutoresearchRunResult, maxResultChars: number): JobOutcome {
  const output = JSON.stringify(result)
  const detail = result.status
  if (result.status === 'cancelled') return { status: 'killed', detail, output }
  if (result.status === 'baseline-blocked' || result.status === 'blocked' || result.status === 'round-failed') return { status: 'failed', detail, output }
  return { status: 'completed', detail, output: output.length <= maxResultChars ? output : JSON.stringify({ status: result.status, runId: result.runId, tracker: result.tracker }) }
}

function presentCall(args: ActivationAutoresearchToolInput): ToolCallView {
  return { card: 'generic', title: 'autoresearch', rawInput: args.objective }
}

function requireServices(ctx: Context): void {
  const services = ctx as unknown as Record<string, unknown>
  for (const service of inject) {
    if (services[service] === undefined) throw new Error(`autoresearch requires the ctx.${service} service`)
  }
  const agents = services['agents'] as { create?: unknown }
  if (typeof agents.create !== 'function') throw new Error('autoresearch requires a compatible ctx.agents.create runtime with child setup support')
  const jobs = services['jobs'] as { start?: unknown }
  if (typeof jobs.start !== 'function') throw new Error('autoresearch requires a compatible ctx.jobs registry')
}

/** Register the Host-authoritative evaluator contract and its sole production start/resume route. */
export function apply(ctx: Context, config: AutoresearchConfig = {}): void {
  requireServices(ctx)
  const resolved = resolveConfig(config)
  const active = new Set<AutoresearchRunController>()
  const activeJobs = new Set<Promise<JobOutcome>>()
  const releasePrompt = ctx.systemPrompt.section({ name: 'tool:autoresearch', order: 116.25, text: GUIDANCE })
  const releaseTool = ctx.tools.register(defineTool({
    name: 'autoresearch',
    description: DESCRIPTION,
    parameters: ACTIVATION_AUTORESEARCH_TOOL_SCHEMA,
    output: {
      schema: AUTORESEARCH_TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value as unknown as AutoresearchToolResult, resolved.maxResultChars) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('autoresearch requires the exact calling agent in exec.agent')
      const input = decodeActivationToolInput(args) as ActivationAutoresearchToolInput
      validateAutoresearchRequest(resolved, input)
      if ((input.mode ?? 'background') === 'foreground') {
        const controller = new AutoresearchRunController(ctx, { config: resolved, input, parent, signal: exec.signal })
        active.add(controller)
        try {
          return { kind: 'foreground', run: await controller.run() } as never
        } finally {
          active.delete(controller)
          await controller.dispose()
        }
      }

      const gate = deferred<void>()
      const readiness = deferred<AutoresearchToolResult>()
      let controller: AutoresearchRunController | undefined
      let hooks: { cancel(value?: string): void; done: Promise<JobOutcome> } | undefined
      let jobId = ''
      let registered = false
      let cancelled = false
      let cancellationApplied = false
      let cancelReason = 'autoresearch job killed'

      const repositoryPreflight = await preflightAutoresearchRepository(ctx, { config: resolved, input, parent, signal: exec.signal })

      try {
        const id = ctx.jobs.start({
          kind: 'autoresearch',
          label: `autoresearch: ${input.objective}`,
          owner: parent as Agent,
          outputLimitBytes: resolved.maxResultChars,
          run: () => {
            controller = new AutoresearchRunController(ctx, { config: resolved, input, parent, signal: new AbortController().signal, repositoryPreflight })
            active.add(controller)
            const done = (async (): Promise<JobOutcome> => {
              try {
                await gate.promise
                if (!registered) throw new Error(cancelReason)
                if (cancelled) controller!.cancel(cancelReason)
                const running = controller!.run()
                try {
                  const ready = await controller!.ready
                  readiness.resolve({ kind: 'background', jobId, ...ready })
                } catch (error) {
                  readiness.resolve(startupFailure(jobId, error, cancelled))
                }
                return jobOutcome(await running, resolved.maxResultChars)
              } catch (error) {
                readiness.resolve(startupFailure(jobId || 'unregistered', error, cancelled))
                const failure = startupFailure(jobId || 'unregistered', error, cancelled)
                return { status: cancelled ? 'killed' : 'failed', detail: reason(error), output: JSON.stringify(failure) }
              } finally {
                if (controller) {
                  await controller.dispose()
                  active.delete(controller)
                }
              }
            })()
            activeJobs.add(done)
            hooks = {
              cancel(value?: string) {
                if (cancellationApplied) return
                if (!cancelled) {
                  cancelled = true
                  cancelReason = value ?? cancelReason
                }
                controller!.cancel(cancelReason)
                cancellationApplied = true
              },
              done,
            }
            return hooks
          },
        })
        jobId = String(id)
        const startedHooks = hooks
        if (startedHooks) void startedHooks.done.then(
          () => setImmediate(() => activeJobs.delete(startedHooks.done)),
          () => setImmediate(() => activeJobs.delete(startedHooks.done)),
        )
        if (!controller) throw new Error('job registry did not start the autoresearch controller')
        await controller.prepare(jobId)
        registered = true
        gate.resolve()
        return await readiness.promise as never
      } catch (error) {
        cancelled = true
        cancelReason = reason(error)
        controller?.cancel(cancelReason)
        gate.resolve()
        if (hooks) await hooks.done.catch(() => undefined)
        else if (controller) { await controller.dispose(); active.delete(controller) }
        return startupFailure(jobId || 'unregistered', error, false) as never
      }
    },
    presentCall: args => presentCall(args as unknown as ActivationAutoresearchToolInput),
    presentResult: () => ({ card: 'generic' }),
  }))

  let released = false
  ctx.effect(() => async () => {
    if (released) return
    released = true
    releaseTool()
    releasePrompt()
    const settling = [...active].map(async controller => { controller.cancel('autoresearch plugin disposed'); await controller.dispose() })
    await Promise.allSettled(settling)
    await Promise.allSettled([...activeJobs])
  }, 'autoresearch.lifecycle()')
}
