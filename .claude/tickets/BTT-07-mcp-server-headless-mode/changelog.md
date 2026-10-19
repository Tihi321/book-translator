# Changelog: BTT-07 MCP server + headless mode

## 2026-10-19: BTT-07, MCP server in the engine and a headless mode

An outside LLM client can drive Book Translator over MCP (Streamable HTTP on `127.0.0.1`, bearer token). It can act as an operator that runs the app's own pipeline, or as the translator that translates the chunks itself. The app also runs with no window.

### Repo `book-translator`, branch `BTT-07_mcp-server-headless` (from `origin/master` fb8975d)

**Engine**
- `package.json`, `yarn.lock`
  - New dependency `@modelcontextprotocol/sdk` (1.32.1).
  - New script `headless` (`yarn build:engine && node out/engine/index.js headless`).
- `src/engine/serve.ts`
  - `bootEngine()` holds the old startup steps: lock, seed, registry, `recoverInterrupted`, slot timer, event bus.
  - `serve` now uses `bootEngine`, starts MCP when `mcp.enabled` or `--mcp` is set, never prints the token, and restarts MCP when `mcp` changes in the defaults.
  - New `headless` command: MCP always on. It prints the URL and token once and logs events as one stderr line each. Ctrl+C or SIGTERM pauses running projects, closes the server and releases the lock.
- `src/engine/index.ts`: the `headless` command and its usage line.
- `src/engine/bus.ts` (new): event fan-out for MCP waits.
- `src/engine/store/lock.ts` (new): `engine.lock` (pid) in the data folder, one engine per folder.
  - A live lock makes the engine fail with "another Book Translator engine is using <dir> (pid N)", exit 1.
  - A stale lock is taken over.
- `src/engine/mcp/server.ts` (new): 22 tools over `dispatcher.handle`, plus the `translate_book_yourself` prompt and server instructions.
  - Tool groups: info/models, projects, run control, `wait_for_progress` (up to 60 s), review/glossary/brief/export, and translator-role tools.
  - Not exposed: keys, provider settings, limits, deletion.
- `src/engine/mcp/http.ts` (new): stateless Streamable HTTP endpoint with JSON responses.
  - Rejections: loopback Host/Origin only (403), bearer token required (401), 404 off `/mcp`, 405 for anything but POST.
  - Body size is capped at 8 MB.
- `src/engine/mcp/controller.ts` (new, not in the plan): starts, stops and restarts the server and builds `McpStatus`. A busy port shows up as a status error, not a crash.
- `src/engine/mcp/token.ts` (new): the bearer token comes from the env var `BOOK_TRANSLATOR_MCP_TOKEN`, else the credential store, else it is generated and stored.
- `src/engine/service.ts`: new outside-translator methods. All refuse while the project runs in the app.
  - `prepareChunks`: chunks without needing a translator model.
  - `translationTask`: the same messages the app's translator sends, plus the next chunk.
  - `submitTranslation`: all-or-nothing check of segment ids and inline tags. It saves `final`, sets the project to `incomplete`/`done`, and emits `chunk.state`, `progress` and `project.updated`.
  - `setBrief`.
- `src/engine/pipeline/runner.ts`: extracted `planProjectChunks()`, which the runner and `prepareChunks` share. Runner behaviour is unchanged.
- `src/engine/pipeline/translator.ts`: exports `translatorUserContent` (renamed from `userContent`) and `tagIssue`.
- `src/engine/dispatcher.ts`
  - Handles the new commands and `getMcpStatus`.
  - New options `mcpStatus` and `onDefaultsSaved`.
  - `setDefaults` merges `mcp`.
- `src/shared/protocol.ts`
  - New commands: `prepareChunks`, `getTranslationTask`, `submitTranslation`, `setBrief`, `getMcpStatus`.
  - New types: `McpStatus`, `PrepareChunksResult`, `TranslationTask`, `SubmitResult`, and `DefaultsPatch.mcp`.
