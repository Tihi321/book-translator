# BTT-26 changelog

## 2026-11-09 BTT-26: independent QA reviewer for client-only projects, a QA score, ACP port 8787

Branch `BTT-26_independent-qa` (from `master` e9e374c), repo book-translator.

### Changes
- `src/shared/project.ts`: `ReviewerSettings`, `ProjectSettings.reviewer`, `reviewerAgents()`, `QaScore`; `ChunkRecord.qa` gains `score`, `model`; `ProjectSummary.qa`.
- `src/engine/project/store.ts`: `mergeSettings` puts `reviewer.models` on `qa` (and `proofreader` with `proofread`) after the client-only overwrite; a patch replaces `reviewer` whole.
- `src/engine/service.ts`, `src/engine/dispatcher.ts`: `checkReviewer` (only `client/` models other than `client/claude-code`, or models of a local provider) on `createProject` (new and existing project) and `updateProjectSettings`; `detail().qa`, `ChunkBrief.qaScore`.
- `src/engine/models/registry.ts` (`isLocalRef`), `src/engine/models/router.ts` (`RoutedRequest.exact`), `src/engine/pipeline/runner.ts` (`makeCall`): a client-only project allows a non-client ref only for a reviewer agent with a listed, local reviewer model, and always calls with exact lists (no shared fallback rows). A refused ref throws the existing `client-only` error.
- `src/engine/pipeline/qa.ts`, `llm.ts`, `env.ts`, `runner.ts` (`processChunk`): QA reply `score` (clamped 0..10, one decimal; numeric strings accepted); without one, `10 - 3*major - minor`; the model that answered is stored; no score when the QA model gave no usable answer. A score request is appended to the user message when the loaded prompt lacks `"score"`.
- `src/engine/project/summary.ts`: `qaScoreOf`, `qaScoreLine`; `summarize().qa`.
- `src/engine/mcp/server.ts`: `reviewer` on `create_project` and `update_project_settings`; `qa` in `wait_for_progress`; instructions and prompt text. `get_project` returns `qa` through `detail`.
- `src/engine/cli.ts`: `engine status` prints `qa score: ...`.
- `src/renderer/ui/ProjectView.tsx`: statline `QA n/10` (tooltip: scored x of y by models, self-reviewed), tile tooltip `, QA n`.
- `seed/prompts/qa.md`: reply format with `score`.
- ACP port 8787: `seed/config/providers.md`, `CustomProviderForm.tsx`, README, tests; `src/engine/store/migrate.ts` `migrateAcpPort` (`acp-port-8787-v1`) called from `dataFolder.ts` after `migrateStrataLoaded`: rewrites only the exact old seed value `http://127.0.0.1:7461/v1`, in place.
- README (QA line, client-only paragraph, project files, tools), ROADMAP (new BTT-26 row; the BTT-21 history row keeps 7461).
- Tests: 4 new (clientOnly x2, pipeline x1, dataFolder x1), `tests/registry.test.ts` and `tests/dataFolder.test.ts` assertions moved to 8787, `tests/store.test.ts` fixtures gain `qa`.

### Decisions (user, 2026-11-09)
Reviewer per project only (no `defaults.json` key). Score = the reviewer's own 0-10 grade, fallback `10 - 3*major - minor`. Port 8787 everywhere.

### Deviations
- AC-2 call-time part: a hand-edited paid reviewer does not fail the chunks. `reviewChunk` already turns any QA call error into a warning and keeps the deterministic checks, so the chunk finishes, the log has the `client-only` refusal, and zero model calls / fetches happen. The test asserts that.
- One commit for the code, docs and ticket folder instead of one per task (shared files across T1-T3).
- `tests/registry.test.ts` line 495 (a custom-provider fixture with its own URL) was left on 7461.

### Verification
PowerShell, from the repo: `yarn typecheck` exit 0; `yarn lint` exit 0; `yarn build:engine` exit 0; `yarn test` 25 files, 368 tests passed (364 before).

AC-1 passed (test), AC-2 passed (test, see deviation), AC-3 passed (test), AC-4 passed (test), AC-5 passed.

AC-6 (live, run by hand): the ACP proxy answered on `http://127.0.0.1:8787/v1/models`. A throwaway engine (in-process `EngineService`, temp data folder under `.claude/temp`, since deleted) ran a 3-block source with `clientOnly: true`, `reviewer.models: ["acp/antigravity/gemini-3.8-flash"]`, the `acp` provider enabled, glossary and proofreader off. Client tasks (translation) were answered by the harness with a hand-written Croatian text. Result: chunk `done`, `qa = { issues: [], score: 10, model: "acp/antigravity/gemini-3.8-flash" }`, translator model `client/claude-code`, so the review was independent; spend 0. A first run with the model not yet discovered showed the "reviewer down" path: `QA model gave no usable answer (no available model in: acp/antigravity/gemini-3.8-flash); deterministic checks only`, no other model called.
UNTESTED: the UI statline in the running app; `get_project` / `wait_for_progress` output through a real MCP client (covered by service-level tests only); the packaged headless build; the migration on the live data folder `C:/Users/Infplane/BookTranslator` (runs at its next engine start).

### Follow-ups
- The data folder's `prompts/qa.md` is the user's file and is not rewritten; the engine adds the score request itself while that file lacks `"score"`.
- Open: a `clientOnlyReviewer` default in `config/defaults.json` (decided against for now).

### Commit status
Committed on `BTT-26_independent-qa`, not pushed.

## Polish round 1

From the checker's findings (REQ-0005).
- A hand-edited reviewer that a client-only project refuses at call time (paid, not local, or `client/claude-code`) now ends the chunk `flagged` with `error` = `reviewer <ref> refused: not free in a client-only project ...` and no score (before: `done`, only a log line). `ClientOnlyRefusal` (`env.ts`) is thrown by `makeCall`; `reviewChunk` returns it as `refused`; `processChunk` sets `chunk.error` and the state. Other QA failures (reviewer down, bad JSON) stay a warning, as AC-1 requires.
- Call-time guard: for a reviewer agent only refs listed in `reviewer.models` that are not `client/claude-code` and are a `client/` model or a local provider's model pass; other agents still allow only `client/` refs.
- UI live score: `project.updated` now copies `qa` into the open detail; `chunk.state` carries `qaScore` (protocol, runner, renderer store).
- Chunk planning (`budgetFor`, `workerCount`, `glossaryStage`) resolves with `exact` for client-only projects.
- `score: null` in a QA reply is accepted as no score (`nullish()`), no repair round.
- README (call-time refusal and flagged reason; qa/proofreader stay on the reviewer models when a reviewer is set), ROADMAP (a failed QA has no score).
- Tests (no new ones): the AC-2 test asserts flagged + reason and the `client/claude-code` hand-edit; the score test uses an old-style prompt without "score" (asserts the `## Score` request, score stored) and a `score: null` reply.
- Verification: build, typecheck, lint exit 0; `yarn test` 25 files, 368 tests passed. UNTESTED: the live UI statline update in the running app.
