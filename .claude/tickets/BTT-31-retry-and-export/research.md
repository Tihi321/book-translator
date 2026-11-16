# BTT-31 research: retry on the next model, and export with failed chunks

Repo: `C:\projects\Personal\book-translator` (master at 205a9c5, "Merge BTT-30_parallel-style"). Read-only research; the live translation was not touched, nothing was run.

## Question

Two bugs from the hub's *Book 2 hr* run (project `the-automaton-who-confessed-hr-8e147b`):
- Bug 5: a chunk that fails on a segment mismatch is retried on the same model; the next model in the translator list is never tried.
- Bug 6: export neither refuses nor warns while chunks are failed (19 English paragraphs in the first hr export).

## Ticket id

- Style: branch `BTT-NN_<what>` (e.g. `BTT-30_parallel-style`, `BTT-29_kindle-svg-cover`), ticket folder `.claude/tickets/BTT-NN-<what>/` (**confirmed**: `git branch -a`, `ls .claude/tickets`).
- Highest used is BTT-30; no `BTT-31` or later appears in `ROADMAP.md` (**confirmed**: grep). Next free: **BTT-31**. Suggested branch `BTT-31_retry-and-export`. One ticket, two commits (one per bug).

## Answer

- Bug 5: the model fallback lives only in `ModelRouter.chat` and triggers only on provider errors (HTTP/timeouts/context). A segment mismatch is a successful reply that fails parsing in `translateChunk`, so the router never sees it, and each retry call re-sends the same list `[sonnet, argon]`, which resolves to sonnet first. Fix: after N mismatches on one model, ask the next model of the list.
- Bug 6: `EngineService.exportWithReport` (`src/engine/service.ts:519`) never looks at chunk states; `translations()` just leaves out blocks with no `final`, so those keep the source text, and the result carries no warning. A test even documents this as intended (`tests/pipeline.test.ts:333`). Fix: refuse when any chunk is `failed`, unless `allowPartial`; always add a warning for blocks left in the source language.

## Bug 5: retry stays on the same model

### Path through the code (confirmed)

- Per-role model list: `project.settings.agentModels[agent]`, ordered refs, "first is used, the rest are fallbacks" (`src/engine/mcp/server.ts:43`). The failed project had `translator: [acp/claude/claude-sonnet-5, acp/antigravity/gemini-4-argon]` (`project.json`).
- `ProjectRunner.makeCall` (`src/engine/pipeline/runner.ts:446-491`) builds `refs` = `agentModels[agent]`, with `this.translatorModel` (the `retry_chunk` `model` argument, set at `runner.ts:151`) moved to the front for the translator only (line 449). It calls `router.complete(refs, ...)`.
- `ModelRouter.chat` (`src/engine/models/router.ts:~125-215`) loops over the resolved models and falls to the next model only after a thrown `ProviderError` (unreachable, daily limit, context error, non-retryable or retries used up). A reply that arrives is returned as success.
- `translateChunk` (`src/engine/pipeline/translator.ts:97-156`), inner `attempt` (lines 135-151): two `ask` calls (task `translate`, then `retry` with a note). If both fail it logs "splitting the chunk in two" (line 144) and runs `attempt(half, false)` twice, each again with 2 calls and no further split; then throws `ChunkFailure` (line 150). `ask` (lines 71-80) calls `env.call('translator', ...)` with no information about which model already failed, so each call gets the same list and the same first model.
- Parse rules in `src/engine/pipeline/segments.ts:30-58`: `ok` only if every expected id is present exactly once and no extra id; a repeated id makes `ok` false even when all ids are there.
- `ChunkFailure` is caught in `runChunk` (`runner.ts:351-362`): state `failed`, error stored, logged.
- Manual recovery: `retry_chunk` -> `retryChunk(id, index, model)` (`src/engine/service.ts:336`) -> `start(id, {only, translatorModel})`. That is why gemini-4-argon succeeded on the first manual try.
- Evidence (confirmed, `log.md` of the project): chunk 37 had 4 mismatches, all on sonnet: `16:41:24` d17.4 missing, `16:43:16` d17.4 missing, then "splitting the chunk in two", `16:43:54` d17.5 missing, `16:44:34` d17.4 repeated, then failed. Chunk 37 has 25 segments (`chunks/0037.json`) and the final `model` is `acp/antigravity/gemini-4-argon`. Many other chunks (5, 8, 11, 12, 19, 22, 23, 27, 32) also logged mismatches, so the cost of "sonnet tries twice before a split" is paid on a lot of chunks.

