---
status: in-progress
request: REQ-0027
repos: [book-translator]
branch: BTT-33_exact-edits-and-refresh-hint
updated: 2026-11-16
---

# BTT-33 Exact hand-edit counts in refresh_source, a create_project hint, and the wording

Follow-up to BTT-32 (`.claude/tickets/BTT-32-segment-reask-and-source-refresh/`). Master has BTT-31 and BTT-32 merged.

BTT-32's `refreshChunks` (`src/engine/project/refresh.ts`) guesses hand edits per chunk: in a chunk marked `edited`, every segment whose final text differs from the proofread or translated text counts, so a QA fix-pass rewrite counts as a hand edit; and `editedKept` counts kept chunks, while the messages say segments.

## Scope

1. **Per-segment hand-edit tracking.** `editChunk` records the segment ids whose text it changed in `ChunkRecord.editedSegs`, beside the chunk-level `edited`; every place that clears `edited` clears it too. `refreshChunks` uses it: `editsDropped` counts only hand-edited segments that were dropped (not fix-pass rewrites), `editedKept` counts kept hand-edited segments, and a kept chunk's `editedSegs` is re-keyed with its segment ids. A chunk without `editedSegs` (an older project) keeps today's guess (chunk `edited` and final differs from the translation). `RefreshResult` docs and the refresh message say segments.
2. **A `create_project` hint.** When `create_project` makes a new project for a source path and target language that an existing project already has with another file hash, the result carries `hint`, naming that project and `refresh_source`. The project is still created. Covers the service, the dispatcher result (`CreateProjectResult`), MCP (the result is passed through) and a toast in the New project view.
3. **Wording.** The refresh toast in `ProjectView.tsx`, the CLI usage and `index.ts` usage say "changed or removed", as the log does.

## Out of scope

- The CLI `engine translate` printing the hint.
- Clearing the chunk-level `edited` flag on a kept part of a split chunk that holds no hand edit.
- Any change to how blocks are matched or which chunks are kept.

## Acceptance

- `tests/refresh.test.ts`: a chunk with a hand edit and a QA fix-pass rewrite, where both segments' text changes or both stay: the fix-pass segment is not counted in `editsDropped`, and `editedKept` counts segments. It fails on master.
- One assertion in the closest create_project test: an edited source gives a new project whose result names the old project and `refresh_source`.
- `npx vitest run`, both `tsc --noEmit` configs and `npx eslint .` pass.
- ROADMAP.md entry, marked done on its branch. One commit per item, then one with the ticket folder.
