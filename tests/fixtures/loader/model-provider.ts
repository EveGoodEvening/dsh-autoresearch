import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'

export const name = 'autoresearch-test-model'
export const inject = ['llm']
const globalState = globalThis as typeof globalThis & { __autoresearchModelCalls?: Array<{ provider: string; model: string; tools: string[] }> }
export const calls = globalState.__autoresearchModelCalls ??= []
let modelGate: PromiseWithResolvers<void> | undefined

export function holdModel(): void {
  modelGate ??= Promise.withResolvers<void>()
}

export function releaseModel(): void {
  modelGate?.resolve()
  modelGate = undefined
}

function proposalHandoff(options: GenerateOptions): { identity: { runId: string; experimentId: string; ordinal: number; nonce: string }; workspace: { worktree: string } } {
  const serialized = JSON.stringify(options.messages)
  const marker = 'AUTORESEARCH PROPOSAL ROUND\\n\\n'
  const start = serialized.indexOf(marker)
  if (start < 0) throw new Error('proposal handoff missing from model request')
  const decoded = JSON.parse(serialized) as unknown
  const walk = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.startsWith('AUTORESEARCH PROPOSAL ROUND\n\n')) return value
    if (Array.isArray(value)) for (const item of value) { const found = walk(item); if (found) return found }
    if (value && typeof value === 'object') for (const item of Object.values(value)) { const found = walk(item); if (found) return found }
  }
  const prompt = walk(decoded)
  if (!prompt) throw new Error('proposal prompt text missing')
  return JSON.parse(prompt.slice('AUTORESEARCH PROPOSAL ROUND\n\n'.length)) as { identity: { runId: string; experimentId: string; ordinal: number; nonce: string }; workspace: { worktree: string } }
}

function toolCall(name: string, args: unknown, idText: string): StreamChunk[] {
  const id = CallId(idText)
  const raw = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } },
    { type: 'finish', reason: 'tool-calls' },
  ]
}

class BoundedAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Bounded test provider' } }
  async listModels(): Promise<readonly LlmModelInfo[]> { return [{ id: 'bounded-model', name: 'Bounded model' }] }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { id: model, name: model, provider } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push({ provider: options.provider, model: options.model, tools: options.tools?.map(tool => tool.name) ?? [] })
    await modelGate?.promise
    const serialized = JSON.stringify(options.messages)
    const handoff = proposalHandoff(options)
    const chunks = serialized.includes('"name":"read"')
      ? toolCall('autoresearch_report', { ...handoff.identity, hypothesis: 'Inspect the strict fixture score', intendedEdits: ['score.txt'], implementationSummary: 'Observed the bounded candidate input without changing it.', blockerClaim: null }, 'report-call')
      : toolCall('read', { file_path: join(handoff.workspace.worktree, 'score.txt') }, 'read-call')
    for (const chunk of chunks) yield chunk
  }
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['autoresearch-test'], new BoundedAdapter())
}
