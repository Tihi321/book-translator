import type { Block, DocumentIR } from '../../shared/ir'
import type { ChunkRecord, SegmentRec } from '../../shared/project'
import type { RefreshResult } from '../../shared/protocol'
import { emptyChunk } from './store'
import { packSegments, segmentsForBlock } from '../chunker'
import { countTokens } from '../tokens'

/** The blocks a translation covers: the ones `planChunks` takes (not `meta`, text not blank), in document order. */
export function translatableBlocks(ir: DocumentIR): Block[] {
  return ir.sections.flatMap((s) => s.blocks.filter((b) => b.kind !== 'meta' && b.text.trim() !== ''))
}

type Counts = Omit<RefreshResult, 'unchanged' | 'sourcePath' | 'backupRel'>

interface Item {
  seg: SegmentRec
  /** Where the translation of this segment comes from, when it is carried over. */
  from?: { chunk: ChunkRecord; oldId: string }
}

/**
 * Re-chunks a project for an edited source, with no I/O. Blocks are matched by exact text, never by id (ids are positional, so an inserted
 * paragraph renumbers everything after it), with an in-order alignment (`alignTexts`), so a repeated paragraph matches the copy in its place,
 * then a second pass (`matchMoved`) that gives a moved paragraph its old block. A block with a match whose segments are all translated (chunk `done` or `flagged`) keeps its
 * translation, proofread text, hand edit and QA verdict in a kept chunk, which is never run again. Changed and new blocks go into new pending
 * chunks. Removed blocks are dropped. Chunks are numbered 1..N in document order. `editedKept` and `editsDropped` count hand-edited segments
 * (`isHandEdit`), kept and dropped; `droppedEdits` names the first dropped ones.
 */
export function refreshChunks(oldIr: DocumentIR, oldChunks: readonly ChunkRecord[], newIr: DocumentIR, budget: number, count: (t: string) => number = countTokens): { chunks: ChunkRecord[]; report: Counts } {
  // the old segments by id, with the chunk that holds them
  const oldSegs = new Map<string, { chunk: ChunkRecord; seg: SegmentRec }>()
  for (const chunk of oldChunks) for (const seg of chunk.segments) oldSegs.set(seg.id, { chunk, seg })

  // the old and new blocks aligned in order by text: match[k] is the old block of the k-th new translatable block
  const oldBlocks = translatableBlocks(oldIr)
  const oldTexts = oldBlocks.map((b) => b.text)
  const newTexts = translatableBlocks(newIr).map((b) => b.text)
  const match = matchMoved(oldTexts, newTexts, alignTexts(oldTexts, newTexts))
  let k = 0

  const carriedFrom = (oldId: string, text: string): Item['from'] => {
    const o = oldSegs.get(oldId)
    if (!o || o.seg.text !== text) return undefined
    if (o.chunk.state !== 'done' && o.chunk.state !== 'flagged') return undefined
    return o.chunk.final[oldId] === undefined ? undefined : { chunk: o.chunk, oldId }
  }

  let blocksKept = 0
  let blocksToTranslate = 0
  let editedKept = 0
  let matched = 0
  const carried = new Set<string>()
  const sections: { id: string; items: Item[] }[] = []
  for (const section of newIr.sections) {
    const items: Item[] = []
    for (const block of section.blocks) {
      if (block.kind === 'meta' || block.text.trim() === '') continue
      const segs = segmentsForBlock(block, budget, count)
      const m = match[k++]
      const old = m === undefined ? undefined : oldBlocks[m]
      let froms: Item['from'][] = segs.map(() => undefined)
      if (old) {
        matched++
        const found = segs.map((s, i) => carriedFrom(segs.length === 1 ? old.id : `${old.id}#${i + 1}`, s.text))
        // all or none: one part that is not carried sends the whole block to translation
        if (found.every((f) => f)) froms = found
      }
      if (froms.every((f) => f)) blocksKept++
      else blocksToTranslate++
      segs.forEach((seg, i) => {
        const from = froms[i]
        if (from) {
          carried.add(from.oldId)
          if (isHandEdit(from.chunk, from.oldId)) editedKept++
        }
        items.push({ seg, from })
      })
    }
    sections.push({ id: section.id, items })
  }

  const chunks: ChunkRecord[] = []
  const kept = new Set<ChunkRecord>()
  for (const section of sections) {
    let i = 0
    while (i < section.items.length) {
      const first = section.items[i]!
      let j = i + 1
      if (first.from) {
        while (j < section.items.length && section.items[j]!.from?.chunk === first.from.chunk) j++
        const k = keptChunk(chunks.length + 1, section.id, section.items.slice(i, j), first.from.chunk)
        kept.add(k)
        chunks.push(k)
      } else {
        while (j < section.items.length && !section.items[j]!.from) j++
        const planned = packSegments(section.id, section.items.slice(i, j).map((x) => x.seg), budget, chunks.length + 1, count)
        for (const p of planned) chunks.push(emptyChunk(p))
      }
      i = j
    }
  }

  const dropped = oldChunks.flatMap((c) => c.segments.filter((s) => !carried.has(s.id) && isHandEdit(c, s.id)).map((s) => ({ chunk: c.index, segment: s.id, text: c.final[s.id] ?? '' })))
  return {
    chunks,
    report: {
      blocks: { kept: blocksKept, toTranslate: blocksToTranslate, removed: oldBlocks.length - matched },
      chunks: { total: chunks.length, kept: kept.size, toTranslate: chunks.length - kept.size },
      editedKept,
      editsDropped: dropped.length,
      droppedEdits: dropped.slice(0, MAX_DROPPED_LISTED).map((d) => ({ ...d, text: cut(d.text, DROPPED_TEXT_CHARS) }))
    }
  }
}

