---
status: in-progress
request: REQ-0006
repos: [book-translator]
branch: BTT-28_post-run-fixes
updated: 2026-11-10
---

# BTT-28 Post-run fixes (REQ-0006 task C1)

Input: the REQ-0006 `discoveries.md` (scriptorium repo, `.claude/tickets/REQ-0006-destiny-hr-translation/`) and BTT-26 `discoveries.md` items 1-2. Master `be5ecb9`.

## Done when
1. A pause keeps translator (and proofreader) answers already accepted; the resume skips those stages (test fails before, passes after).
2. `edit_chunk` keeps the chunk's QA score and model with `edited: true`; the project score does not drop.
3. A reviewer `tags` issue is dropped when the deterministic tag check finds the tags match the source.
4. `release_client_task {}` releases every leased task.
5. `create_project` takes `pauseAfterGlossary`.
6. `qa.independent` is true before any chunk is scored when a reviewer is set for QA.
7. MCP `shutdown` (headless engine): pauses running projects, closes the server, removes `engine.lock`, exits. Documented.
8. Glossary check: stems per word (4-letter words, k/g/h to c/z/s); no glossary check in link/reference-list segments.
9. UI: statline QA score follows each `chunk.state`; a retried/refused chunk's tile score resets.
10. README: `dc:subject` stays in the source language by design.

## Deferred (not built)
- `estimate_project` MCP tool; per-row "noun only" glossary option (see discoveries.md).
