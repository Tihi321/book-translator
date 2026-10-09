import { encode } from 'gpt-tokenizer'

/** Token count with the o200k tokenizer. Approximate for other models; callers keep a safety margin. */
export function countTokens(text: string): number {
  return text ? encode(text).length : 0
}
