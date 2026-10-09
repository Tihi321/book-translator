import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMd } from '../../shared/md'
import type { ChatMessage } from '../models/types'

/** Replaces `{{name}}` with the value. A name without a value becomes an empty string. */
export function render(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

export interface LoadedPrompt {
  /** The file as it is on disk. */
  raw: string
  /** The template: the file's text after the frontmatter. */
  body: string
}

const FALLBACK_RULES = 'You are a professional literary translator. Keep the meaning, tone and formatting of the source. Never add comments or explanations.'

/** `prompts/<agent>.md` in the data folder. */
export async function loadPrompt(dataDir: string, agent: string): Promise<LoadedPrompt> {
  const file = path.join(dataDir, 'prompts', `${agent}.md`)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    throw new Error(`prompt template missing: prompts/${agent}.md`)
  }
  return { raw, body: parseMd(raw, file).body.trim() }
}

/** `prompts/_rules.md`: rules shared by all agents. */
export async function loadRules(dataDir: string): Promise<LoadedPrompt> {
  const file = path.join(dataDir, 'prompts', '_rules.md')
  try {
    const raw = await fs.readFile(file, 'utf8')
    return { raw, body: parseMd(raw, file).body.trim() }
  } catch {
    return { raw: '', body: FALLBACK_RULES }
  }
}

/**
 * Builds the messages for an agent: the system message is the shared rules plus the agent's template
 * (rendered with `vars`), the user message is `user`.
 */
export async function buildMessages(
  dataDir: string,
  agent: string,
  vars: Record<string, string | number | undefined | null>,
  user: string
): Promise<ChatMessage[]> {
  const [prompt, rules] = await Promise.all([loadPrompt(dataDir, agent), loadRules(dataDir)])
  return [
    { role: 'system', content: `${rules.body}\n\n${render(prompt.body, vars)}`.trim() },
    { role: 'user', content: user }
  ]
}
