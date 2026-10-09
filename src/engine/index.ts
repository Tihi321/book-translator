import { exportProject, keySet, listModels, parseFile, projectStatus, translate } from './cli'
import { serve } from './serve'

const USAGE = `Book Translator engine

Usage:
  npm run engine -- models [--data <dir>]        List configured and discovered models
  npm run engine -- parse <file> [--data <dir>]  Read a document and print its structure
  npm run engine -- translate <file> --to <language> [--from <language>] [--model <provider/model>[,fallback]]
        [--glossary-model <ref>] [--proofread-model <ref>] [--qa-model <ref>] [--no-glossary] [--no-proofread] [--no-qa]
        [--max-chunk <tokens>] [--project <id>] [--pause-after-glossary] [--out <file>]
                                                 Translate a document (creates the project or resumes it) and export it
  npm run engine -- export <projectId> [--out <file>]   Write the document from the chunks translated so far
  npm run engine -- status <projectId>           Show chunk states, spend and flagged chunks
  node out/engine/index.js serve [--data <dir>]  Run as the app's engine process (Electron utilityProcess or a Node child with IPC)
  npm run key:set <ENV_NAME>                     Store an API key in the Windows credential store (hidden prompt or stdin)

  --data <dir>   Data folder. Default: BOOK_TRANSLATOR_DATA, else %USERPROFILE%\\BookTranslator
  --seed <dir>   Seed folder to copy from. Default: the repo's seed/ (or BOOK_TRANSLATOR_SEED)
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (cmd === 'models') process.exitCode = await listModels(rest)
  else if (cmd === 'parse') process.exitCode = await parseFile(rest)
  else if (cmd === 'translate') process.exitCode = await translate(rest)
  else if (cmd === 'export') process.exitCode = await exportProject(rest)
  else if (cmd === 'status') process.exitCode = await projectStatus(rest)
  else if (cmd === 'serve') await serve(rest)
  else if (cmd === 'key-set') process.exitCode = await keySet(rest)
  else {
    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`)
    process.exitCode = 2
  }
}

// Errors print a short message and set the exit code. process.exit() is avoided: with sockets still closing it can abort Node on Windows.
main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  if (process.env.BOOK_TRANSLATOR_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
  process.exitCode = 1
})