### Root cause

`attempt` in `src/engine/pipeline/translator.ts:135-151` has no notion of "this model already failed"; the fallback list is only consulted by the router for transport errors. Neither the second call, the split halves, nor a later run of the same chunk change the model.

### Proposed fix (option A, recommended)

1. `CallRequest` (`src/engine/pipeline/env.ts:5`) gets an optional `skipModels?: string[]` (refs already tried for this piece of work).
2. `makeCall` (`runner.ts:446`): after computing `refs`, `refs = refs.filter(r => !skip.has(registry.resolve(r)))`; if that empties the list, use the full list (never run out of models; a client-only project has a single `client/...` ref, so it behaves as today). Compare resolved refs, because `ModelInfo.ref` (what `CallResult.model` returns, `runner.ts:490`) may differ from an alias in the list.
3. `ask`/`attempt` in `translator.ts`: keep a `tried: string[]` for the chunk. Call `ask` with `skipModels: failedModels` and take the model from the call result (needs `ask` to return `{ parse, model }`). After `MISMATCHES_PER_MODEL` (const, 2, which is today's retry behaviour) failures on one model, add it to `failedModels` and keep going on the next model in the list with a fresh note. Order: model A twice, model B twice, only then split (halves start again from the first model of the list, or with the model that did best; the chunk 37 case shows a split on the same model does not help). Optional cheaper variant: N=1 per model (A once, B once, then A/B with a note).
4. Log each switch: `chunk-37: segment mismatch twice on acp/claude/..., trying acp/antigravity/...` so the run log shows it. `chunk.model` already records the last model that answered (`runner.ts:488`).
5. Keep `translatorModel` (manual `retry_chunk model`) as the first entry of the list; it just seeds the order.

Option B (additional, optional, separate commit): keep the segments that did parse. In chunk 37, 24 of 25 segments were fine; only d17.4 was missing/duplicated. `parseSegments` already returns the valid `segments` map; `attempt` could store the valid ones in `out` and ask again only for the missing ones, and treat a repeated id as `first wins` when all ids are there. Cheaper and fewer tokens, but riskier: a model that drifted may have mis-aligned the segments. Not needed for the fix.

### Risk

- Shared code: `translateChunk` is used by the engine pipeline only (`runner.ts:393`); `proofreader`/`qa`/`fix` use their own calls and are untouched. The `CallRequest` field is optional, so other callers are unchanged.
- More calls and cost: up to 2 models x 2 calls before the split (was 2 calls). Free ACP models, so low; with paid models the first `translate` call of the second model costs a full chunk.
- Style mix: a chunk can end up translated by the second model (BTT-30 added a dialogue-style check; same typography rule goes in every prompt, so low).
- Parallel workers: the skip list is local to one chunk's `attempt`, no shared state. Provider concurrency limits still apply through the router.
- A one-model list: nothing to rotate to; behaviour unchanged (retry, split, fail).

### Tests

Add to `tests/pipeline.test.ts`, `describe('translator retries')` (rig/mocks in `tests/pipelineHelpers.ts`; `r.create({ agentModels })` can override with `translator: [MODEL, QA_MODEL]`, both registered in the mock provider):
- **Fails before the fix:** mock translator answers `garbage` (or drops a segment) for `req.model === 'mock-translator'` on `chunk-2`, echoes for the other model. Expect: project `done`, chunk 2 `done`, `chunk.model` = `mock/mock-reviewer`, and the call sequence for `chunk-2` is `[A translate, A retry, B translate]` with no split. Before the fix the chunk fails (all calls go to A).
- A list of one model keeps the old sequence: the existing test at `tests/pipeline.test.ts:304` (`['translate','retry','translate','translate']`) must still pass unchanged.
- Both models mismatching ends in the split and then `failed` with the existing error text (existing test at line 320 stays valid; check the call count is now bounded).
- The `makeCall` filter when everything is skipped falls back to the full list (unit-level, or covered by the previous case).

## Bug 6: export with failed chunks

### Path through the code (confirmed)

- Entry points that reach `EngineService.exportWithReport` (`src/engine/service.ts:519`): MCP `export_project` (`src/engine/mcp/server.ts:284`) -> dispatcher `case 'export'` (`src/engine/dispatcher.ts:731`); the app's Export and Read buttons (`src/renderer/ui/ProjectView.tsx:131-146`); CLI `engine export` (`src/engine/cli.ts:191`); and the end of CLI `translate` (`src/engine/cli.ts:170`). Protocol: `{ type: 'export', projectId, outPath?, cover? }` (`src/shared/protocol.ts:330`).
- `exportWithReport` loads the project and IR, calls `this.translations(id)` (`service.ts:487-508`) and passes the map to the adapter (`service.ts:553`; pack path at line 542). `translations()` includes only blocks with a `chunk.final[seg.id]`; every other block keeps the source text ("Blocks without a (complete) translation are left out, so they keep the source text", line 486). No look at `chunk.state`, no count of what was left out.
- `warnings` exist: `ExportReport.warnings` (line 565), collected by `onWarning` (lines 536-540), returned by the dispatcher as `warnings` only when non-empty (`dispatcher.ts:732-741`), printed by the CLI as `note:` (`cli.ts:180`). The MCP tool passes the result through. The UI ignores `warnings` (`ProjectView.tsx:136`: toast shows only the path). Nothing adds a warning for untranslated or failed chunks.
- The MCP tool description says "partial progress works: untranslated blocks keep the source text" (`server.ts:284`), and a test asserts it (`tests/pipeline.test.ts:333-337`, failed chunk 3 exported with its source text); pause then partial export is also tested (`pipeline.test.ts:158-190`). So partial export is intended; the missing piece is that failed chunks are silent.
- `project.status` after a run: `incomplete` while chunks remain, `done` only when none (`service.ts:470-472` for the client path; the runner sets it similarly), so `status` is an unreliable guard by itself (a run can end with failed chunks); use chunk states (`TODO_STATES`/`IN_PROGRESS_STATES` helper exist, used at `service.ts:470`).

### Root cause

`exportWithReport` has no check of chunk states and no report of blocks left in the source language; `translations()` silently skips them.

### Proposed fix

1. Add `allowPartial?: boolean` to the export options (`exportWithReport(id, outPath, { cover, allowPartial })`), to the protocol command (`shared/protocol.ts:330`), the dispatcher (`dispatcher.ts:732`), and the MCP tool schema (`server.ts:284`, `allowPartial: z.boolean().optional()` with a description), plus CLI `--allow-partial`.
2. At the start of `exportWithReport`, read the chunks (`store.listChunks`). If any chunk is `failed` and not `allowPartial`, throw an error like: `export refused: 1 chunk failed (37: the model did not return the segments correctly ...), so 19 block(s) would stay in English. Retry them with retry_chunk (optionally model: "<next model>"), or export with allowPartial true.` (Check how the dispatcher turns a thrown Error into the MCP error result, so the message reaches the client as is.)
3. Whenever blocks stay untranslated (failed, pending or in progress chunks, or allowPartial), add a warning through `onWarning`: `19 block(s) in chunks 37 stay in the source language (failed)`; compute from the chunk states and `translations()` (count blocks of non-done chunks). This gives the visible warning in the MCP result, the CLI and `log.md` for pause-and-export too, without refusing it. Decision to confirm: refuse only for `failed` (recommended, a paused or running project is a deliberate partial export), or also for `pending` (stricter).
4. UI (`ProjectView.tsx:131-146`): the request now can reject; the existing `attempt()` presumably toasts errors. Show `res.warnings` in the toast and offer "Export anyway" (sends `allowPartial: true`) when refused. Minimum for the ticket: the refusal message appears as an error toast; the warnings show in the toast.
5. CLI `translate` (`cli.ts:170`): passes `allowPartial: true` (exit code already 1 when not done, and the `note:` warning prints), so it still writes the file and says what is missing.
6. Docs: update the MCP tool description, README line 84 and the `export` mention in the MCP instructions (`server.ts:26`, `:28`) to say failed chunks refuse the export unless `allowPartial`.

### Risk

- Behaviour change for MCP clients and scripts that export with failed chunks (the hub's production flow `make-visual-novel`/translate skills). They now get an error and must retry or pass `allowPartial`. Search the hub's skills and scripts for `export_project` after the change. Intended.
- The existing test at `tests/pipeline.test.ts:333` must change: expect refusal, then export with `allowPartial: true` containing the source text and the warning.
- Pack (`vnp`) exports at `service.ts:541-545` return early; the guard must be before that branch so packs are covered, and the warning goes into that report too.
- UI: the Read button (`readTranslation`) also exports; with a refusal it would open nothing. Use `allowPartial: true` there with the warning shown, or show the same error.
- Client-only and "translator mode" projects (the MCP `get_translation_task` path) mark chunks differently (pending until submitted); the guard on `failed` does not affect them, but the warning count must handle `pending`.

### Tests

In `tests/pipeline.test.ts` (rig):
- **Fails before the fix:** make chunk 3 fail (the existing `'garbage'` mock, test at line 320); `r.service.exportWithReport(id)` rejects with `/failed/` and does not write the file; `exportWithReport(id, undefined, { allowPartial: true })` resolves, the file contains the source text of the failed chunk, and `report.warnings` has one entry naming chunk 3 and the block count. Before the fix it resolves with `warnings: []`.
- After `retryChunk` succeeds, export resolves without warnings.
- A paused project (the test at line 158) still exports partial progress, now with a warning listing the unfinished chunks, no refusal.
- `tests/mcp.test.ts`: `export_project` returns an error for a project with a failed chunk, and works with `allowPartial: true` (one case).

## What the plan needs (summary)

Files: `src/engine/pipeline/translator.ts`, `env.ts`, `runner.ts` (bug 5); `src/engine/service.ts`, `dispatcher.ts`, `src/shared/protocol.ts`, `src/engine/mcp/server.ts`, `cli.ts`, `src/renderer/ui/ProjectView.tsx`, README (bug 6); tests in `tests/pipeline.test.ts` and `tests/mcp.test.ts`. Typecheck and lint with the existing scripts (unit tests only; not run now because the live run is using the app).

## Open questions

- Which count of mismatches per model (2 as today, or 1) and whether the split goes before or after the model switch; recommended: switch first, split last (chunk 37 evidence).
- Refuse only on `failed`, or also on `pending`/in-progress chunks (recommended: failed only, warn for the rest).
- Whether the UI gets an "Export anyway" dialog in this ticket or only the error toast (UI not verified here; no renderer test run).
- Why sonnet repeats or drops one segment (d17.4 is an ordinary 400-char paragraph; `d17.t` and `d17.1` have identical text, which might confuse the model): not investigated; the model rotation does not depend on it. Whether the router's `registry.resolve` of an ACP ref returns the same string as the list entry was not checked (inferred equal; verify in `src/engine/models/registry.ts` when implementing).
- Not reproduced: no test or run was executed (the live translation must not be disturbed). The causes come from reading the code and the project's `log.md`.
