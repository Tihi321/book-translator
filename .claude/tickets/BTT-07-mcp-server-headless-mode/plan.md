# BTT-07: MCP server + headless mode

Ticket folder: `.claude/tickets/BTT-07-mcp-server-headless-mode/`
Branch: `BTT-07_mcp-server-headless` (created from `origin/master` at fb8975d)

## Progress checklist
- [x] 1. Dependency (`@modelcontextprotocol/sdk` 1.32.1; accepts zod ^3.25 || ^4, `registerTool` takes zod raw shapes, `import { z } from 'zod'`; `yarn build:engine && node out/engine/index.js --help` loads the bundle)
- [x] 2. Engine bootstrap refactor + event bus + data-folder lock (`bootEngine`, `src/engine/bus.ts`, `src/engine/store/lock.ts`, `headless` in serve.ts; `src/engine/mcp/controller.ts` added: starts/stops/restarts MCP and holds the token. Lock check: smoke run, second instance fails with the lock message, a killed engine's stale lock is taken over)
- [x] 3. New engine commands (`prepareChunks`, `getTranslationTask`, `submitTranslation`, `setBrief`) (dispatcher tests added; `planProjectChunks` extracted)
- [x] 4. MCP server (`src/engine/mcp/`) (tests/mcp.test.ts: 401/403/405, tool names, operator + translator flows)
- [x] 5. Config (`mcp` in defaults, `getMcpStatus`) + Settings UI card: engine side (schema, seed, DefaultsPatch.mcp, getMcpStatus, restart on change) and `McpCard` in Settings.tsx (enable, port, Save, status, masked token with Show/Copy, Claude Code + JSON snippets only while running). Not checked in a real window
- [x] 6. Headless entry points: engine side (`headless [--data] [--port]`, `serve --mcp`, `yarn headless`) and Electron (`--headless` -> no window + `--mcp`; second-instance opens a window when headless and the 2nd launch lacks `--headless`; window opened from headless does not quit the app; engine failure before ready -> error box / stderr + exit 1 with the engine.lock hint; `--headless` launch on a running app prints a note and quits). Smoke: `electron . --headless --data <tmp>` with mock prints the MCP URL; a second `--headless` prints the already-running note. Window/dialog paths not run (no GUI)
- [x] 7. README (sections "MCP (use it from another LLM)" and "Headless", CLI line, scripts mention; uses `npm run headless` to match the README's npm style, `yarn headless` is the same script)
- [x] Verification: `yarn typecheck`, `yarn lint` clean; `yarn test` 20 files / 223 tests pass; `yarn build` ok. E2E (orchestrator): `node out/engine/index.js headless` on a temp data folder with mock models + SDK client over HTTP: second engine refused by the lock (exit 1), 22 tools + `translate_book_yourself` prompt listed, translator flow (create_project -> prepare_chunks -> bad submit rejected -> get_translation_task/submit_translation x2 -> export) wrote the submitted text. Not run: anything that needs a GUI (Settings card, second-instance window, error dialog), Ctrl+C on `yarn headless` (SIGTERM on Windows is a hard kill; the stale lock is taken over at next start)
- Fix after review: `BOOK_TRANSLATOR_NO_WINDOW=1` (scripted checks) no longer forces MCP on; only `--headless` does

## Context

The app can only be driven from its own UI or a one-shot CLI. The goal is to let an outside LLM client (Claude Code, Claude Desktop, Cursor, Codex ...) work with Book Translator over MCP. The client gets two roles:

1. **Operator.** It drives the app's own pipeline: analyze a file, create a project, set models, start/pause/resume, watch progress, review flagged chunks, fix text, export. The app's configured models (Strata, DeepSeek ...) still do the translating.
2. **Translator.** The outside LLM does the translating itself. The app chunks the book and builds the same prompt its translator agent would get (rules, brief, glossary slice, previous passage, `<seg>` segments). The LLM translates and submits, the app checks segment ids and inline tags, and export works as usual. The app's models are not used and nothing is spent on them.

Decisions from the user:
- **MCP runs inside the running app** (it shares its one engine, so the UI shows MCP work live).
- **Headless mode:** the app can run with no window, so MCP works without the UI.

## Architecture

The MCP server lives in the **engine process**, next to `CommandDispatcher`, not in Electron main. It is a Streamable HTTP endpoint on `http://127.0.0.1:<port>/mcp`. Reasons:
- The tools are thin adapters over `dispatcher.handle(Command)` (`src/engine/dispatcher.ts:413`), the same path the UI, the CLI and the tests use. There is no second command implementation.
- The engine's `emit` already reaches the UI, so projects, chunk states and progress that MCP triggers show up in the window with no extra wiring.
- The same code runs under Electron's utilityProcess and under plain Node, which is what headless mode needs.

```
MCP client ──HTTP──► engine process: McpHttpServer ─► CommandDispatcher ─► EngineService
                                    ▲ events (bus)              │ emit
Electron main ◄── parentPort ───────┴───────────────────────────┘ (UI unchanged)
```

Security: binds to 127.0.0.1 only. It uses the SDK's DNS-rebinding protection (allowed Host and Origin) and requires a bearer token (`Authorization: Bearer <token>`). The token is generated on first enable and kept in the Windows credential store under `BOOK_TRANSLATOR_MCP_TOKEN`, through the existing `setStoredKey`/`resolveKey` in `src/engine/models/keys.ts`. The env var still overrides it, as for API keys. The MCP surface deliberately leaves out API keys, provider config and project deletion.

## Steps

### 1. Dependency
- `yarn add @modelcontextprotocol/sdk`, a runtime dependency. The engine is an SSR build with external deps, and `asar: false` ships node_modules, so packaging needs no change. Check that the SDK version accepts zod v4 (the project has `zod@^4.6`). Also check that the CJS engine bundle resolves `@modelcontextprotocol/sdk/server/mcp.js` and `.../streamableHttp.js` through the `require` export condition (`yarn build:engine && node out/engine/index.js --help`).

### 2. Engine bootstrap refactor (`src/engine/serve.ts`)
- Pull the body of `serve()` into `bootEngine({ argv, emit })`. It returns `{ dataDir, service, dispatcher, bus, stop }` and does the data folder init, registry load, `recoverInterrupted`, discovery and the slot timer.
- `bus`: a small `EventEmitter` fan-out. `emit = ev => { transport?.send(ev); bus.emit('event', ev) }`. MCP tools use it to wait on progress.
- `serve(argv)` = `bootEngine` + transport (no behavior change), then `startMcp()` when it is enabled (step 5).
- New `headless(argv)` = `bootEngine` with no transport, MCP always on, events logged to stderr (one line per log, error and project status change, like `cli.ts` `translate`). It prints the MCP URL and token once at startup, and Ctrl+C pauses running projects, then exits.
- **Data-folder lock:** `src/engine/store/lock.ts` writes `engine.lock` (pid) exclusively when `serve` or `headless` starts and removes it on exit. A stale lock (pid not alive) is taken over. A live lock makes the second engine fail with "another Book Translator engine is using <dataDir> (pid N)". This keeps a `yarn headless` from running alongside the windowed app on the same projects. The `translate`/`export`/`status` CLI commands are not locked, as today.

### 3. New engine commands (external translator)
Add these to `Command`/`CommandResults` in `src/shared/protocol.ts` and handle them in `CommandDispatcher.handle`. They live in `EngineService` and are covered by the dispatcher tests, so the UI could use them later:

- `prepareChunks { projectId, maxChunkTokens? }` → `{ chunks, budget }`. It makes the chunk files without running anything and needs no translator model. Budget is `chunkBudget({ contexts: [], userMax })` from `src/engine/chunker.ts:33`. Extract the plan/write part of `ProjectRunner.prepareChunks` (`src/engine/pipeline/runner.ts:162-186`) into an exported `planProjectChunks(store, project, ir, budget)` and use it in both places. It keeps the existing rule: re-plan only while every chunk is pending.
- `getTranslationTask { projectId, index? }` → `{ index, sectionId, remaining, segmentIds, messages: ChatMessage[], instructions }`. Without `index` it returns the first `pending`/`failed` chunk in order. The previous passage is `prevTail` from the previous chunk only when that chunk is in the same section and finished, the same rule the runner uses. `messages` comes from `buildMessages(dataDir, 'translator', …)` with the user content the app's translator builds: export `userContent` from `src/engine/pipeline/translator.ts:49` as `translatorUserContent`. Refused while the project runs in the app pipeline.
- `submitTranslation { projectId, index, reply?: string, segments?: Record<string,string>, model?: string }` → `{ ok, state, problems[], remaining }`. It takes a raw `<seg id>` reply (parsed with `parseSegments`) or an id→text map. It is all-or-nothing:
  - Missing, extra or duplicate ids are rejected with `describeParse` text.
  - Each segment goes through `fitEdges`. A segment whose inline tags don't match (`tagIssue`, exported from translator.ts) is rejected with the exact problem so the LLM fixes it.
  - On success: `translation`, `final` and `model` (default `external/mcp`) are set, state goes to `done`, and `chunk.state` + `project.updated` are emitted. Project status becomes `done` when no chunk is left, else `incomplete`.
  - Refused while the project runs.
- `setBrief { projectId, brief: string }` → writes `brief.md` (`store.writeBrief`), so the outside LLM can set tone and characters. The glossary already has `updateGlossary`.

The app's QA/proofreader can still check external work afterwards: `retryChunk` is unchanged, and an optional `review` stage is out of scope. Note this in the README.

### 4. MCP server (`src/engine/mcp/`)
- `server.ts`: `createMcpServer(dispatcher, service, bus)` → `McpServer` with `instructions` that describe both workflows. Tools, with zod input schemas and JSON text results:
  - Info and models: `get_info`, `list_models` (trimmed: ref, available, context, price), `get_defaults`, `list_languages`.
  - Projects: `list_projects`, `analyze_file`, `create_project` (sourcePath, targetLanguage, sourceLanguage, agentModels, enabled agents, maxChunkTokens), `get_project` (the detail with only the last 40 log lines), `update_project_settings`.
  - Running: `start_translation` (start/resume), `pause_translation`, `cancel_translation`, `wait_for_progress` (resolves on the next `project.updated`/progress milestone or after ≤60 s through `bus`, returns progress + status).
  - Review: `get_chunk`, `edit_chunk`, `retry_chunk`, `update_glossary`, `set_brief`, `export_project` (returns the path).
  - Translator role: `prepare_chunks`, `get_translation_task`, `submit_translation`.
  - Prompt: `translate_book_yourself` (args: file, target language) gives the step-by-step loop: create_project with all agents off → prepare_chunks → optionally build the glossary/brief → loop get_translation_task/submit_translation → export_project.
  - Every handler wraps `dispatcher.handle`. An error comes back as `isError: true` with the engine message.
- `http.ts`: `startMcpHttp({ port, token, factory })` on `node:http`, **stateless** Streamable HTTP (a new transport + server per POST, `sessionIdGenerator: undefined`). It checks the bearer and the Host/Origin, answers 405 on GET/DELETE, and returns `{ url, close }`. If the port is busy, the error is logged and reported in the status (no crash).
- `token.ts`: get or create the token (`crypto.randomBytes(24).toString('base64url')`) through keys.ts.

### 5. Config + Settings UI
- `defaultsSchema` (`src/shared/schemas.ts:99`): add `mcp: { enabled: boolean (false), port: int 1024–65535 (47811) }` with `.default(...)`, so existing defaults.json files still parse. Also add it to `DefaultsPatch` and `setDefaults` in the dispatcher.
- After `setDefaults`, the engine restarts the MCP server when `mcp` changed.
- New command `getMcpStatus` → `{ enabled, running, url?, error?, token? }`. Electron main stays a pass-through, as for other commands.
- `src/renderer/ui/Settings.tsx`: a new "MCP server" card. It has an Enable toggle, the port, a status line (running at url / error), the token (masked, with a Copy button), and copy-ready snippets for Claude Code (`claude mcp add --transport http book-translator <url> --header "Authorization: Bearer <token>"`) and for JSON-config clients (`url` + `headers`). It follows the card/row/`data-testid` patterns already in Settings.

### 6. Headless entry points
- Engine CLI (`src/engine/index.ts`): new command `headless [--data <dir>] [--port <n>]` plus a usage line. package.json script: `"headless": "yarn build:engine && node out/engine/index.js headless"`.
- Electron (`src/main/index.ts`): the `--headless` flag (or the existing `BOOK_TRANSLATOR_NO_WINDOW=1`) creates no window and passes `--mcp` to the engine, which forces MCP on for this run. On `second-instance`, when there is no window, it creates one. Launching the app normally while it runs headless therefore opens the UI on the same engine, and there is no lock conflict.
- When the engine fails at start (lock held), main shows an error dialog and quits, or in headless mode prints the error and quits.

### 7. Docs
README: a new "MCP (use it from another LLM)" section (enable, token, client snippets, the two workflows, tool list, safety notes), a "Headless" section (`Book Translator.exe --headless`, `yarn headless`), and CLI usage lines.

## Critical files
- New: `src/engine/mcp/server.ts`, `src/engine/mcp/http.ts`, `src/engine/mcp/token.ts`, `src/engine/store/lock.ts`, `tests/mcp.test.ts`
- Modified: `src/engine/serve.ts`, `src/engine/index.ts`, `src/engine/dispatcher.ts`, `src/engine/service.ts`, `src/engine/pipeline/runner.ts` (extract `planProjectChunks`), `src/engine/pipeline/translator.ts` (export `translatorUserContent`, `tagIssue`), `src/shared/protocol.ts`, `src/shared/schemas.ts`, `src/main/index.ts`, `src/renderer/ui/Settings.tsx`, `src/renderer/store/store.ts` (if MCP status is kept there), `package.json`, `README.md`, `seed/config/defaults.json` (add `mcp` block)

## Reuse
`CommandDispatcher.handle`, `EngineService` (createProject/detail/start/pause/editChunk/export), `planChunks` + `emptyChunk`, `chunkBudget`, `buildMessages`, `prevTail`, `fitEdges`, `parseSegments`/`describeParse`, `validateTags`/`stripTags`, `resolveKey`/`setStoredKey`, `atomicWrite`, `tests/pipelineHelpers.ts` `rig()` (mock provider and temp data folder).

## Verification
1. `yarn typecheck`, `yarn lint`, `yarn test`. Existing suites must pass, plus:
   - `tests/dispatcher.test.ts`: `prepareChunks` makes chunks with no translator model. `getTranslationTask` returns the messages with `<seg>` ids, the glossary slice and the prev passage. `submitTranslation` rejects wrong ids, rejects bad tags, accepts a good reply, sets the project to `done` after the last chunk, and `export` contains the submitted text. Commands are refused while a run is active.
   - `tests/mcp.test.ts`: start `startMcpHttp` on port 0 with a `rig()` engine and connect the SDK `Client` + `StreamableHTTPClientTransport`. Check: 401 without a token and 403 with a bad Host. `listTools` has the expected names. The operator flow (create_project with mock models → start_translation → wait_for_progress until done → export_project) works. The translator flow (prepare_chunks → get_translation_task/submit_translation loop → export) works.
   - `tests/lock.test.ts`: a second lock fails and a stale pid is taken over.
2. Manual, **with mock models only** (`BOOK_TRANSLATOR_MOCK=1`, a temp `--data` dir, and mock models set explicitly on every agent, because the defaults are Strata → DeepSeek and would spend real money):
   - `yarn headless --data <tmp>` prints the URL and token. `claude mcp add --transport http …` then runs both workflows on `tests/fixtures`-style markdown, and the exported file is checked.
   - `yarn dev`: enable MCP in Settings. A project created and started over MCP shows up live in the UI. Launching a second app instance while `--headless` runs opens the window on the same engine. Running `yarn headless` while the app is open fails with the lock message.
