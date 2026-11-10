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
