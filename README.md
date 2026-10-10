# Book Translator

A Windows desktop app that translates a book or document into another language with local models (LM Studio, Strata, Ollama, any OpenAI-compatible server) or API models (DeepSeek, Anthropic, Gemini, OpenAI, OpenRouter ...) and writes the translation back in the same format.

Books are larger than any model's context, so the text is split into chunks that fit the chosen models. A small pipeline of agents keeps quality and consistency up:

1. **Glossary builder** reads the whole book once and writes a term table (names, places, terms, gender of characters) and a book brief (genre, tone, register, narrator, form of address).
2. **Translator** translates chunk by chunk with the glossary terms that occur in the chunk and the tail of the previous chunk.
3. **Proofreader** (optional) polishes the target-language text.
4. **QA reviewer** (optional) compares source and result, finds omissions, additions and mistranslations, and triggers one fix pass for serious ones. Cheap deterministic checks (length ratio, untranslated text, glossary terms, inline tags) run first.

## Features

- Formats: EPUB, DOCX, TXT, Markdown, PDF (text layer). The output has the same format, except PDF, which becomes EPUB (and Markdown).
- Inline formatting (bold, italic, links, footnote marks, images) survives: it is carried through the model as numbered tags and restored.
- Per-agent model choice, with a fallback list per agent (for example local first, API as fallback). Models are grouped Local / API with context size and price.
- Estimate before you start: chunks, tokens, cost, rough time.
- Progress view with a tile per chunk, live model output, tokens, cost, ETA. Pause, resume and cancel at any time. Everything is written per chunk, so closing the app or a crash resumes where it stopped.
- Review: source and translation side by side per chunk, QA flags, edit text, retranslate a chunk with another model, accept flags. An editable glossary that applies to the chunks that follow.
- Export works with partial progress (untranslated parts keep the source text), for previewing.
- Headless CLI for scripting and tests.

## Setup