/** Dropped hand edits that `refreshChunks` names (the count is always given), and how much of each old text it keeps. */
const MAX_DROPPED_LISTED = 20
const DROPPED_TEXT_CHARS = 160

/** `text`, or its first `max - 1` characters and an ellipsis. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * A segment the user changed with edit_chunk (`editedSegs`). A chunk edited before `editedSegs` was kept falls back to a guess: in a chunk
 * marked `edited`, a segment whose final text is not the translator's or proofreader's text (a fix-pass rewrite matches it too).
 */
function isHandEdit(c: ChunkRecord, segId: string): boolean {
  if (c.editedSegs) return c.editedSegs.includes(segId)
  if (!c.edited) return false
  const final = c.final[segId]
  return final !== undefined && final !== (c.proofread[segId] ?? c.translation[segId])
}

/**
 * The second pass after `alignTexts`: each new text still unmatched takes an unused old block with exactly the same text, the first such
 * old block in document order. So a moved paragraph keeps its translation and hand edit, while repeats keep their in-order match.
 */
function matchMoved(oldTexts: readonly string[], newTexts: readonly string[], match: (number | undefined)[]): (number | undefined)[] {
  const used = new Set(match.filter((m) => m !== undefined))
  const free = new Map<string, number[]>()
  oldTexts.forEach((t, i) => {
    if (used.has(i)) return
    const q = free.get(t)
    if (q) q.push(i)
    else free.set(t, [i])
  })
  return match.map((m, j) => m ?? free.get(newTexts[j]!)?.shift())
}

/** Above this many cells a gap with no unique anchor is matched greedily instead of by a full LCS table. */
const LCS_CELLS = 1_000_000

/**
 * Aligns two text sequences in order, patience-diff style: the result gives, for each new index, the old index it matches, and matched
 * pairs keep their relative order. A common prefix and suffix match first; then the texts that occur once on each side are anchors (their
 * longest run in order), and the gaps between anchors are aligned the same way. A gap with no anchor gets an exact LCS, or, when too big for
 * one, a greedy in-order match. Linear in practice on a book; repeats ("* * *", "Yes.") match the copy in the same place.
 */
