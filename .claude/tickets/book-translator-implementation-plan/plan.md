# Book Translator — implementation plan

## Context

`C:\projects\Personal\book-translator` is an empty repo (only `README.md`). The goal is a Windows desktop app that takes a book or document (EPUB, DOCX, TXT/Markdown, PDF), translates it into another language with local models (LM Studio / Ollama / any OpenAI-compatible server) or API models (Anthropic, Gemini, DeepSeek, OpenRouter, OpenAI…), and writes the translated document back in the same format. Books are larger than any model's context, so the text is split into chunks sized to the selected model. A small pipeline of agents (glossary builder → translator → proofreader → QA reviewer) keeps quality and consistency up. The UI is for picking models/languages, watching progress, reviewing chunks and exporting. No scriptorium-style agent office.

User decisions: **Electron desktop app (same stack as scriptorium)**, **all four formats**, **all four agents**.

Plan file: `.claude/tickets/book-translator-implementation-plan/plan.md`. Branch: `book-translator-mvp` (from `origin/master`).

## Stack (mirrors scriptorium)

TypeScript 5.9, Electron 44 + electron-vite, React 19 + Zustand, Vitest, npm. Node 24 via fnm (`fnm env --use-on-cd | Out-String | Invoke-Expression` first — see `scriptorium/CLAUDE.md`).
Deps: `jszip`, `@xmldom/xmldom` (EPUB XHTML + DOCX XML, XML-correct round trip), `pdfjs-dist` (legacy Node build, text extraction), `gpt-tokenizer` (token estimates — better than chars/4 for Cyrillic/CJK/diacritics), `zod`, `yaml`, `@napi-rs/keyring`.

Process split as in scriptorium: `src/engine/` (runs as Electron `utilityProcess`, also headless via `npm run engine -- translate <file> ...` for testing), `src/main/`, `src/preload/`, `src/renderer/`, `src/shared/`.

## Reuse from scriptorium (`C:\projects\Personal\scriptorium\`)

Copy and trim; keep the code style:
- `src/engine/models/*` — `ProviderClient`, `OpenAiCompatClient` (+ `listModels`, `contextLengths` for LM Studio loaded context), `AnthropicClient`, `GeminiClient`, `MockProvider`, `parseSse`, `ProviderLimiter`, `keys.ts` (`resolveKey`: env var then Windows Credential Manager, service renamed `book-translator`).
- `registry.ts` — keep `providers.md` YAML-frontmatter format, `discover()`, `computeCost`. Drop `roles.md` (replaced by per-project agent→model map).
- `router.ts` — keep retry/backoff/fallback/limiter; replace `Budget` with a simple per-project spend counter (`estimateCost` logic inline).
- `src/engine/pipeline/llm.ts` (`chatJson`, `stripThinking`, `extractJson`) and `prompts.ts` (`render`, `buildMessages`) — decouple from scriptorium's `JobContext` (take a `chat` function instead).
- `src/shared/md.ts`, `src/engine/store/atomic.ts` (`atomicWrite`, `writeMd`), `src/engine/store/dataFolder.ts` pattern (seed folder copied on first run).
- `src/engine/transport.ts`, `src/main/engineClient.ts`, `src/shared/protocol.ts` pattern (typed `EngineEvent` / `Command` unions).
- `src/engine/publish/epub.ts` + `xhtml.ts` — only for building a *new* EPUB from PDF/TXT sources (strip ornament/art code).
- `seed/config/providers.md` — copy (remove search providers), add an `openai` entry and a disabled `ollama` / `custom` OpenAI-compat entry.
- `styles.css` dark-theme CSS variables approach; plain `<select>` model pickers like `AgentPanel.tsx`.

## Data layout

Data folder `%USERPROFILE%\BookTranslator` (override `--data` / `BOOK_TRANSLATOR_DATA`), seeded from `seed/`:
```
config/providers.md        providers + models (UI edits it; keys never stored here)
config/defaults.json       default model per agent, default chunk size, languages
prompts/<agent>.md         editable prompt templates ({{var}}), _rules.md shared
projects/<id>/
  project.json             source path, format, src/tgt language, agent→model map, enabled agents, chunk settings, status, spend
  source.json              extracted Document IR (see below)
  brief.md                 book brief from glossary builder (genre, tone, register, POV, character genders)
  glossary.md              term table (editable in UI before/while translating)
  chunks/0001.json         {blockIds, source, translation, proofread, final, qa:{issues}, state, model, tokens, ms}
  output/<name>.<lang>.<ext>
  log.md
```
Every chunk write is atomic → a crash/close resumes where it stopped (chunks in `done` are skipped).

