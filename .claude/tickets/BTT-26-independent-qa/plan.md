---
status: in-progress
request: REQ-0005
repos: [book-translator]
branch: BTT-26_independent-qa
updated: 2026-11-09
---

# BTT-26 Independent QA for client-only projects, a QA score, the ACP port

Research with file:line evidence: `research.md` in this folder. Branch `BTT-26_independent-qa` from `master` (`e9e374c`).

Reading chosen: the narrow one. A client-only project can name one free reviewer model list for QA (and, if asked, the proofreader); nothing else about client-only changes. There is no new UI control: `clientOnly` is MCP-only today and stays so. The score is shown, not edited.

## Scope

1. **Independent reviewer for client-only projects.** New project setting `reviewer: { models: string[]; proofread?: boolean }`, set through `create_project` and `update_project_settings`. With `clientOnly: true` and a non-empty `reviewer.models`, the `qa` agent (and the `proofreader` when `proofread: true`) uses those models; glossary, translator and the fix pass stay on `client/claude-code`. Reviewer models must be free: a `client/` model other than `client/claude-code`, or a model of a provider with `local: true` (the `acp` proxy is `local: true`). A paid or non-local model is refused with an error when the setting is saved and again at call time. A client-only project's model lists are used exactly as given: shared fallbacks (`fallbackShared`) never add rows, so a reviewer that is down leaves QA to the deterministic checks (warning in the log) and never falls back to a paid model.
2. **A numeric QA score.** The QA reply gets an optional `score` (0-10). Each chunk stores `qa.score` and `qa.model` (who gave the verdict) in `chunks/NNNN.json`. The project score is derived from the chunk files on read (like the done/flagged counts), with how many chunks are scored, by which models, and whether the review was independent. Shown in `get_project`, `wait_for_progress`, `list_projects` / `create_project` results, `engine status`, and the UI project view (statline and chunk tile tooltip).
3. **ACP port 7461 -> 8787.** Seed `providers.md`, README, the custom-provider form placeholder, and the two seed tests. A one-time migration rewrites the `acp` entry's `base_url` in an existing data folder only when it is exactly the old seed value `http://127.0.0.1:7461/v1`; any other URL is left alone.

## Out of scope

