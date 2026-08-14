import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as autoresearch from '../../src/index.ts'

export interface RealHarness {
  readonly ctx: Context
  readonly autoresearchFiber?: { dispose(): Promise<void> }
  dispose(): Promise<void>
}

export async function composeHarness(options: {
  readonly autoresearch?: boolean
  readonly jobTools?: boolean
  readonly subprocess?: boolean
  readonly agents?: boolean
} = {}): Promise<RealHarness> {
  const ctx = new Context()
  const fibers = []
  fibers.push(ctx.plugin(SystemPrompt, {}))
  fibers.push(ctx.plugin(ToolRuntime, {}))
  fibers.push(ctx.plugin(LocalJobRegistry, {}))
  if (options.subprocess !== false) fibers.push(ctx.plugin(LocalSubprocessRuntime, {}))
  if (options.agents !== false) fibers.push(ctx.plugin(AgentRegistry, {}))
  if (options.jobTools !== false) fibers.push(ctx.plugin(toolJobs, { completionDelivery: 'quiet' }))
  const autoresearchFiber = options.autoresearch === false ? undefined : ctx.plugin(autoresearch, {})
  if (autoresearchFiber) fibers.push(autoresearchFiber)
  await Promise.all(fibers)
  return {
    ctx,
    autoresearchFiber,
    async dispose() {
      await Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose()))
    },
  }
}

export async function assembledPrompt(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble())
}