## Document IR and format adapters (`src/engine/formats/`)

```ts
interface Block { id: string; kind: 'heading'|'para'|'item'|'caption'|'cell'|'toc'|'meta'; text: string /* with inline placeholders */; tags: InlineTag[] }
interface Section { id: string; title?: string; blocks: Block[] }
interface DocumentIR { format: 'epub'|'docx'|'txt'|'md'|'pdf'; meta: {title?, language?}; sections: Section[] }
interface FormatAdapter { read(path): Promise<DocumentIR>; write(ir, translations: Map<blockId,string>, srcPath, outPath): Promise<void> }
```
Inline formatting is turned into numbered placeholder tags `<1>…</1>`, `<2/>` (map kept in `tags`); the model must return the same tags. Validation: same tag set → restore; mismatch after one retry → write plain text, flag the chunk.

- **EPUB** (`epub.ts`): JSZip open → OPF spine order → each XHTML parsed with xmldom; translatable blocks = `p, h1–h6, li, blockquote, dt, dd, td, th, figcaption, caption` and `div`s with only inline children; also `nav.xhtml` / `toc.ncx` labels, `<title>`, OPF `dc:title`. Writer edits the **original** DOM in place (replace block contents), sets `dc:language` + `xml:lang`/`lang`, `dir="rtl"` for RTL targets, re-zips with `mimetype` stored first. CSS, images, fonts untouched.
- **DOCX** (`docx.ts`): `word/document.xml` (+ `footnotes.xml`, `endnotes.xml`, headers/footers) → each `w:p` is a block; adjacent runs with identical `w:rPr` merged; differing runs become placeholder tags. Writer rebuilds runs from tags, keeps `w:pPr`, drops proofing/`w:lang` hints or sets them to target.
- **TXT / MD** (`text.ts`): blocks = blank-line-separated paragraphs; MD syntax is kept verbatim and the prompt says "keep Markdown syntax". Output same format.
- **PDF** (`pdf.ts`): pdfjs `getTextContent` per page → lines by y-position → paragraphs by line gap/indent, join hyphenated line breaks, drop repeated header/footer lines and page numbers, headings by font size. No text layer → clear error ("scanned PDF, OCR not supported"). Output: EPUB (via reused `epub.ts`) + Markdown. Layout is not preserved; say so in the UI.

## Chunking (`src/engine/chunker.ts`)

- Budget per chunk (tokens) = `min(userMaxChunk, floor((ctx − promptOverhead − glossarySlice − prevContext − safety) / (1 + expansion)))`; `ctx` from LM Studio's loaded context (`contextLengths()`), else model `context` in providers.md, else 8192; `expansion` ≈ 1.3 (target text is often longer; output must fit too); 15% safety margin. Default `userMaxChunk` ≈ 1500 tokens (good quality/speed trade-off even for big-context models — long chunks make models skip text).
- Pack whole blocks greedily, never cross a section (chapter) boundary; a single over-budget block is split at sentence boundaries (`Intl.Segmenter`) and re-joined on write.
- Token counts via `gpt-tokenizer` (approximate for non-OpenAI models; the safety margin covers it).
- Chunk size is computed from the *smallest* context among the models selected for translator/proofreader/QA.

## Agents and pipeline (`src/engine/pipeline/`)

Segment protocol for translator/proofreader I/O: blocks are sent as `<seg id="12">text</seg>` and must come back the same way (more robust than JSON for small local models; no escaping). Parser checks every id is present exactly once; missing/extra → one retry with an error note → then split the chunk in half and retry → then mark `failed` (user can retry/edit).