- Scriptorium, api-acp-proxy, creative-hub.
- Retranslating or re-reviewing the existing project `the-one-way-street-why-time-only-runs-hr-30e47a`.
- A UI control for `clientOnly` or `reviewer`; a data-folder default reviewer (see open choice 1).
- Paid reviewers under `clientOnly`. A paid QA model is already possible with `clientOnly: false` and `agentModels` (research.md, "Already possible without code").
- Changing the fix pass (it stays under the translator agent, so on the client).
- Rewriting existing data-folder prompts (`prompts/qa.md` is the user's file).

## Files and modules

| File | Change |
|---|---|
| `src/shared/project.ts` | `ReviewerSettings { models: string[]; proofread?: boolean }`, `ProjectSettings.reviewer?`; `ChunkRecord.qa` gains `score?: number`, `model?: string`; `ProjectSummary` gains `qa: QaScore`; type `QaScore { score: number \| null; scored: number; models: string[]; independent: boolean }`; helper `reviewerAgents(settings): AgentName[]`. |
| `src/engine/project/store.ts` | `mergeSettings`: after the client-only overwrite, put `reviewer.models` on `qa` (and `proofreader` when `proofread`). |
| `src/engine/service.ts` | `checkReviewer(settings)` (uses `this.registry`) called from `createProject`; `chunkBrief` adds `qaScore`; `detail()` adds `qa`. |
| `src/engine/dispatcher.ts` | `updateProjectSettings` calls `checkReviewer` before saving. |
| `src/engine/pipeline/runner.ts` | `makeCall`: allowed refs per agent; `exact: true` for client-only projects; re-check reviewer refs are local. |
| `src/engine/models/router.ts` | `RoutedRequest.exact?: boolean` (interface at line 7); `resolve(refs, { exact })` skips `registry.orderRefs` when exact. |
| `src/engine/pipeline/llm.ts`, `src/engine/pipeline/env.ts` | `LlmReply.model?: string`; `chatFn` passes `r.model` through. |
| `src/engine/pipeline/qa.ts` | `qaReplySchema` gains `score` (number or numeric string, optional); `reviewChunk` returns `{ issues, score?, model? }`; adds the score request to the user message when the loaded prompt lacks `"score"`. |
| `src/engine/pipeline/runner.ts` (`processChunk`) | store `chunk.qa.score` / `chunk.qa.model` from the last review; `resetChunk` (line 82-90) already resets `qa` to `{ issues: [] }`, which drops them. |
| `src/engine/project/summary.ts` | `qaScoreOf(chunks): QaScore`; `summarize` sets `qa`. |
| `src/shared/protocol.ts` | `ChunkBrief.qaScore?: number`; `ProjectDetail.qa: QaScore`. |
| `src/engine/mcp/server.ts` | `reviewer` param on `create_project` / `update_project_settings`; `describe()` adds `qa`; instructions text (line 29) and `translate_with_full_pipeline` prompt mention `reviewer`. |
| `src/engine/cli.ts` | `engine status` prints one QA score line. |
| `src/renderer/ui/ProjectView.tsx` | statline `QA <b>8.7</b>/10` (title: scored n of m by models, "self-reviewed" when not independent); tile title adds `, QA 8`. |
| `seed/prompts/qa.md` | reply format with `score`. |
| `seed/config/providers.md` | `acp` `base_url` and the body text: 8787. |
| `src/engine/store/migrate.ts`, `src/engine/store/dataFolder.ts` | `migrateAcpPort` (`acp-port-8787-v1`), called after `migrateStrataLoaded`. |
| `src/renderer/ui/CustomProviderForm.tsx` | placeholder 8787. |
| `README.md`, `ROADMAP.md` | docs (T5). |
| `tests/clientOnly.test.ts`, `tests/pipeline.test.ts`, `tests/dataFolder.test.ts`, `tests/registry.test.ts` | see acceptance criteria. |

## Tasks for workers

Order: T1 -> T2 -> T3 can run in parallel with T1/T2 (different files except `runner.ts`: T3 owns `processChunk`, T2 owns `makeCall`; give them to one worker or sequence them). T4 is independent. T5 last.

### T1 Reviewer setting, merge, validation, MCP

- Inputs: `src/shared/project.ts`, `src/engine/project/store.ts:197-211`, `src/engine/service.ts:156-166`, `src/engine/dispatcher.ts:764-777`, `src/engine/mcp/server.ts:48-185`.
- Contract:
  - `ProjectSettings.reviewer?: { models: string[]; proofread?: boolean }`. `reviewerAgents(s)` = `[]` unless `s.clientOnly && s.reviewer?.models.length`; else `['qa']`, plus `'proofreader'` when `proofread === true`.
  - `mergeSettings`: `reviewer` from the patch replaces the old one whole (not deep-merged). After the client-only overwrite, each agent in `reviewerAgents(merged)` gets `[...merged.reviewer.models]`. `reviewer: { models: [] }` turns it off (agents go back to the client while `clientOnly` is on). Without `clientOnly` the setting is kept but has no effect.
  - `checkReviewer(settings)` in `EngineService` (public, the dispatcher calls it): for each ref in `reviewer.models`: must contain `/`; `client/claude-code` is refused ("the reviewer must be a different model than the one that translates"); another `client/...` ref is accepted; else the provider (part before the first `/`) must exist in the registry with `local: true`, otherwise throw `reviewer model <ref> is not free (only local providers or client models; a client-only project spends nothing). For a paid QA model turn clientOnly off and set agentModels.` Called in `createProject` (new and existing project) and in `updateProjectSettings` before `store.save`.
  - MCP `reviewer: z.object({ models: z.array(z.string()), proofread: z.boolean().optional() }).optional()` on both tools, passed through `defined({...})`. Describe it: "Client-only projects: QA (and the proofreader with proofread true) use these free models instead of client/claude-code, for example ["acp/antigravity/gemini-3.8-flash"]. Paid models are refused. models [] turns it off."
- Output: settings round-trip through `project.json`; `get_project` shows `settings.reviewer` and the QA list.

### T2 Call path: allowed refs and exact lists

- Inputs: `src/engine/pipeline/runner.ts:392-400`, `src/engine/models/router.ts:91-140`, `src/engine/models/registry.ts:681-724`.
- Contract:
  - Router: `RoutedRequest.exact?: boolean`; `chat()` calls `this.resolve(refs, { exact: req.exact })`; `resolve` uses `strs` as given instead of `this.registry.orderRefs(strs)` when exact. Aliases are still resolved (`registry.resolve`). No other caller changes.
  - Runner `makeCall`, client-only branch: a ref is allowed when `isClientRef(ref)`, or when `agent` is in `reviewerAgents(settings)`, the ref is in `settings.reviewer.models`, and `registry.getModel(registry.resolve(ref))?.provider.local === true` (or the provider entry is local when the model is not listed). Anything else throws the existing client-only error (keep the word `client-only`). Pass `exact: true` in the routed request for every call of a client-only project.
- Output: in a client-only project no call reaches a non-free model, even with `fallbackShared: true` and a failing reviewer.

### T3 QA score

- Inputs: `src/engine/pipeline/qa.ts`, `llm.ts:39-90`, `env.ts:45-50`, `runner.ts:331-371`, `summary.ts`, `service.ts:55-66,247-262`, `protocol.ts:145-169`, `server.ts:390-407`, `cli.ts:201-218`, `ProjectView.tsx:15,192-198`, `seed/prompts/qa.md`.
- Contract:
  - `qaReplySchema`: `score: z.union([z.number(), z.string()]).optional()` (keep `issues` default `[]`). Parse: a finite number, clamp to 0..10, round to 1 decimal; anything else is "no score".
  - Prompt: seed `qa.md` reply block becomes `{"score":8,"issues":[...]}` with one line defining `score`: "your overall grade of the translation of these segments, 0 (unusable) to 10 (publishable as is)", and "If everything is fine, reply {"score":10,"issues":[]}". `reviewChunk` appends to the user message `## Score\nAlso put "score" (0 to 10, ...) in the JSON object.` only when no message from `buildMessages` contains `"score"` (older data-folder prompts).
  - `reviewChunk` returns `{ issues: QaIssue[]; score?: number; model?: string }`. `score`: the model's number; if the model answered without a usable score, `max(0, 10 - 3*majors - minors)` over the returned issues (deterministic ones included); if the model gave no usable answer (catch branch), no score and no model. `model` is the ref that answered (`LlmReply.model`, filled by `chatFn` from `env.call`'s result).
  - Runner: after the last review (`recheck` if there was a fix) set `chunk.qa = { issues, score, model }` (omit undefined keys). `resetChunk` already clears them (it sets `qa = { issues: [] }`). QA disabled: no score.
  - `qaScoreOf(chunks)`: `scored` = chunks with a number `qa.score`; `score` = mean of those, 1 decimal, `null` when none; `models` = distinct `qa.model`; `independent` = `scored > 0` and no scored chunk has `qa.model === chunk.model`.
  - Shown: `ProjectSummary.qa`, `ProjectDetail.qa`, `ChunkBrief.qaScore`, `wait_for_progress` result `qa`, `engine status` line `qa score: 8.7/10 (12 of 14 chunks, acp/antigravity/gemini-3.8-flash)` plus `self-reviewed` when not independent. UI: statline span only when `scored > 0`; tile title `, QA 8`.
