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
interface ProposalHandoff {
  readonly identity: { readonly runId: string; readonly experimentId: string; readonly ordinal: number; readonly nonce: string }
  readonly workspace: { readonly worktree: string }
}


function proposalHandoff(options: GenerateOptions): ProposalHandoff {
  const serialized = JSON.stringify(options.messages)
  const marker = 'AUTORESEARCH PROPOSAL ROUND\\n\\n'
  if (!serialized.includes(marker)) throw new Error('proposal handoff missing from model request')

  function findPrompt(value: unknown): string | undefined {
    if (typeof value === 'string' && value.startsWith('AUTORESEARCH PROPOSAL ROUND\n\n')) return value
    if (Array.isArray(value)) {
      for (const item of value) {
        const prompt = findPrompt(item)
        if (prompt) return prompt
      }
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        const prompt = findPrompt(item)
        if (prompt) return prompt
      }
    }
    return undefined
  }

  const prompt = findPrompt(JSON.parse(serialized) as unknown)
  if (!prompt) throw new Error('proposal prompt text missing')
  return JSON.parse(prompt.slice('AUTORESEARCH PROPOSAL ROUND\n\n'.length)) as ProposalHandoff
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
    const releaseAccepted = serialized.includes('release accepted candidate')
    const releaseRejected = serialized.includes('release rejected candidate')
    const releaseTie = serialized.includes('release tie candidate')
    let chunks: StreamChunk[]
    if ((releaseAccepted || releaseRejected || releaseTie) && !serialized.includes('release-score-read')) {
      chunks = toolCall('read', { file_path: join(handoff.workspace.worktree, 'score.txt') }, 'release-score-read')
    } else if ((releaseAccepted || releaseRejected || releaseTie) && !serialized.includes('release-score-write')) {
      let content = '1\n'
      if (releaseAccepted) content = '0\n'
      else if (releaseRejected) content = '2\n'
      chunks = toolCall('write', {
        file_path: join(handoff.workspace.worktree, 'score.txt'),
        content,
      }, 'release-score-write')
    } else if (serialized.includes('"name":"read"') || releaseAccepted || releaseRejected || releaseTie) {
      chunks = toolCall('autoresearch_report', { ...handoff.identity, hypothesis: 'Inspect the strict fixture score', intendedEdits: ['score.txt'], implementationSummary: releaseAccepted || releaseRejected || releaseTie ? 'Wrote the bounded release scenario score.' : 'Observed the bounded candidate input without changing it.', blockerClaim: null }, 'report-call')
    } else {
      chunks = toolCall('read', { file_path: join(handoff.workspace.worktree, 'score.txt') }, 'read-call')
    }
    for (const chunk of chunks) yield chunk
  }
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['autoresearch-test'], new BoundedAdapter())
}
