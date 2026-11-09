# BTT-26 research: independent QA for client-only projects, a QA score, the ACP port

Request REQ-0005, piece P2. Read-only research on 2026-11-09 against `master` at `e9e374c`. No code was changed.

## What happened on 2026-11-09

Project `C:/Users/Infplane/BookTranslator/projects/the-one-way-street-why-time-only-runs-hr-30e47a` (epub -> Croatian, 14 chunks, status `done`):

- `project.json` `settings.clientOnly: true`, `agentModels` = `client/claude-code` for all four agents. `spend.costUsd: 0`.
- `chunks/0001.json`: `qa: {"issues": []}`, `state: done`, `model: client/claude-code`. The same client translated, proofread and reviewed its own text.
- `chunks/NNNN.json` has no score field; nothing in the app produces a number.

## How client-only works today

- `src/shared/project.ts:47` `ProjectSettings.clientOnly?: boolean`; `CLIENT_ONLY_MODEL = 'client/claude-code'` (line 56), `isClientRef` (line 58).
- `src/engine/project/store.ts:197-211` `mergeSettings`: when `merged.clientOnly`, every agent's list is replaced by `[CLIENT_ONLY_MODEL]` (any `agentModels` in the patch is ignored). Used by `service.createProject` (`src/engine/service.ts:156-166`, also for an existing project) and `updateProjectSettings` (`src/engine/dispatcher.ts:764-777`).
- `src/engine/pipeline/runner.ts:392-400` `makeCall`: the one place every model call passes. For a client-only project it throws if any ref of the agent's list is not `client/...`.
- MCP: `src/engine/mcp/server.ts:48-51` (`clientOnly` param doc), `create_project` (113-136), `update_project_settings` (148-185), instructions text line 29, prompt text 361-365. The UI does not expose `clientOnly` at all (`grep clientOnly src/renderer` is empty).
- Tests: `tests/clientOnly.test.ts` (6 cases: merge rules, create_project, refusing a non-client ref, retry_chunk).

### Already possible without code

`clientOnly: false` plus `agentModels: { translator: [client/claude-code], glossary: [...], proofreader: [...], qa: ["acp/antigravity/gemini-3.8-flash"] }` gives client translation and Gemini QA today. What it loses is the guard: nothing stops a fallback, a default or `retry_chunk {model}` from reaching a paid model. That is why the change belongs inside `clientOnly`.

### A gap the change must close: shared fallbacks

`src/engine/models/router.ts:91-108` `resolve()` passes every list through `registry.orderRefs()` (`src/engine/models/registry.ts:681-724`). With `fallbackShared: true` in `config/defaults.json` (`src/shared/schemas.ts:140`, default false; not set in the live data folder) `orderRefs` returns every row of the global fallback list (seed default `deepseek/deepseek-flash`, `strata/default`) with the named model in place of its kind's row. The client-only guard checks the refs before that expansion. Today the client model goes first and never fails, so nothing paid is reached in practice; a reviewer model on the ACP proxy can fail (proxy down, timeout) and the router would then fall back to the paid rows. The router needs an "exact list" mode for client-only projects.

## QA today