- Output: files carry the score; every status surface shows the same number.

### T4 ACP port

- Inputs: `seed/config/providers.md:139,207`, `src/engine/store/migrate.ts:228-320` (pattern), `src/engine/store/dataFolder.ts:78-99`, `CustomProviderForm.tsx:53`, `tests/registry.test.ts:495,546-549`, `tests/dataFolder.test.ts:288`.
- Contract:
  - Seed: `base_url: http://127.0.0.1:8787/v1`, body text "(`http://127.0.0.1:8787/v1`)".
  - `migrateAcpPort(dataDir)`: once per data folder (`acp-port-8787-v1` in `migrations` of `config/seed-state.json`). If the `acp` entry's `base_url` is exactly `http://127.0.0.1:7461/v1`, replace that value in the text (comments, order and the rest of the file unchanged) and return the id in `added`; any other value, or no `acp` entry, changes nothing but is recorded. A providers.md that cannot be parsed is left alone and not recorded. A fresh data folder (providers.md just copied from the seed) only records it. Called from `initDataFolder` after `migrateStrataLoaded`.
  - Existing tests that assert 7461 now assert 8787.
- Output: the live data folder (`C:/Users/Infplane/BookTranslator`) gets 8787 at the next engine start; a folder with its own URL keeps it.

### T5 Docs

