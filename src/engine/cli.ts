import { adapterFor } from './formats'
import { resolveKey, setStoredKey, KEYRING_SERVICE } from './models/keys'
import { scriptDevMock } from './models/devMock'
import { ModelRegistry } from './models/registry'
import { countTokens } from './tokens'
import { countStates } from './project/summary'
import { EngineService } from './service'
import { AGENTS } from '../shared/schemas'
import type { AgentName } from '../shared/schemas'
import type { ProjectSettings } from '../shared/project'
import { argValue, initDataFolder, resolveDataDir } from './store/dataFolder'

const out = (s: string) => process.stdout.write(s + '\n')

async function loadRegistry(argv: string[]): Promise<{ registry: ModelRegistry; dataDir: string }> {
  const dataDir = resolveDataDir({ argv })
  const seed = argValue(argv, 'seed')
  await initDataFolder(dataDir, seed)
  const registry = new ModelRegistry(dataDir)
  await registry.load()
  return { registry, dataDir }
}

/** `engine models`: lists the configured and discovered models. */
export async function listModels(argv: string[]): Promise<number> {
  const { registry, dataDir } = await loadRegistry(argv)
  out(`data folder: ${dataDir}`)
  for (const d of await registry.discover()) out(`discovery ${d.provider}: ${d.error ? 'failed (' + d.error + ')' : d.found + ' model(s)'}`)
  out('')
  for (const p of registry.providers.values()) {
    out(`${p.id} [${p.kind}${p.local ? ', local' : ''}] ${p.available ? 'available' : 'unavailable: ' + (p.unavailableReason ?? '?')}`)
    for (const m of [...registry.models.values()].filter((x) => x.provider === p)) {
      const ctx = registry.contextLength(m.ref)
      const note = m.loadedContext !== undefined ? ' (loaded)' : m.context === undefined ? ' (default)' : ''
      const price = p.local || (m.priceIn === 0 && m.priceOut === 0) ? 'free' : `$${m.priceIn}/$${m.priceOut} per 1M`
      out(`  ${m.ref}  ctx ${ctx}${note}  ${price}${m.embedding ? '  embedding' : ''}${m.discovered ? '  discovered' : ''}`)
    }
  }
  return 0
}

/** `engine parse <file>`: prints what the format adapter found. */
export async function parseFile(argv: string[]): Promise<number> {
  const file = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--data' && argv[i - 1] !== '--seed')
  if (!file) {
    out('Usage: npm run engine -- parse <file>')
    return 2
  }
  const ir = await adapterFor(file).read(file)
  let blocks = 0
  let tokens = 0
  const rows: string[] = []
  for (const s of ir.sections) {
    const t = s.blocks.reduce((n, b) => n + countTokens(b.text), 0)
    blocks += s.blocks.length
    tokens += t
    rows.push(`  ${s.id.padEnd(5)} ${String(s.blocks.length).padStart(5)} blocks ${String(t).padStart(7)} tokens  ${s.title ?? '(untitled)'}`)
  }
  out(`file: ${file}`)
  out(`format: ${ir.format}`)
  if (ir.meta.title) out(`title: ${ir.meta.title}`)
  if (ir.meta.language) out(`language: ${ir.meta.language}`)
  out(`sections: ${ir.sections.length}, blocks: ${blocks}, tokens: ${tokens}`)
  for (const r of rows) out(r)
  return 0
}

const VALUE_FLAGS = ['data', 'seed', 'to', 'from', 'model', 'glossary-model', 'proofread-model', 'qa-model', 'max-chunk', 'project', 'out']

/** The first argument that is neither a flag nor a flag's value. */
function positional(argv: string[]): string | undefined {
  return argv.find((a, i) => !a.startsWith('-') && !(i > 0 && argv[i - 1]!.startsWith('--') && VALUE_FLAGS.includes(argv[i - 1]!.slice(2))))
}

const modelList = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)