- `src/shared/schemas.ts`, `seed/config/defaults.json`: `mcp: { enabled: false, port: 47811 }`, with a default so existing files still parse.

**App**
- `src/main/index.ts`
  - `--headless`: no window, and passes `--mcp` to the engine.
  - `BOOK_TRANSLATOR_NO_WINDOW=1` still means only "no window".
  - A normal launch while headless runs opens a window on the same engine. Closing that window keeps the app running.
  - A `--headless` launch while the app runs prints a note and quits.
  - If the engine exits before it is ready: error box with the engine.lock hint (or stderr and exit 1 in headless), then quit.
- `src/main/engineClient.ts`: keeps a 2000-char stderr tail, tracks `engine.ready`, and has an `onExit` callback.
- `src/renderer/ui/Settings.tsx`: new "MCP server" card.
  - Enable checkbox, port, Save, and a status line (running / error / off / on for this run only).
  - Masked token with Show/Copy.
  - Copy-ready Claude Code command and JSON config, shown while the server runs.
- `README.md`
  - New "MCP (use it from another LLM)" and "Headless" sections.
  - A `headless` CLI line, the script mention and a Features bullet.

**Tests**
- `tests/dispatcher.test.ts`: the new commands and the `mcp` defaults.
- `tests/mcp.test.ts` (new):
  - HTTP status checks: 401/403/404/405/400.
  - Tool and prompt names, `isError` results.
  - Operator and translator flows with the SDK client.
- `tests/lock.test.ts` (new): a second lock is refused, a stale lock is taken over, release works.

### Deviations from the plan
- `McpController` was added to own the server lifecycle and the token.
- `bootEngine` takes `{ argv, send?, mcpStatus?, onDefaultsSaved? }`.
- `planProjectChunks` has a `replan` flag, which keeps the runner's `!opts.only` rule.
- Host/Origin are checked in `http.ts` instead of the SDK option, because the port is known only after listen. Responses are plain JSON (no SSE).
- `wait_for_progress` waits 25 s by default and at most 60 s.
- When nothing is left, `get_translation_task` returns `{ done: true }`.
- A rejected submission returns `ok: false` with `problems`, not `isError`.
- The README uses `npm run headless` to match its npm style.
- The Settings snippets are masked until Show is pressed.
- Review fix: `BOOK_TRANSLATOR_NO_WINDOW=1` no longer forces MCP on.

### Verification
**Passed**
- `yarn typecheck` and `yarn lint`: clean.
- `yarn test`: 20 files, 223 tests passed.
- `yarn build`: ok.
- E2E with the headless engine, a temp data folder, mock models and the SDK client over HTTP:
  - A second engine was refused by the lock with exit 1.
  - The server listed 22 tools and the prompt.
  - A bad submission was rejected with its reason.
  - Two chunks were translated and submitted, and the export contains the submitted text.
- Electron smoke (implementer): `electron . --headless` printed the MCP URL. A second `--headless` launch printed the already-running note.

**Not run**
- The Settings card in a real window (including the clipboard).
- The second-instance window, and the window not quitting on close.
- The error dialog when the lock is held under Electron.
- Ctrl+C on `yarn headless`.
- Real model providers (none were called).

### Follow-ups and limitations
- The packaged exe with `--headless` prints nothing to a Windows terminal (GUI subsystem). Get the token from Settings by launching the app normally.
- A hard kill leaves `engine.lock`. It is taken over at the next start unless the pid has been reused by another process. In that case delete it, as the error message says.
- Running the app's QA or proofreader on chunks an outside LLM translated is possible only through `retry_chunk` (which retranslates). A review-only stage is out of scope.
- The Electron `--headless` smoke stored a real `BOOK_TRANSLATOR_MCP_TOKEN` entry in the Windows credential store (service `book-translator`). That is the intended behaviour.

### Commit status
Uncommitted on `BTT-07_mcp-server-headless`.
