# Book Translator

A Windows desktop app that translates a book or document into another language with local models (LM Studio, Strata, Ollama, any OpenAI-compatible server) or API models (DeepSeek, Anthropic, Gemini, OpenAI, OpenRouter ...) and writes the translation back in the same format.

Books are larger than any model's context, so the text is split into chunks that fit the chosen models. A small pipeline of agents keeps quality and consistency up:

1. **Glossary builder** reads the whole book once and writes a term table (names, places, terms, gender of characters) and a book brief (genre, tone, register, narrator, form of address).
2. **Translator** translates chunk by chunk with the glossary terms that occur in the chunk and the tail of the previous chunk.
3. **Proofreader** (optional) polishes the target-language text.
4. **QA reviewer** (optional) compares source and result, finds omissions, additions and mistranslations, and triggers one fix pass for serious ones. Cheap deterministic checks (length ratio, untranslated text, glossary terms, inline tags) run first.

## Features

- Formats: EPUB, DOCX, TXT, Markdown, PDF (text layer). The output has the same format, except PDF, which becomes EPUB (and Markdown). Also Scriptorium visual-novel book folders, written back as a folder with the same script lines (see [Visual-novel book folders](#visual-novel-book-folders)).
- Inline formatting (bold, italic, links, footnote marks, images) survives: it is carried through the model as numbered tags and restored.
- Per-agent model choice, with a fallback list per agent (for example local first, API as fallback). Models are grouped Local / API with context size and price.
- Estimate before you start: chunks, tokens, cost, rough time.
- Progress view with a tile per chunk, live model output, tokens, cost, ETA. Pause, resume and cancel at any time. Everything is written per chunk, so closing the app or a crash resumes where it stopped.
- Review: source and translation side by side per chunk, QA flags, edit text, retranslate a chunk with another model, accept flags. An editable glossary that applies to the chunks that follow.
- Export works with partial progress (untranslated parts keep the source text), for previewing.
- Headless CLI for scripting and tests.
- An MCP server, so another LLM (Claude Code ...) can drive the app or translate with it, with or without a window.

## Setup

Node 24 (the project uses [fnm](https://github.com/Schniz/fnm); in PowerShell run `fnm env --use-on-cd | Out-String | Invoke-Expression` first).

```powershell
npm install
npm run dev        # builds the engine and starts the app with hot reload
```

Other scripts: `npm run build`, `npm run headless`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run dist` (NSIS installer in `dist/`), `npm run dist:dir` (unpacked app in `dist/win-unpacked/`).

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
parse <file|folder>                         read a document (or a visual-novel book folder) and print its structure
translate <file|folder> --to <language> [--from <language>] [--model <provider/model>[,fallback]]
          [--glossary-model <ref>] [--proofread-model <ref>] [--qa-model <ref>]
          [--no-glossary] [--no-proofread] [--no-qa] [--max-chunk <tokens>]
          [--project <id>] [--pause-after-glossary] [--out <file>]
export <projectId> [--out <file>]           write the document from what is translated so far
status <projectId>                          chunk states, spend, failed chunks and major QA issues
key-set <ENV_NAME>                          store an API key (npm run key:set <ENV_NAME>)
headless [--data <dir>] [--port <n>]        run with no window and the MCP server on (npm run headless)
```

`--to` takes a language name or code (`Croatian`, `hr`). The same file and language always give the same project, so running `translate` again resumes it (Ctrl+C stops cleanly). `--data <dir>` (or `BOOK_TRANSLATOR_DATA`) selects the data folder. Errors print one line and exit with code 1.

Example: `npm run engine -- translate book.epub --to hr --model lmstudio/qwen3.6-35b-a3b --qa-model deepseek/deepseek-flash`

With no `--model` flags the defaults from `config/defaults.json` apply (Strata first, then DeepSeek).

## MCP (use it from another LLM)

The app can act as an MCP server, so an outside LLM client (Claude Code, Claude Desktop, Cursor, Codex ...) can work with your books. It runs inside the app's engine, so projects and progress that the client starts show up live in the window.

Turn it on in Settings, card "MCP server": tick Enable, set the port (default 47811) and press Save. The card shows the URL (`http://127.0.0.1:47811/mcp`), the token and two ready snippets with Copy buttons. The same works [headless](#headless).

Claude Code:

```powershell
claude mcp add --transport http book-translator http://127.0.0.1:47811/mcp --header "Authorization: Bearer <token>"
```

Clients with a JSON config (url + headers):

```json
{ "mcpServers": { "book-translator": { "type": "http", "url": "http://127.0.0.1:47811/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

Two ways to work:

- **Operator.** The client drives the app's own pipeline: analyze a file, create a project, pick models, start, pause, resume, watch progress, review flagged chunks, fix text, export. The app's models (Strata, DeepSeek ...) do the translating.
- **Answering the app's models (full pipeline).** Set an agent's model to `client/claude-code` (see [the client provider](#the-client-provider-claude-code-does-the-model-work)) and the app's own pipeline runs, but each model call waits for the client: glossary, translator, proofreader and QA review and fix are all answered by the client, one request at a time, through `get_client_task` and `submit_client_task`.
- **Translator.** The client translates the book itself, the first pass only. `prepare_chunks` makes the chunks, `get_translation_task` returns the same prompt the app's translator would get (rules, brief, glossary terms, the previous passage, `<seg>` segments), and `submit_translation` checks segment ids and inline tags and stores the text. Nothing is spent on the app's models. The glossary builder, the proofreader and QA are not run by this path: they need a model, so use the full pipeline above (agents on `client/claude-code`) when you want them. The `translate_book_yourself` prompt gives the client the steps.

Tools:

- Info: `get_info`, `list_models`, `get_defaults`, `list_languages`
- Projects: `list_projects`, `analyze_file`, `create_project`, `get_project`, `update_project_settings`
- Running: `start_translation`, `pause_translation`, `cancel_translation`, `wait_for_progress`
- Review: `get_chunk`, `edit_chunk`, `retry_chunk`, `update_glossary`, `set_brief`, `export_project`
- Translator role: `prepare_chunks`, `get_translation_task`, `submit_translation`
- Client provider: `list_client_tasks`, `get_client_task`, `submit_client_task`, `release_client_task`
- Prompts: `translate_book_yourself`, `translate_with_full_pipeline`

Safety:

- The server listens on 127.0.0.1 only and checks the Host and Origin headers.
- Every request needs the bearer token. It is made on first use and kept in the Windows credential store (`BOOK_TRANSLATOR_MCP_TOKEN`; an environment variable with that name takes priority).
- API keys, provider settings and project deletion are not available over MCP.
- One engine uses a data folder at a time (`engine.lock` in the folder). A second app or `headless` on the same folder is refused with a message. If no Book Translator is running and the message stays, delete `engine.lock`.

### The client provider: Claude Code does the model work

The `client` provider (model `client/claude-code`) turns the app's model calls into tasks for an MCP client. Nothing is spent on models.

1. Add the provider once. A new data folder has it disabled in `config/providers.md`; an existing folder needs the entry added by hand (see `seed/config/providers.md`: `id: client`, `kind: client`, `local: true`, `concurrency: 8`, model `claude-code`) and `enabled: true`, then restart the app.
2. Choose which agents it answers with `update_project_settings`, for example `agentModels: { translator: ["client/claude-code"], glossary: ["client/claude-code"], proofreader: ["client/claude-code"], qa: ["client/claude-code"] }`. An agent left on another model keeps using that model.
3. `start_translation`, then loop: `wait_for_progress` (returns at once when a task waits, with `clientTasks: { waiting, leased }`), `get_client_task` (leases the oldest waiting task for 30 minutes; filter by `role`, `project`, `task`), write the answer as `output` says, `submit_client_task`. A JSON answer (glossary, QA) is checked against the task's schema when you submit: if it fails you get `problems` and the task stays leased. A task whose lease runs out goes back to the queue; `release_client_task` gives one back. Several clients or subagents can each take a task.
4. When `get_project` shows `clientTasks` at 0 and the status is `done`, `export_project`. Put the agents back on real models afterwards: an agent left on `client` waits for ever when no client is connected.

The entry for `config/providers.md` (before `mock`):

```yaml
  - id: client
    kind: client
    local: true
    concurrency: 8
    models:
      - id: claude-code
        family: claude
        vision: true
```

The `translate` command of the CLI refuses a project with an agent on `client`, since the CLI has nobody to answer. A request is dropped when the project is paused or cancelled or the app restarts (a later `submit_client_task` for it says the task is gone). The run asks again when it is started again.

## Headless

`"Book Translator.exe" --headless` starts the app with no window and with MCP on (it overrides the Settings switch for that run). The packaged exe prints nothing to a terminal on Windows, so get the token from Settings: start Book Translator normally. The window opens on the running instance and shows the URL and token. Closing that window does not stop the app. To stop it, end the process.

From a terminal, `npm run headless -- [--data <dir>] [--port <n>]` prints the URL and token and logs events. Ctrl+C pauses the running projects and stops. It uses the same data folder as the app, so close the app first.

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
- **Visual-novel book folder**: see below. Pick the folder with the CLI or MCP; the app's New project screen picks files only, and the built-in reader does not open folders.
- A chunk whose model reply loses inline tags is written as plain text and flagged. A chunk that keeps failing is marked failed: retry it or edit it by hand.
- Output has not been checked in every reader (Calibre, Thorium, Word) on real-world books: check an export before relying on it.
- Token counts are approximate for non-OpenAI models (a safety margin covers it). Cost and time estimates are rough.

## Visual-novel book folders

A Scriptorium visual novel is a folder (`book.md`, `outline.md`, `chapters/ch-01.md` ..., `bible/bible.md`, `cover-brief.md`) whose chapters are scripts read line by line (`SCENE:`, `ON SCREEN:`, `NAME (expression): words`, narration; grammar in Scriptorium's `docs/visual-novel.md`). VN Studio reads a translated copy of the folder as an edition and pairs it with the original beat by beat, so the translation has to keep every line, in order, with its markers.

Give the folder instead of a file: `npm run engine -- translate <book folder> --to hr`, or `create_project` / `analyze_file` over MCP with the folder as `sourcePath`. The folder is one project (format `vn`). Export writes a folder `<folder name>.<lang>` with the same layout, which VN Studio takes with `vno_add_edition {slug, source: <that folder>, lang}`.

What is translated and what stays:

| Part | Translated | Kept as it is |
| --- | --- | --- |
| `book.md` | `title`, `blurb` | every other key, the body (editor notes) |
| `outline.md` | `chapters[].title`, `summary`, `ending`, `choices[].text`, the body line by line | `n`, `to` and every other key, list markers |
| `chapters/*.md` | `title`; narration; the words of spoken lines; the place and time after `SCENE:`; `#` headings | the other keys, `SCENE:`, `ON SCREEN:` lines (names and looks), speaker tags with their expression, `Narration:`, `---`, stage directions (`FADE OUT.`), blank lines |
| `bible/bible.md`, `cover-brief.md` | nothing | copied |

- One segment per line, so a translated chapter has the same lines in the same order. Line endings and frontmatter formatting are kept; a translated YAML value is quoted only when it has to be.
- A spoken line goes to the translator as `<1>PETRA (grumpy):</1> Pip, shhh!`, so it knows who speaks (voice and grammatical gender). The tag is checked like any inline tag and dropped again on export; the source tag is written back.
- Character names stay: they are the speaker tags and the bible names VN Studio matches. The project starts with a glossary entry per bible character that keeps the name (the glossary builder does not replace entries that are already there), and every agent is told the script rules with the book brief.
- The bible and the cover brief are the art reference for the pictures: VN Studio reuses the original's pictures in an edition, and image models are prompted in English, so they are copied, not translated.
- A translated line that would read as another kind of line (narration that now looks like `NAME: ...` or a heading), or that comes back empty, keeps the source line, with a warning in the project log.

## Tests

`npm test` runs the Vitest suite: chunker, segment parser, inline-tag round trips, every format adapter on generated fixtures (and the visual-novel folder adapter on the `tests/fixtures/books/soother` book), the pipeline end to end with a scripted mock provider (resume, retry, QA fix pass, partial export), the command dispatcher and the renderer store. No network or real model is needed. Checks against real models are done by hand with the CLI.