Node 24 (the project uses [fnm](https://github.com/Schniz/fnm); in PowerShell run `fnm env --use-on-cd | Out-String | Invoke-Expression` first).

```powershell
npm install
npm run dev        # builds the engine and starts the app with hot reload
```

Other scripts: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run dist` (NSIS installer in `dist/`), `npm run dist:dir` (unpacked app in `dist/win-unpacked/`).

## Providers and API keys

Providers and their models are listed in `config/providers.md` in the data folder (YAML frontmatter, see the notes in the file). The Settings screen edits enabled / base URL / parallel requests. Prices in the file are examples: check them on the providers' pricing pages. The OpenAI, OpenRouter, Anthropic and Gemini entries are marked "to verify".

API keys are never written to files. A key is looked up in an environment variable named in `api_key_env` (for example `DEEPSEEK_API_KEY`), then in the Windows Credential Manager (service `book-translator`). Set one of these ways:

- Settings screen: type the key and press Save key (it goes to the credential store and is never shown again).
- `npm run key:set DEEPSEEK_API_KEY` (hidden prompt, or pipe the key on stdin).
- An environment variable.

## LM Studio notes

- Start the LM Studio server (default `http://localhost:1234/v1`). The app discovers the models and reads the context each one is **loaded** with. Press *Refresh local models* after loading or unloading.
- LM Studio loads models with a small context (4096 or 8192) by default, which forces tiny chunks. Load the model you translate with **at least 32k**: `lms load <model> -c 32768 --parallel 1`.
- Thinking models are slow and waste tokens on translation. Switch thinking off with `extra_body: { reasoning_effort: none }` on the model in `providers.md` (models that support it).
- Quality varies a lot with the model: a 4B model (`nvidia/nemotron-3-nano-4b`) gave poor Croatian, while Qwen 35B (`qwen3.6-35b-a3b`) gave good Croatian. For gendered languages use the biggest model you can run, and keep the glossary builder on.
- Local servers handle one request at a time, so concurrency is 1. API providers default to 4-8 chapters in parallel.

## Strata notes

- Strata is a local Qwen3.8-Flash-Next server on `http://127.0.0.1:8080/v1`. It needs no key.
- Start it with `D:\Strata\run-iq3_s.bat`. Check `curl http://127.0.0.1:8080/health`. It is ready when it shows `loaded: true`. Loading takes 1 to 3 minutes.
- The default models use Strata first and fall back to DeepSeek (QA falls back to Gemini last). If Strata is not running, the app moves on to the next model.
- The IQ3_S quant needs about 84 GB of memory. Keep only small models loaded in LM Studio while Strata runs.
- Strata is set up with `json_schema: false` in `providers.md`, so glossary and QA JSON comes from the prompt and the app's repair step. See the Strata section in `providers.md`.

## CLI

The engine also runs headless: `npm run engine -- <command>`.

```text
models [--data <dir>]                       list configured and discovered models
parse <file>                                read a document and print its structure
translate <file> --to <language> [--from <language>] [--model <provider/model>[,fallback]]
          [--glossary-model <ref>] [--proofread-model <ref>] [--qa-model <ref>]
          [--no-glossary] [--no-proofread] [--no-qa] [--max-chunk <tokens>]
          [--project <id>] [--pause-after-glossary] [--out <file>]
export <projectId> [--out <file>]           write the document from what is translated so far
status <projectId>                          chunk states, spend, failed chunks and major QA issues
key-set <ENV_NAME>                          store an API key (npm run key:set <ENV_NAME>)
```

`--to` takes a language name or code (`Croatian`, `hr`). The same file and language always give the same project, so running `translate` again resumes it (Ctrl+C stops cleanly). `--data <dir>` (or `BOOK_TRANSLATOR_DATA`) selects the data folder. Errors print one line and exit with code 1.

Example: `npm run engine -- translate book.epub --to hr --model lmstudio/qwen3.6-35b-a3b --qa-model deepseek/deepseek-v4-flash`

With no `--model` flags the defaults from `config/defaults.json` apply (Strata first, then DeepSeek).

## Data folder

`%USERPROFILE%\BookTranslator` (override with `--data` or `BOOK_TRANSLATOR_DATA`), created from `seed/` on first run. Existing files are never overwritten.

```text
config/providers.md     providers and models
config/defaults.json    default model per agent, default chunk size, language list
prompts/<agent>.md      prompt templates ({{variables}}), _rules.md is shared by all agents
projects/<id>/
  project.json          source, languages, models per agent, status, spend
  source.json           the parsed document
  brief.md, glossary.md book brief and term table (editable)
  chunks/0001.json      source, translation, proofread text, QA issues, state per chunk
  output/               exported documents
  log.md
```

## Editing prompts

The agents' instructions are the Markdown files in `prompts/`. Edit them in any editor (Settings has a button that opens the folder). Changes apply to the next chunk. Keep the variables (`{{targetLanguage}}`, `{{brief}}` ...) and the output format described in each file (`<seg id="..">` segments, JSON for QA and glossary).

## Formats and limitations

- **EPUB**: the original XHTML is edited in place; CSS, images, fonts and everything else are copied unchanged. Titles, navigation (nav.xhtml / toc.ncx) and the language tag are updated, and right-to-left languages get `dir="rtl"`.
- **DOCX**: paragraphs in the body, footnotes, endnotes, headers and footers are translated. Formatting runs that differ inside a paragraph become tags. Text boxes, SmartArt, comments and tracked changes are not specially handled and may be missed or flattened.
- **TXT / Markdown**: blocks are blank-line separated paragraphs; Markdown syntax is kept as is (code fences are left alone).
- **PDF**: only the text is extracted (reading order, paragraphs, headings by font size, running headers and page numbers dropped). The layout, images and tables are not preserved: the result is a new EPUB or Markdown. There is no OCR: a scanned PDF without a text layer is rejected with an error.
- A chunk whose model reply loses inline tags is written as plain text and flagged. A chunk that keeps failing is marked failed: retry it or edit it by hand.
- Output has not been checked in every reader (Calibre, Thorium, Word) on real-world books: check an export before relying on it.
- Token counts are approximate for non-OpenAI models (a safety margin covers it). Cost and time estimates are rough.

## Tests

`npm test` runs the Vitest suite: chunker, segment parser, inline-tag round trips, every format adapter on generated fixtures, the pipeline end to end with a scripted mock provider (resume, retry, QA fix pass, partial export), the command dispatcher and the renderer store. No network or real model is needed. Checks against real models are done by hand with the CLI.