export function alignTexts(oldTexts: readonly string[], newTexts: readonly string[]): (number | undefined)[] {
  const ids = new Map<string, number>()
  const id = (t: string) => {
    let v = ids.get(t)
    if (v === undefined) ids.set(t, (v = ids.size))
    return v
  }
  const a = oldTexts.map(id)
  const b = newTexts.map(id)
  const out: (number | undefined)[] = new Array<number | undefined>(b.length).fill(undefined)
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]]
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop()!
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out[b0++] = a0++
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) out[--b1] = --a1
    if (a0 === a1 || b0 === b1) continue

    // anchors: texts that occur exactly once in each range, the longest chain increasing on both sides
    const seen = new Map<number, { na: number; ia: number; nb: number; ib: number }>()
    for (let i = a0; i < a1; i++) {
      const s = seen.get(a[i]!) ?? { na: 0, ia: i, nb: 0, ib: 0 }
      s.na++
      seen.set(a[i]!, s)
    }
    for (let j = b0; j < b1; j++) {
      const s = seen.get(b[j]!)
      if (s) {
        s.nb++
        s.ib = j
      }
    }
    const pairs = [...seen.values()].filter((s) => s.na === 1 && s.nb === 1).sort((x, y) => x.ib - y.ib)
    if (pairs.length) {
      const chain = longestIncreasing(pairs.map((p) => p.ia))
      let pa = a0
      let pb = b0
      for (const c of chain) {
        const p = pairs[c]!
        out[p.ib] = p.ia
        stack.push([pa, p.ia, pb, p.ib])
        pa = p.ia + 1
        pb = p.ib + 1
      }
      stack.push([pa, a1, pb, b1])
    } else if ((a1 - a0) * (b1 - b0) <= LCS_CELLS) lcs(a, a0, a1, b, b0, b1, out)
    else greedy(a, a0, a1, b, b0, b1, out)
  }
  return out
}

/** The indices (into `xs`) of a longest strictly increasing subsequence, in order. */
function longestIncreasing(xs: readonly number[]): number[] {
  const tails: number[] = []
  const prev: number[] = new Array<number>(xs.length).fill(-1)
  for (let i = 0; i < xs.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[tails[mid]!]! < xs[i]!) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const chain: number[] = []
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) chain.push(i)
  return chain.reverse()
}

function lcs(a: readonly number[], a0: number, a1: number, b: readonly number[], b0: number, b1: number, out: (number | undefined)[]): void {
  const n = a1 - a0
  const m = b1 - b0
  // t[i][j] = LCS length of a[a0+i..a1) and b[b0+j..b1)
  const t = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => t[i * (m + 1) + j]!
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * (m + 1) + j] = a[a0 + i] === b[b0 + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) out[b0 + j++] = a0 + i++
    else if (at(i + 1, j) >= at(i, j + 1)) i++
    else j++
  }
}

/** Each new text takes the first old copy after the last match. */
function greedy(a: readonly number[], a0: number, a1: number, b: readonly number[], b0: number, b1: number, out: (number | undefined)[]): void {
  const at = new Map<number, number[]>()
  for (let i = a0; i < a1; i++) {
    const q = at.get(a[i]!) ?? []
    q.push(i)
    at.set(a[i]!, q)
  }
  const next = new Map<number, number>()
  let last = a0 - 1
  for (let j = b0; j < b1; j++) {
    const q = at.get(b[j]!)
    if (!q) continue
    let p = next.get(b[j]!) ?? 0
    while (p < q.length && q[p]! <= last) p++
    next.set(b[j]!, p)
    if (p < q.length) {
      out[j] = q[p]!
      last = q[p]!
    }
  }
}

function keptChunk(index: number, sectionId: string, run: Item[], c: ChunkRecord): ChunkRecord {
  const segments = run.map((x) => x.seg)
  const ids = new Map(run.map((x) => [x.from!.oldId, x.seg.id]))
  const rekey = (r: Record<string, string>) => {
    const out: Record<string, string> = {}
    for (const x of run) if (r[x.from!.oldId] !== undefined) out[x.seg.id] = r[x.from!.oldId]!
    return out
  }
  const whole = run.length === c.segments.length
  return {
    ...c,
    index,
    sectionId,
    blockIds: [...new Set(segments.map((s) => s.blockId))],
    segments,
    translation: rekey(c.translation),
    proofread: rekey(c.proofread),
    final: rekey(c.final),
    editedSegs: c.editedSegs && run.filter((x) => c.editedSegs!.includes(x.from!.oldId)).map((x) => x.seg.id),
    qa: { ...c.qa, issues: c.qa.issues.filter((q) => ids.has(q.segId)).map((q) => ({ ...q, segId: ids.get(q.segId)! })) },
    tokens: whole ? c.tokens : { in: 0, out: 0 },
    costUsd: whole ? c.costUsd : 0,
    ms: whole ? c.ms : 0,
    error: undefined
  }
}