- `src/engine/pipeline/qa.ts`: `deterministicChecks` (no model) then `reviewChunk` (QA model via `chatJson`, schema `qaReplySchema` = `{ issues: [...] }`). A QA model that gives no usable answer is skipped with a warning (deterministic checks only). `fixChunk` runs under the `translator` agent (task `fix`), so in client-only it stays on the client: the reviewer flags, the client fixes, the reviewer re-checks (task `recheck`).
- `src/engine/pipeline/runner.ts:331-371` `processChunk`: translate -> proofread (optional) -> review -> fix of major (or all with `fixMinorIssues`) -> recheck -> `done` or `flagged`.
- `src/engine/pipeline/env.ts:45-50` `chatFn` returns `{ text, costUsd }` only: the model ref of the QA answer is dropped, so a chunk does not record who reviewed it (`chunk.model` is the translator's).
- `src/engine/pipeline/llm.ts:39-48` `LlmReply { text, costUsd }`, `chatJson` returns `{ value, reply, cost }`.
- Client tasks with a schema are checked on submit (`src/engine/models/client.ts:177`); an optional `score` field keeps old and new answers valid.
- Prompt `seed/prompts/qa.md`: reply `{"issues":[...]}`, "If everything is fine, reply {"issues":[]}". The data folder copy (`C:/Users/Infplane/BookTranslator/prompts/qa.md`) is identical. `initDataFolder` (`src/engine/store/dataFolder.ts:78-99`) never overwrites a data-folder file, so a change to the seed prompt does not reach existing data folders. The score request must therefore also come from code when the loaded prompt does not ask for it.

### Where status is shown

- Per chunk: `ChunkRecord.qa: { issues }` (`src/shared/project.ts:118`); `ChunkBrief` (`src/shared/protocol.ts:145-156`) built by `chunkBrief` (`src/engine/service.ts:55-66`).
- Project: `summarize()` (`src/engine/project/summary.ts`) -> `ProjectSummary` (list_projects, create_project result, `ProjectsList.tsx:29`); counts are derived from chunk files, not stored in `project.json`. A project score derived the same way follows the convention.
- MCP: `get_project` (`server.ts:137-146`, returns `ProjectDetail`), `wait_for_progress` via `describe()` (`server.ts:390-407`).
- CLI: `engine status` (`src/engine/cli.ts:201-218`).
- UI: `ProjectView.tsx` statline (around line 192-198) and chunk tiles (`Tile`, line 15, has a `title` tooltip).

## Providers and the ACP proxy

- The proxy answers on `http://127.0.0.1:8787/v1/models` (checked 2026-11-09: lists `antigravity/gemini-3.8-flash`, `antigravity/gemini-4-argon`, `codex/...`, `claude/...`). Nothing answers on 7461.
- Seed `seed/config/providers.md:139` `base_url: http://127.0.0.1:7461/v1` and body text line 207. README line 49, ROADMAP line 21 (history), `src/renderer/ui/CustomProviderForm.tsx:53` placeholder, tests `tests/registry.test.ts:495,546-549`, `tests/dataFolder.test.ts:288`. Old scratch scripts in `.claude/temp/btt21_*.py` (ignore).
- Live data folder `C:/Users/Infplane/BookTranslator/config/providers.md:159-183`: `acp` is `enabled: true`, `local: true`, `concurrency: 4`, `json_schema: false`, still `base_url: http://127.0.0.1:7461/v1`, models include `antigravity/gemini-3.8-flash` (context 1000000). So the live folder needs the port fix too; a user who changed the URL must keep theirs.
- Migration pattern: `migrateStrataLoaded` (`src/engine/store/migrate.ts:228-320`) runs once per data folder, records its id in `migrations` of `config/seed-state.json` (live file has `["strata-loaded-v1"]`), edits providers.md as text so comments stay, and leaves a file it cannot read alone without recording. Called from `initDataFolder` after `migrateProviders`.
- Free vs paid: `isPaidModel` (`registry.ts:116-118`) = not local and has a price. A custom provider added with "Free" unchecked is `local: false` with price 0, so `isPaidModel` calls it free although it may bill. The safe test for "free" is `provider.local === true` (client providers are marked local too, `registry.ts:262`).
- Model refs: `provider/model`, provider is the part before the first `/` (`registry.ts:639`), so `acp/antigravity/gemini-3.8-flash` is a valid ref.

## Node and yarn (why `yarn build:engine` failed for the worker)

- Node is managed by fnm and is not on PATH in non-interactive shells. Yarn 4.18.1 (Berry, `.yarnrc.yml` `nodeLinker: node-modules`, `.yarn/` folder) comes with the fnm Node.
- Verified 2026-11-09 in PowerShell from the repo root:
  ```
  fnm env --use-on-cd | Out-String | Invoke-Expression
  yarn build:engine   # exit 0
  yarn test           # 25 files, 364 tests passed (prints "strata discovery failed", harmless)
  yarn typecheck      # exit 0
  ```
  `node -v` = v24.14.0.
- From Git Bash, `fnm exec --using default yarn -v` fails ("yarn does not exist"): use the PowerShell lines above. `yarn lint` was not run in this research (`eslint .`, same environment).
