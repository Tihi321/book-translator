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
 * paragraph renumbers everything after it). A block with a match whose segments are all translated (chunk `done` or `flagged`) keeps its
 * translation, proofread text, hand edit and QA verdict in a kept chunk, which is never run again. Changed and new blocks go into new pending
 * chunks. Removed blocks are dropped. Chunks are numbered 1..N in document order.
 */
export function refreshChunks(oldIr: DocumentIR, oldChunks: readonly ChunkRecord[], newIr: DocumentIR, budget: number, count: (t: string) => number = countTokens): { chunks: ChunkRecord[]; report: Counts } {
  // the old segments by id, with the chunk that holds them
  const oldSegs = new Map<string, { chunk: ChunkRecord; seg: SegmentRec }>()
  for (const chunk of oldChunks) for (const seg of chunk.segments) oldSegs.set(seg.id, { chunk, seg })

  // old blocks by text, in document order: each new block takes the first unused one
  const queues = new Map<string, Block[]>()
  const oldBlocks = translatableBlocks(oldIr)
  for (const b of oldBlocks) {
    const q = queues.get(b.text) ?? []
    q.push(b)
    queues.set(b.text, q)
  }

  const carriedFrom = (oldId: string, text: string): Item['from'] => {
    const o = oldSegs.get(oldId)
    if (!o || o.seg.text !== text) return undefined
    if (o.chunk.state !== 'done' && o.chunk.state !== 'flagged') return undefined
    return o.chunk.final[oldId] === undefined ? undefined : { chunk: o.chunk, oldId }
  }

  let blocksKept = 0
  let blocksToTranslate = 0
  let matched = 0
  const sections: { id: string; items: Item[] }[] = []
  for (const section of newIr.sections) {
    const items: Item[] = []
    for (const block of section.blocks) {
      if (block.kind === 'meta' || block.text.trim() === '') continue
      const segs = segmentsForBlock(block, budget, count)
      const old = queues.get(block.text)?.shift()
      let froms: Item['from'][] = segs.map(() => undefined)
      if (old) {
        matched++
        const found = segs.map((s, i) => carriedFrom(segs.length === 1 ? old.id : `${old.id}#${i + 1}`, s.text))
        // all or none: one part that is not carried sends the whole block to translation
        if (found.every((f) => f)) froms = found
      }
      if (froms.every((f) => f)) blocksKept++
      else blocksToTranslate++
      segs.forEach((seg, i) => items.push({ seg, from: froms[i] }))
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

  return {
    chunks,
    report: {
      blocks: { kept: blocksKept, toTranslate: blocksToTranslate, removed: oldBlocks.length - matched },
      chunks: { total: chunks.length, kept: kept.size, toTranslate: chunks.length - kept.size },
      editedKept: [...kept].filter((c) => c.edited).length
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
    qa: { ...c.qa, issues: c.qa.issues.filter((q) => ids.has(q.segId)).map((q) => ({ ...q, segId: ids.get(q.segId)! })) },
    tokens: whole ? c.tokens : { in: 0, out: 0 },
    costUsd: whole ? c.costUsd : 0,
    ms: whole ? c.ms : 0,
    error: undefined
  }
}
