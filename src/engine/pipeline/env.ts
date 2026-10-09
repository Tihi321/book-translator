import type { ChatMessage, Usage } from '../models/types'
import type { AgentName } from '../../shared/schemas'
import type { GlossaryEntry } from '../../shared/project'
import type { ChatFn } from './llm'

export interface CallRequest {
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  /** What the call is for (translate, retry, fix, proofread, review, glossary). Shows up in the mock provider's meta and the log. */
  task?: string
  /** Which piece of work (for example `chunk-3`). */
  unit?: string
}

export interface CallResult {
  text: string
  costUsd: number
  model: string
  usage: Usage
  ms: number
}

/** One model call for an agent. The runner picks the models, sums tokens and cost, and streams the text to the UI. */
export type CallFn = (agent: AgentName, req: CallRequest, hooks?: { onDelta?: (text: string) => void }) => Promise<CallResult>

/** What the agents need to do their work. */
export interface AgentEnv {
  dataDir: string
  sourceLanguage: string
  targetLanguage: string
  /** The book brief (brief.md). */
  brief: string
  glossary: GlossaryEntry[]
  call: CallFn
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  signal?: AbortSignal
}

/** Adapts `env.call` to the `ChatFn` that `chatJson` takes. */
export function chatFn(env: Pick<AgentEnv, 'call'>, agent: AgentName, task: string, unit?: string): ChatFn {
  return async (req) => {
    const r = await env.call(agent, { ...req, task, unit })
    return { text: r.text, costUsd: r.costUsd }
  }
}

export class ChunkFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChunkFailure'
  }
}