1. **Glossary builder** (pre-pass, once per project): runs over the source in large chunks (cheap/fast model allowed), JSON output via `chatJson` + zod: `{terms:[{source, target, type: person|place|org|term|phrase, gender?, note}]}` and a book brief (genre, tone/register, narrator POV, formal/informal address, character genders — essential for gendered target languages like Croatian). Merges/dedupes across passes, writes `glossary.md` + `brief.md`. Optional "pause to review glossary" checkbox before translation starts.
2. **Translator** (per chunk): system = `_rules.md` + translator prompt + brief; user = glossary entries whose source term occurs in the chunk + tail of the previous chunk (last ~2 blocks, source and translation) + the segments. Temperature low (0.3).
3. **Proofreader** (per chunk, optional): target-language fluency/grammar/idiom pass with the source for reference; must keep segment ids, inline tags and glossary terms; told not to add or drop content.
4. **QA reviewer** (per chunk, optional): compares source vs final, JSON `{issues:[{segId, type: omission|addition|mistranslation|glossary|tags|untranslated, severity: minor|major, comment, suggestion}]}`. Any `major` → one **fix pass** (translator model, with the issues as feedback) for those segments only, then re-check once. Remaining issues are stored as flags shown in the UI. Cheap deterministic checks run first without an LLM: length ratio outliers, untranslated (source == target), glossary term missing, tag mismatch.

Scheduling: chapters run in parallel up to the translator provider's `concurrency` (LM Studio = 1, APIs 4–8); chunks within a chapter run sequentially so the previous-chunk tail is available. Stages per chunk: `pending → translating → proofreading → reviewing → (fixing) → done | flagged | failed`. Pause/resume/cancel via `AbortSignal`. Agent→model map per project, with the model's fallback list from the router (e.g. local first, API fallback).

## Engine ↔ UI protocol (`src/shared/protocol.ts`)

Commands: `listModels`, `refreshModels` (discover LM Studio/Ollama), `setSecret`, `saveProviders`, `openFile` (main dialog), `createProject`, `analyze` (parse + chunk + cost/time estimate), `start`, `pause`, `resume`, `cancel`, `retryChunk`, `editChunk`, `updateGlossary`, `export`, `deleteProject`.
Events: `snapshot`, `project.updated`, `chunk.state` (stage, model, tokens), `chunk.token` (live stream, throttled), `progress` ({done, total, perStage, tokensIn/Out, costUsd, etaSec}), `log`, `error`.

## UI (`src/renderer/`, React + Zustand, scriptorium dark theme)

- **Projects list**: recent projects with progress bar, "New translation" button.
- **New project**: drop/open file → shows detected format, title, source language (from metadata, editable), word/token count; target language select (common list + free text); per-agent model selects grouped Local / API with context size and price, checkbox to enable proofreader/QA, chunk size slider; **estimate panel** (chunks, total tokens, cost, rough time); Start.
- **Progress view**: overall bar + per-stage counts, tokens, cost, throughput, ETA; chapter rows with a tile per chunk coloured by state (click → detail); live "now translating Chapter 7, chunk 3/12 with qwen…" line with a collapsible token stream; Pause/Resume/Cancel; glossary tab (editable table, applies to later chunks).
- **Chunk detail**: source vs translation side by side per segment, QA flags highlighted, buttons: edit, retranslate (optionally with another model), accept flag.
- **Export**: writes `output/…` and opens folder. Allowed with partial progress (untranslated blocks keep source text) for previewing.
- **Settings**: providers (enable, base URL, concurrency), set API keys (credential store), refresh local models, default agent models, prompt files folder link.

## Build order (phases for the `implement` skill)

