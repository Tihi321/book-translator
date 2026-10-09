import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DocumentIR } from '../../shared/ir'
import type { ChunkRecord, GlossaryEntry, ProjectFile, ProjectSettings } from '../../shared/project'
import { atomicWrite } from '../store/atomic'
import { parseGlossary, serializeGlossary } from '../pipeline/glossary'
import type { PlannedChunk } from '../chunker'

const chunkName = (index: number) => `${String(index).padStart(4, '0')}.json`

export function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'book'
  )
}

export async function hashFile(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/** `<name>-<lang>-<hash6>`: the same file and language give the same project, so starting again resumes it. */
export function projectIdFor(sourcePath: string, lang: string, hash: string): string {
  return `${slug(path.basename(sourcePath, path.extname(sourcePath)))}-${slug(lang)}-${hash.slice(0, 6)}`
}

export function emptyChunk(p: PlannedChunk): ChunkRecord {
  return {
    index: p.index,
    sectionId: p.sectionId,
    blockIds: [...new Set(p.segments.map((s) => s.blockId))],
    segments: p.segments,
    translation: {},
    proofread: {},
    final: {},
    qa: { issues: [] },
    state: 'pending',
    tokens: { in: 0, out: 0 },
    costUsd: 0,
    ms: 0
  }
}

/** The files of the projects in `<data>/projects/<id>/`. Everything is written atomically except log.md, which is appended to. */
export class ProjectStore {
  private saves = new Map<string, Promise<void>>()

  constructor(readonly dataDir: string) {}

  root(): string {
    return path.join(this.dataDir, 'projects')
  }

  dir(id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid project id: ${id}`)
    return path.join(this.root(), id)
  }

  file(id: string, ...parts: string[]): string {
    return path.join(this.dir(id), ...parts)
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.file(id, 'project.json'))
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<ProjectFile[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root())
    } catch {
      return []
    }
    const out: ProjectFile[] = []
    for (const n of names) {
      try {
        out.push(await this.load(n))
      } catch {
        // not a project folder
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Writes project.json, source.json, glossary.md, brief.md, log.md and the output folder. */
  async create(project: ProjectFile, ir: DocumentIR): Promise<void> {
    await fs.mkdir(this.file(project.id, 'chunks'), { recursive: true })
    await fs.mkdir(this.file(project.id, 'output'), { recursive: true })
    await this.save(project)
    await atomicWrite(this.file(project.id, 'source.json'), JSON.stringify(ir))
    await atomicWrite(this.file(project.id, 'glossary.md'), serializeGlossary([]))
    await atomicWrite(this.file(project.id, 'brief.md'), '')
    await atomicWrite(this.file(project.id, 'log.md'), `# Log of ${project.name}\n\n`)
  }

  async load(id: string): Promise<ProjectFile> {
    const p = JSON.parse(await fs.readFile(this.file(id, 'project.json'), 'utf8')) as ProjectFile
    if (!p || p.id !== id) throw new Error(`bad project.json in ${id}`)
    return p
  }

  /** Saves project.json. Saves of one project are queued, so parallel workers cannot interleave them. */
  save(project: ProjectFile): Promise<void> {
    const prev = this.saves.get(project.id) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(() => {
        project.updatedAt = new Date().toISOString()
        return atomicWrite(this.file(project.id, 'project.json'), JSON.stringify(project, null, 2))
      })
    this.saves.set(project.id, next)
    return next
  }

  async readIr(id: string): Promise<DocumentIR> {
    return JSON.parse(await fs.readFile(this.file(id, 'source.json'), 'utf8')) as DocumentIR
  }

  async writeChunk(id: string, chunk: ChunkRecord): Promise<void> {
    await atomicWrite(this.file(id, 'chunks', chunkName(chunk.index)), JSON.stringify(chunk, null, 2))
  }

  async readChunk(id: string, index: number): Promise<ChunkRecord> {
    return JSON.parse(await fs.readFile(this.file(id, 'chunks', chunkName(index)), 'utf8')) as ChunkRecord
  }

  /** All chunks in order. */
  async listChunks(id: string): Promise<ChunkRecord[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.file(id, 'chunks'))
    } catch {
      return []
    }
    const out: ChunkRecord[] = []
    for (const n of names.filter((x) => /^\d{4}\.json$/.test(x)).sort()) out.push(JSON.parse(await fs.readFile(this.file(id, 'chunks', n), 'utf8')) as ChunkRecord)
    return out
  }

  async clearChunks(id: string): Promise<void> {
    await fs.rm(this.file(id, 'chunks'), { recursive: true, force: true })
    await fs.mkdir(this.file(id, 'chunks'), { recursive: true })
  }

  async readGlossary(id: string): Promise<GlossaryEntry[]> {
    try {
      return parseGlossary(await fs.readFile(this.file(id, 'glossary.md'), 'utf8'))
    } catch {
      return []
    }
  }

  async writeGlossary(id: string, entries: readonly GlossaryEntry[]): Promise<void> {
    await atomicWrite(this.file(id, 'glossary.md'), serializeGlossary(entries))
  }

  async readBrief(id: string): Promise<string> {
    try {
      return (await fs.readFile(this.file(id, 'brief.md'), 'utf8')).trim()
    } catch {
      return ''
    }
  }

  async writeBrief(id: string, text: string): Promise<void> {
    await atomicWrite(this.file(id, 'brief.md'), text)
  }

  async log(id: string, message: string): Promise<void> {
    try {
      await fs.appendFile(this.file(id, 'log.md'), `- ${new Date().toISOString()} ${message.replace(/\s+/g, ' ')}\n`, 'utf8')
    } catch {
      // logging must never break a run
    }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.dir(id), { recursive: true, force: true })
  }
}

export function mergeSettings(base: ProjectSettings, patch: Partial<ProjectSettings> | undefined): ProjectSettings {
  if (!patch) return base
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  return {
    ...base,
    ...defined,
    agentModels: { ...base.agentModels, ...(patch.agentModels ?? {}) },
    enabled: { ...base.enabled, ...(patch.enabled ?? {}) }
  }
}