function fmtDuration(sec: number | null): string {
  if (sec === null) return '?'
  if (sec < 90) return `${sec}s`
  return sec < 5400 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`
}

/** `engine translate <file> --to <lang> ...`: creates or resumes a project, runs the pipeline, exports. */
export async function translate(argv: string[]): Promise<number> {
  const file = positional(argv)
  const to = argValue(argv, 'to')
  if (!file || !to) {
    out('Usage: npm run engine -- translate <file> --to <language> [--from <language>] [--model <provider/model>[,fallback]] [--glossary-model ..] [--proofread-model ..] [--qa-model ..]')
    out('                                         [--no-proofread] [--no-qa] [--no-glossary] [--max-chunk N] [--project <id>] [--pause-after-glossary]')
    return 2
  }
  const { registry, dataDir } = await loadRegistry(argv)
  for (const d of await registry.discover()) if (d.error) out(`note: ${d.provider} discovery failed (${d.error})`)

  scriptDevMock(registry.mock)

  let lastLine = ''
  const tty = process.stdout.isTTY
  const service = new EngineService({
    dataDir,
    registry,
    emit: (ev) => {
      if (ev.type === 'log') process.stderr.write(`${tty && lastLine ? '\n' : ''}[${ev.level}] ${ev.message}\n`)
      else if (ev.type === 'progress') {
        const stages = Object.entries(ev.perStage).filter(([s, n]) => n > 0 && !['pending', 'done'].includes(s)).map(([s, n]) => `${s} ${n}`)
        const line = `[${ev.done}/${ev.total}] ${stages.join(', ') || 'idle'} | ${ev.tokensIn}/${ev.tokensOut} tok | $${ev.costUsd.toFixed(4)} | eta ${fmtDuration(ev.etaSec)}`
        if (line === lastLine) return
        lastLine = line
        process.stdout.write(tty ? `\r${line.padEnd(100)}` : line + '\n')
      }
    }
  })

  const model = modelList(argValue(argv, 'model'))
  const agentModels: Partial<Record<AgentName, string[]>> = {}
  if (model) for (const a of AGENTS) agentModels[a] = model
  for (const [flag, agent] of [['glossary-model', 'glossary'], ['proofread-model', 'proofreader'], ['qa-model', 'qa']] as const) {
    const v = modelList(argValue(argv, flag))
    if (v) agentModels[agent] = v
  }
  const maxChunk = argValue(argv, 'max-chunk')
  const settings: Partial<ProjectSettings> = {
    agentModels: agentModels as Record<AgentName, string[]>,
    enabled: { glossary: !argv.includes('--no-glossary'), proofreader: !argv.includes('--no-proofread'), qa: !argv.includes('--no-qa') },
    ...(maxChunk ? { maxChunkTokens: Number(maxChunk) } : {}),
    ...(argv.includes('--pause-after-glossary') ? { pauseAfterGlossary: true } : {})
  }
  const projectId = argValue(argv, 'project')
  const summary = await service.createProject({ sourcePath: file, targetLanguage: to, sourceLanguage: argValue(argv, 'from'), settings, id: projectId })
  out(`project ${summary.id} (${summary.format}, ${summary.chunks > 0 ? summary.chunks + ' chunks, resuming' : 'new'})`)
  const est = await service.analyze(summary.id)
  out(`estimate: ${est.chunks} chunks of up to ${est.budget} tokens, ${est.sourceTokens} source tokens, ~${est.estTokensIn}/${est.estTokensOut} tokens in/out, ~$${est.estCostUsd.toFixed(3)}, ~${fmtDuration(est.estSeconds)}`)

  process.once('SIGINT', () => {
    process.stderr.write('\ninterrupted: stopping, run the same command to resume\n')
    void service.pause(summary.id)
  })
  const result = await service.start(summary.id)
  if (tty) process.stdout.write('\n')
  const c = result.counts
  out(`status: ${result.status} (done ${c.done}, flagged ${c.flagged}, failed ${c.failed}, pending ${c.pending}); spend $${result.spend.costUsd.toFixed(4)}, ${result.spend.tokensIn}/${result.spend.tokensOut} tokens`)
  if (result.status === 'paused' || result.status === 'cancelled') return 130
  if (result.status === 'glossary-review') {
    out(`glossary written to ${service.store.file(summary.id, 'glossary.md')}. Edit it, then run the same command to continue.`)
    return 0
  }
  const outPath = await service.export(summary.id, argValue(argv, 'out'))
  out(`output: ${outPath}`)
  return result.status === 'done' ? 0 : 1
}

async function serviceFor(argv: string[]): Promise<{ service: EngineService; id: string } | undefined> {
  const id = positional(argv)
  if (!id) return undefined
  const { registry, dataDir } = await loadRegistry(argv)
  return { service: new EngineService({ dataDir, registry }), id }
}

/** `engine export <projectId> [--out <file>]`: writes the document from the chunks translated so far. */
export async function exportProject(argv: string[]): Promise<number> {
  const s = await serviceFor(argv)
  if (!s) {
    out('Usage: npm run engine -- export <projectId> [--out <file>]')
    return 2
  }
  out(`output: ${await s.service.export(s.id, argValue(argv, 'out'))}`)
  return 0
}

/** `engine status <projectId>`: chunk states, spend and flagged chunks. */
export async function projectStatus(argv: string[]): Promise<number> {
  const s = await serviceFor(argv)
  if (!s) {
    out('Usage: npm run engine -- status <projectId>')
    return 2
  }
  const p = await s.service.getProject(s.id)
  const chunks = await s.service.store.listChunks(s.id)
  const counts = countStates(chunks)
  out(`${p.name} [${p.id}] ${p.format} -> ${p.settings.targetLanguage}: ${p.status}`)
  out(`chunks: ${chunks.length} (${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'})`)
  out(`spend: $${p.spend.costUsd.toFixed(4)}, ${p.spend.tokensIn} tokens in, ${p.spend.tokensOut} out`)
  for (const c of chunks) {
    if (c.state === 'failed') out(`  chunk ${c.index} failed: ${c.error}`)
    for (const i of c.qa.issues.filter((x) => x.severity === 'major')) out(`  chunk ${c.index} ${i.segId} ${i.type}: ${i.comment}`)
  }
  return 0
}

/** `engine key-set NAME`: stores an API key in the Windows credential store. */
export async function keySet(argv: string[]): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'))
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    out('Usage: npm run key:set <ENV_NAME>   for example: npm run key:set DEEPSEEK_API_KEY')
    return 2
  }
  if (resolveKey(name) && process.env[name]) out(`Note: ${name} is also set in the environment, which takes priority.`)
  const value = await promptHidden(`Key for ${name} (input is hidden): `)
  if (!value) {
    out('No key entered, nothing stored.')
    return 1
  }
  setStoredKey(name, value)
  out(`Stored ${name} in the Windows credential store (service "${KEYRING_SERVICE}").`)
  return 0
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    if (!stdin.isTTY) {
      let data = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (c) => (data += c))
      stdin.on('end', () => resolve(data.trim()))
      return
    }
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          return resolve(value.trim())
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}
