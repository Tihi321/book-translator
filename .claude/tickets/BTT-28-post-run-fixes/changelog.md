# BTT-28 changelog

## 2026-11-10 BTT-28: post-run fixes

Branch `BTT-28_post-run-fixes` (from `master` be5ecb9), repo book-translator. Request REQ-0006 task C1.

### Changes
- `src/engine/pipeline/runner.ts`: `parkChunk` replaces the reset on pause/cancel. A chunk stopped during proofreading, review or fixing goes back to `pending` with its translation (and the proofread text once that stage finished) in the chunk file; `processChunk` resumes after them. `planProjectChunks` does not re-plan chunks that hold a translation.
- `src/engine/service.ts`, `src/shared/project.ts`: `editChunk` keeps `qa.score`/`qa.model` and sets `qa.edited: true` (issues cleared); its `chunk.state` event carries `qaScore`.
- `src/engine/pipeline/qa.ts`: a reviewer `tags` issue is dropped when `validateTags` passes; `isCitation` skips glossary checks in link/reference segments.
- `src/engine/pipeline/glossary.ts`: `hasTarget` stems words of 4+ letters by one letter and accepts k/g/h to c/z/s.
- `src/engine/dispatcher.ts`, `src/engine/mcp/server.ts`: `release_client_task` with no filter releases every leased task; `create_project` takes `pauseAfterGlossary`; new `shutdown` tool.
- `src/engine/mcp/controller.ts`, `src/engine/serve.ts`: `onShutdown` hook; `headless` wires it to its Ctrl+C shutdown (pause, close server, remove lock).
- `src/engine/project/summary.ts` (+ callers in service, mcp server, cli): `qaScoreOf(chunks, settings)` gives `independent: true` before any score when a reviewer is set for QA.
- `src/renderer/store/store.ts`: the statline QA score is recomputed from the tiles on each `chunk.state`; an event without `qaScore` clears the tile score.
- `README.md`: `shutdown`, `release_client_task` wording, pause keeps accepted answers, `dc:subject` stays in the source language.
- Tests (6 new): pipeline (pause keeps translation, edit keeps score), agents (glossary stems and citation, tags overrule), mcp (shutdown, create_project pauseAfterGlossary), clientOnly (independent before scoring), client (release with no args), store (statline and tile score).

### Verification
`yarn test`: 25 files, 380 tests pass (374 before). `yarn typecheck` and `yarn lint`: clean. The pause test fails with the runner.ts change reverted.

## Polish round 1 (checker findings)

- `runner.ts` (`parkChunk`, `processChunk`), `translator.ts` (`translateChunk`): a pause during the translator keeps the accepted segments (first half of a split, finished retry, retry-tags result) in `chunk.translation`; the resume asks only for the missing ids and re-derives the kept segments' `tags` issues. A segment with bad tags is stored only once its retry settled, so a stop in between asks for it again. A fix pass in progress is still re-run. README and the `shutdown` tool description say so.
- `glossary.ts` (`hasTarget`): the stem must start a word (`Edip` is not in `jedini`, `ariš` not in `Stari`); the palatal map works both ways (k/c, g/z, h/s), so target `stoici` matches `stoika`; comment fixed.
- `tests/client.test.ts`: the release-all check leases a task first and expects `released: 1`.
- `mcp/server.ts`, `serve.ts`: an `onShutdown` failure is emitted as an `error` event (stderr log in headless); `headless` shutdown reports a failed stop and ends the process with exit code 1, because a half-stopped engine with the server socket open and no usable lock must not stay up (a stale lock of a dead pid is reclaimed at the next start).
- Tests: pipeline (pause inside the translator keeps the first half, 4-segment chunk), glossary (one table test, 5 rows), agents (real row `Stoics -> stoici`). Each new test fails with the src changes stashed.
- Verification: `yarn test` 25 files, 386 tests pass; typecheck and lint clean.