1. **Scaffold**: package.json/scripts/tsconfigs/electron-vite/vitest copied from scriptorium and trimmed; data folder + seed; models layer copied and decoupled from budget/roles; `npm run engine` CLI.
2. **Formats**: IR, TXT/MD, EPUB, DOCX, PDF adapters with round-trip tests (fixture files generated in tests: identity "translation" must reproduce equivalent docs).
3. **Chunker + segment protocol + translator agent** + project store/resume; headless CLI translates a TXT/EPUB end-to-end with LM Studio or mock.
4. **Glossary builder, proofreader, QA + fix pass**, deterministic checks, prompts in `seed/prompts/`.
5. **Electron shell + UI**: protocol, projects list, new-project wizard with model pickers and estimate, progress view, chunk detail, glossary editor, settings, export.
6. Polish: README with setup (LM Studio context size note from scriptorium's providers.md), `electron-builder` NSIS config.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test` (Vitest): chunker budgets (incl. oversize block split), segment parser (missing/extra/duplicate ids), inline-tag round trip, each adapter round-trip on fixtures, pipeline end-to-end with `MockProvider` (translation = prefixed text) covering resume after abort, QA major → fix pass, failed chunk handling.
- Headless: `npm run engine -- translate sample.epub --to hr --model lmstudio/<model>` against LM Studio, open the output EPUB in a reader (Calibre / Thorium) and check structure, images, TOC, language tag.
- Same with one API model (key via `npm run key:set`), and a DOCX + text PDF sample; open DOCX in Word.
- `npm run dev`: create a project in the UI, start, watch tiles/ETA update, pause + close app + reopen → resume continues, edit a chunk, export.


## Implementation checklist

- [x] Phase 1 Scaffold. Verified: `npm run typecheck`, `npm run lint`, `npm test` (6 files, 32 tests) pass; `npm run build` succeeds (engine + electron-vite main/preload/renderer stubs); `engine parse` on a sample .md and `engine models` (LM Studio reachable, 9 models discovered; unreachable case covered by a test) work. Deviations: `dist` script points at `electron-builder.yml` which does not exist yet (Phase 6); `dev:ui` script dropped; `chokidar` not used; seed has no `prompts/` yet (Phase 3/4 add `seed/prompts/*.md`, loaded by `buildMessages`); `defaultsSchema` added in `src/shared/schemas.ts` but there is no `loadDefaults` helper yet; `key-set` not exercised against the real credential store.
- [x] Phase 2 Formats. Verified: epub/docx/pdf adapter tests (identity round trip, tag restore, tag-mismatch fallback, DOCX runs/hyperlinks, PDF paragraphs/headers/hyphenation, scanned-PDF error) pass; orchestrator CLI smoke with mock: generated EPUB → hr and DOCX → de translated and exported. Additions to `ir.ts`: `Block.level?`, `WriteOptions { targetLanguage? }`, `FormatAdapter.outputExt?`, optional 5th `opts` arg on `write`. PDF output is EPUB (or .md via `writePdfMarkdown`). Not verified: opening outputs in Calibre/Thorium/Word, real-world books.
- [x] Phase 3 Chunker + translator + project store + CLI. Verified: `npm run typecheck`, `npm run lint`, `npm test` (14 files, 107 tests incl. Phase 2's) pass. Smoke: `engine translate sample.md --to Croatian --model mock/mock-translator` writes `output/sample.hr.md` (the CLI scripts `mock/...` models to echo segments with `[mock] `); with LM Studio `nvidia/nemotron-3-nano-4b` (poor Croatian, pipeline fine) and `nail-qwen3.6-35b-a3b-mtp` (good Croatian, md emphasis kept) a 3-paragraph md translated via the real path with `--no-glossary --no-qa --no-proofread`. New: `src/engine/{config,chunker,service}.ts`, `pipeline/{segments,env,translator,runner}.ts`, `project/{store,summary}.ts`, `src/shared/{project,protocol}.ts` (EngineEvent + Command unions), CLI `translate|export|status`. Deviations: chunks are made on first `start` (not at create) because the budget depends on the chosen models; project ids are `<name>-<lang>-<hash6>` so the same file and language resumes the same project; log.md is appended (not atomic); failed chunks are retried on the next run; the segment-mismatch split is one level deep (each half gets one retry); `export` calls `adapter.write(..., { targetLanguage })` through a local cast and uses `adapter.outputExt ?? source ext` (compiles whether or not the other agent has extended `FormatAdapter`); command handling/transport is left for Phase 5 (EngineService has the methods).
- [x] Phase 4 Glossary, proofreader, QA. Verified with the same checks (tests: chunker, segments, glossary md round trip, agents, pipeline e2e with MockProvider: glossary -> translate -> proofread -> QA -> export, pause/resume without re-requesting done chunks, mismatch -> retry -> split, failed chunk + retry, QA major -> fix pass -> re-check, flagged chunk, partial export, split-block rejoin). Prompts in `seed/prompts/{_rules,glossary,translator,proofreader,qa,fix}.md`. Deviations: glossary passes ignore section boundaries (one flat text); a glossary builder failure logs an error event and translation continues without it (`glossaryDone` stays false so the next run retries); the fix pass runs under the translator agent (role `translator`, task `fix`); `tags` issues from the translator count as major, so such a chunk ends `flagged` unless QA's fix restores the tags; glossary term misses are minor (inflection) and never trigger a fix pass. Not run: glossary/proofread/QA against a real model, API providers.
- [x] Phase 5 Electron shell + UI. Verified: `npm run typecheck`, `npm run lint`, `npm test` (16 files, 117 tests: new `tests/dispatcher.test.ts` with MockProvider + temp data folder covers createProject -> analyze -> start -> progress events -> export, chunk detail/edit/retry/delete, pause/resume, model list/saveProviders/setSecret (stubbed key store), defaults, request/reply over a transport; `tests/store.test.ts` covers the renderer store) and `npm run build` pass. Manually driven through the real Electron app (`electron-vite dev`, CDP on port 9333, `BOOK_TRANSLATOR_MOCK=1`, scratch data folder): window opens, engine utilityProcess starts and answers `listModels` (17 models incl. 9 discovered from LM Studio), New translation -> open file -> analyze/estimate -> pick mock models -> Start -> tiles/progress -> done; pause (tiles go back to pending) and close app + reopen + Resume finishes the project; chunk drawer edit + retranslate; export; glossary edit/save; settings screen. Not driven: real LM Studio/API translation through the UI, the native file dialog (a `BOOK_TRANSLATOR_PICK_FILE` env hook stands in for scripted runs), saving an API key in the real credential store from the UI, Open folder / show in folder. Engine: `engine serve` (utilityProcess via `process.parentPort`, or a Node child with IPC), `src/engine/{dispatcher,serve,transport}.ts`; `src/shared/protocol.ts` now has `Request {id, command}`, `reply` events and `CommandResults`. CLI fix: `index.ts` catch prints `error: <message>` and sets `process.exitCode = 1` (no `process.exit`); verified `translate` on a missing file prints one line, exit 1. Deviations: `openFile` is not an engine command (main process dialog, `pickFile` in the preload API; filters come from the engine's `getInfo`); `saveProviders` takes patches (`{id, enabled?, baseUrl?, concurrency?}`) and edits `providers.md` with the yaml Document API, keeping comments and body, instead of replacing the whole text; `analyze` also accepts `sourcePath` (+ target language and settings) so the wizard estimates without creating a project; the project is created only on Start (same file + language resumes the existing one); added commands `getInfo`, `snapshot`, `getDefaults`, `setDefaults`, `getProject` (chunk briefs, sections, glossary, brief, log tail), `getChunk`; added events `engine.ready`, `models`, `project.deleted`; the mock provider's models are hidden in the pickers unless `BOOK_TRANSLATOR_MOCK=1` (which also scripts it like the CLI; `BOOK_TRANSLATOR_MOCK_DELAY` slows it); `AGENTS` moved to `src/shared/agents.ts` (re-exported from schemas) so the renderer does not bundle zod; `scriptDevMock` moved to `src/engine/models/devMock.ts`. Known issues: quitting while a run is on kills the engine (chunks in progress restart as pending on resume, files are atomic); no error boundary in the renderer; model pickers show the first usable model (local first) when the configured defaults are unavailable.
- [x] Phase 6 Polish (README, builder config). Verified: README.md written (features, setup, providers/keys, LM Studio notes, CLI, data layout, prompts, formats and limitations, tests); `electron-builder.yml` (NSIS x64, appId `com.tihomirselak.booktranslator`, productName Book Translator, `asar: false` like scriptorium so @napi-rs/keyring and the engine's node_modules use real paths, `seed/` as extraResources); `npm run dist:dir` works (`dist/win-unpacked/Book Translator.exe`, 15 models/8 providers answered by the packaged engine, data folder seeded from `resources/seed`, window opened). Deviations: new script `dist:dir`; no custom icon (default Electron icon, `build/` not created); `npm run dist` (NSIS installer) not run, only the unpacked build; the packaged app's credential-store access (setSecret) was not exercised.
