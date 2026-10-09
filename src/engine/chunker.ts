import type { DocumentIR } from '../shared/ir'
import type { SegmentRec } from '../shared/project'
import { DEFAULT_CONTEXT } from './models/registry'
import { tagTokens } from './formats/inline'
import { countTokens } from './tokens'

export const DEFAULT_MAX_CHUNK = 1500
/** Tokens the `<seg id="...">` wrapper adds to a segment. */
export const SEG_OVERHEAD = 8
const MIN_BUDGET = 100

export interface BudgetOptions {
  /** Context windows of the models that run per chunk (translator, proofreader, QA). The smallest counts. */
  contexts: number[]
  /** The user's upper limit (tokens of source text per chunk). Default 1500. */
  userMax?: number
  /** Tokens of the system prompt (rules, agent prompt, brief). */
  promptOverhead?: number
  /** Tokens of the glossary entries sent with a chunk. */
  glossarySlice?: number
  /** Tokens of the previous-chunk tail. */
  prevContext?: number
  /** Target text is often longer than the source: output tokens per input token. */
  expansion?: number
  /** Share of the context kept free. */
  safety?: number
}

/**
 * Source tokens per chunk: min(userMax, floor((ctx - promptOverhead - glossarySlice - prevContext - safety) / (1 + expansion))).
 * The input (source) and the output (about `expansion` times the source) both have to fit in the context.
 */
export function chunkBudget(o: BudgetOptions): number {
  const ctx = o.contexts.length > 0 ? Math.min(...o.contexts) : DEFAULT_CONTEXT
  const safety = Math.ceil(ctx * (o.safety ?? 0.15))
  const free = ctx - (o.promptOverhead ?? 600) - (o.glossarySlice ?? 400) - (o.prevContext ?? 400) - safety
  const raw = Math.floor(free / (1 + (o.expansion ?? 1.3)))
  return Math.max(MIN_BUDGET, Math.min(o.userMax ?? DEFAULT_MAX_CHUNK, raw))
}

export interface PlannedChunk {
  /** 1-based. */
  index: number
  sectionId: string
  segments: SegmentRec[]
  /** Source tokens, wrapper overhead included. */
  tokens: number
}

type Counter = (text: string) => number

/** Splits text at sentence boundaries into pieces of at most `budget` tokens. Pieces keep their whitespace. */
function splitSentences(text: string, budget: number, count: Counter): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' })
  const sentences: string[] = []
  for (const s of seg.segment(text)) {
    // one sentence over the budget on its own: cut it at word boundaries
    if (count(s.segment) > budget) sentences.push(...splitWords(s.segment, budget, count))
    else sentences.push(s.segment)
  }
  const pieces: string[] = []
  let cur = ''
  let curTokens = 0
  let depth = 0
  for (const s of sentences) {
    const t = count(s)
    // only break where no inline tag pair is open, so every piece keeps its pairs together
    if (cur && depth === 0 && curTokens + t > budget) {
      pieces.push(cur)
      cur = ''
      curTokens = 0
    }
    cur += s
    curTokens += t
    for (const tok of tagTokens(s)) depth += tok.type === 'open' ? 1 : tok.type === 'close' ? -1 : 0
  }
  if (cur) pieces.push(cur)
  return pieces
}

function splitWords(text: string, budget: number, count: Counter): string[] {
  const out: string[] = []
  let cur = ''
  let curTokens = 0
  for (const w of text.split(/(?<=\s)/)) {
    const t = count(w)
    if (cur && curTokens + t > budget) {
      out.push(cur)
      cur = ''
      curTokens = 0
    }
    cur += w
    curTokens += t
  }
  if (cur) out.push(cur)
  return out
}

/** One segment for a block, or several (`<id>#1`, `<id>#2` ...) when the block does not fit in a chunk. */
export function segmentsForBlock(block: { id: string; text: string }, budget: number, count: Counter = countTokens): SegmentRec[] {
  const room = Math.max(MIN_BUDGET / 2, budget - SEG_OVERHEAD)
  if (count(block.text) <= room) return [{ id: block.id, blockId: block.id, text: block.text }]
  const pieces = splitSentences(block.text, room, count)
  if (pieces.length <= 1) return [{ id: block.id, blockId: block.id, text: block.text }]
  return pieces.map((p, i) => ({ id: `${block.id}#${i + 1}`, blockId: block.id, part: i + 1, parts: pieces.length, text: p.trim() }))
}

/**
 * Packs whole blocks into chunks of at most `budget` tokens, in order, never across a section. A block over the budget is split into
 * sentence pieces first. `meta` blocks (code and the like) and empty blocks are left out: they stay as they are in the output.
 */
export function planChunks(ir: DocumentIR, budget: number, count: Counter = countTokens): PlannedChunk[] {
  const chunks: PlannedChunk[] = []
  for (const section of ir.sections) {
    let cur: SegmentRec[] = []
    let tokens = 0
    const flush = () => {
      if (cur.length === 0) return
      chunks.push({ index: chunks.length + 1, sectionId: section.id, segments: cur, tokens })
      cur = []
      tokens = 0
    }
    for (const block of section.blocks) {
      if (block.kind === 'meta' || block.text.trim() === '') continue
      for (const seg of segmentsForBlock(block, budget, count)) {
        const t = count(seg.text) + SEG_OVERHEAD
        if (cur.length > 0 && tokens + t > budget) flush()
        cur.push(seg)
        tokens += t
      }
    }
    flush()
  }
  return chunks
}
