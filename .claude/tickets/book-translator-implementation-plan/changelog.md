# Changelog

## 2026-10-09 — book-translator-implementation-plan

Built the Book Translator desktop app (Electron + TypeScript): EPUB/DOCX/TXT/MD/PDF in, translated document out. It works with local and API models, chunks text by model context, runs a glossary → translator → proofreader → QA agent pipeline, saves progress so runs can resume, and has a progress UI.

### Repository `book-translator` — branch `book-translator-mvp` (from `origin/master`)

**Scaffold and config:** `package.json`, `tsconfig*.json`, `electron.vite.config.ts`, `vite.engine.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `electron-builder.yml` (NSIS x64, `seed/` as extraResources), `README.md` (setup, providers/keys, LM Studio notes, CLI, data layout, limitations).

**Models (`src/engine/models/`):** copied from scriptorium and trimmed.
- Clients: OpenAI-compatible (LM Studio, Ollama, DeepSeek, OpenRouter, OpenAI, custom), Anthropic, Gemini, mock.
- `keys.ts`: env var or Windows Credential Manager under service `book-translator`.
- `registry.ts`: reads `providers.md`, discovers models, gives each model's context length (LM Studio's loaded context first).
- `router.ts`: retry, backoff, model fallback and per-provider limits. There is no budget class; cost is returned per call.
- `devMock.ts`: makes the mock reply in segment format, for dev and tests.

**Shared (`src/shared/`):**
- `ir.ts`: the document IR. Blocks with inline placeholder tags, `WriteOptions`, `outputExt`.
- `protocol.ts`: Request/reply commands, `EngineEvent`s and the preload API type.
- `project.ts`, `schemas.ts`, `agents.ts`, `md.ts`.

**Formats (`src/engine/formats/`, `src/engine/publish/`):**
- `text.ts`: TXT and MD; byte-exact round trip.
- `epub.ts`: edits the original XHTML in place, including TOC/NCX/title, `dc:language`, lang and RTL; every other file is copied byte for byte.
- `docx.ts`: runs become tags; hyperlinks, notes and headers/footers are handled; `w:lang` is set to the target.
- `pdf.ts`: pdfjs text extraction with paragraph and heading detection and header/page-number removal. Output is EPUB or Markdown. A scanned PDF gives an error.
- `inline.ts`: tag validation, and a plain-text fallback when tags don't match.

**Pipeline (`src/engine/`):**
- `chunker.ts`: chunk budget from the models' context, whole blocks per chunk, never across chapters, sentence split for oversize blocks.
- `pipeline/segments.ts`: the `<seg id>` protocol.
- `pipeline/glossary.ts`: terms plus the book brief, saved as editable `glossary.md`.
- `pipeline/translator.ts`: retries, then splits the chunk, then marks it failed.
- `pipeline/proofreader.ts`.
- `pipeline/qa.ts`: deterministic checks, then an LLM review, then a fix pass for major issues.
- `pipeline/runner.ts`: chapters run in parallel up to provider concurrency; chunks within a chapter run in order; pause, resume and cancel.
- `project/store.ts`: atomic per-chunk JSON, so runs resume.
- `service.ts`: `EngineService`.
- `dispatcher.ts` and `serve.ts`: the command handler and the utilityProcess server.
- `cli.ts` / `index.ts`: `translate`, `export`, `status`, `models`, `parse`, `key-set`.

**Prompts (`seed/`):** `seed/prompts/{_rules,glossary,translator,proofreader,qa,fix}.md`, `seed/config/providers.md`, `seed/config/defaults.json`.

**Electron (`src/main/`, `src/preload/`, `src/renderer/`):**
- Main and preload: the engine runs as a utilityProcess; file dialog, Open folder and show-in-folder are limited to the data folder; a power-save blocker is held while a translation runs.
- Screens: projects list, new-translation wizard (model per agent, estimate), progress view (chunk tiles, ETA, live output), glossary/brief editor, chunk drawer (side by side, edit, retranslate), settings (providers, keys, defaults).

**Tests (`tests/`):** 16 files, 117 tests. They cover the router, registry, inline tags, every format adapter's round trip, the chunker, segments, glossary, agents, the pipeline end to end (resume, splitting a chunk, the QA fix pass, failures, partial export), the dispatcher and the store.

### Deviations from the plan
- Chunks are planned on the first `start`, not when the project is created, because the budget depends on the chosen models.
- Project ids are `<name>-<lang>-<hash6>`, so the same file and language resumes the same project.
- `openFile` is a main-process dialog (`pickFile`) rather than an engine command.
- `saveProviders` takes patches instead of the whole file.
- `analyze` accepts a file path, so the wizard shows an estimate before any project exists.
- The segment-mismatch split is one level deep. `log.md` is appended to rather than written atomically.
- `ir.ts` gained `Block.level`, `WriteOptions` and `outputExt`.
- Mock models show in the pickers only with `BOOK_TRANSLATOR_MOCK=1`.
- The default agent models in `defaults.json` are API models, because LM Studio model ids are only known after discovery. Pick local models in the UI.

### Verification
- `npm run typecheck`, `npm run lint`, `npm test` (117/117) and `npm run build` pass. The orchestrator re-ran them after the final phase.
- CLI with the mock model: a generated EPUB → Croatian and a DOCX → German translated and exported.
- CLI with LM Studio on a 3-paragraph md, with glossary, proofreader and QA off: qwen3.6-35b gave good Croatian, nemotron-3-nano-4b gave poor Croatian.
- Electron dev app, scripted through CDP with mock models:
  - Covered: new translation, estimate, start, progress, pause, close and reopen, resume, the chunk drawer, export, glossary and settings.
  - Screenshots are in `.claude/temp/ui/`.
- `npm run dist:dir`: the packaged exe opens, seeds the data folder and lists models.

**Not run / not verified:**
- A real LM Studio or API translation through the UI.
- Glossary, proofreader and QA with a real model.
- Any API provider.
- The native file dialog: a `BOOK_TRANSLATOR_PICK_FILE` hook was used instead.
- Saving a key into the real credential store.
- The Open folder buttons.
- The NSIS installer.
- Opening the outputs in Calibre, Thorium or Word.
- Real-world books.

### Follow-ups and known limitations
- Quitting mid-run kills the engine. Chunks in progress restart as pending. There is no React error boundary.
- PDF: no multi-column or table support, no inline formatting, no OCR.
- DOCX: no RTL, and the core.xml title is not translated.
- EPUB: XHTML that isn't well-formed XML is skipped.
- No custom app icon.

### Commit status
Uncommitted on `book-translator-mvp`. `README.md` is modified and every other file is new.