- README: line 49 port 8787; the client-only paragraph (line 142) gains `reviewer` with the Gemini example and the "free only, exact lists" rule; the QA line (line 10) and the project files list (line 204) mention `score`; `get_project` / `wait_for_progress` docs mention `qa`.
- ROADMAP: a "Where it stands" row for BTT-26 (do not rewrite the BTT-21 history row; add "now 8787" to the new row).
- `server.ts` instructions line 29 and the `translate_with_full_pipeline` prompt: one sentence on `reviewer`.
- Ticket `changelog.md` per the implement skill.

## Acceptance criteria

Few tests, per test-discipline: one new test per behaviour that matters, existing tests updated in place.

| # | Criterion | Proof |
|---|---|---|
| AC-1 | A client-only project with `reviewer.models` sends QA requests to the reviewer and everything else (glossary, translator, fix) to the client; with `fallbackShared: true` and a reviewer that fails, no other model is called and the chunk still finishes with deterministic QA. | New test in `tests/clientOnly.test.ts`: rig with a local mock provider as reviewer (mark the mock provider `local: true` in the rig's providers.md or registry), clientOnly + reviewer, answer client tasks; assert the mock saw only `qa` roles, then make the mock fail with `fallbackShared: true` and assert no call to any other model and the chunk is `done`/`flagged` with a QA warning in the log. |
| AC-2 | A paid or non-local reviewer, or `client/claude-code` as reviewer, is refused when saved (create_project and update_project_settings) and at call time (hand-edited project.json). | New test in `tests/clientOnly.test.ts`: `createProject` with `reviewer: { models: ['deepseek/deepseek-chat'] }` rejects with `not free`; a project.json edited by hand to that reviewer fails its chunks with `client-only` and zero model calls. |
| AC-3 | Each reviewed chunk stores `qa.score` (model value, clamped/rounded; issue-derived when the reply has none) and `qa.model`; the project score is the mean over scored chunks and appears in `summarize`, `detail` and the `wait_for_progress` result. | New test in `tests/pipeline.test.ts`: mock QA answers `{"score":7,...}` for chunk 1 and `{"issues":[one major]}` (no score) for chunk 2 (fix pass then recheck without score); assert chunk files, `summarize(...).qa` (`score`, `scored: 2`, `models`, `independent`) and `service.detail(id).qa`. |
| AC-4 | The seed `acp` provider is on 8787; an existing data folder with the old seed URL gets 8787 once, a folder with its own URL keeps it, comments stay. | Update `tests/registry.test.ts:546-549` and `tests/dataFolder.test.ts:288` to 8787; one new case in `tests/dataFolder.test.ts` (two data folders: old URL rewritten and recorded, custom URL untouched and recorded; a second init changes nothing). |
| AC-5 | Build, typecheck, lint and the full suite are green. | Commands below. |
| AC-6 (manual, UNTESTED until run) | Live: with the proxy on 8787, a small client-only project with `reviewer: { models: ["acp/antigravity/gemini-3.8-flash"] }` gets QA answers from Gemini, `get_project` shows `qa.score` and `independent: true`, and the UI statline shows the score. | Run by hand through MCP (`yarn headless` or the app), report the result in `changelog.md`. |

## Verified build and test commands

PowerShell, from `C:\projects\Personal\book-translator` (verified 2026-11-09: Node v24.14.0, Yarn 4.18.1; build exit 0, 25 files / 364 tests passed, typecheck exit 0). Git Bash's `fnm exec --using default yarn` does not find yarn, so use PowerShell.

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
yarn build:engine
yarn typecheck
yarn lint
yarn test
```

`yarn test` prints `note: strata discovery failed (fetch failed)` when Strata is not running; that is expected. `yarn lint` was not run during research.

## Open choices for the user

1. **A data-folder default reviewer.** As planned, a reviewer is named per project (`create_project {clientOnly: true, reviewer: {...}}`). Option: a `clientOnlyReviewer` key in `config/defaults.json` that every new client-only project gets automatically (still free models only). Recommendation: per project only for now; add the key later if callers forget it.
2. **Where the score comes from.** As planned, the reviewer gives its own 0-10 grade, with an issue-based number (`10 - 3*major - minor`) only when it gives none. Option: always compute the score from the issues (reproducible, no prompt change, but a reviewer that finds nothing always gives 10). Recommendation: the reviewer's grade.
