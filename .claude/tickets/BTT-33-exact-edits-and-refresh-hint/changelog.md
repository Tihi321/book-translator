# BTT-33 changelog

Branch `BTT-33_exact-edits-and-refresh-hint`, cut from master `9528df0`, not merged.

Item 1, per-segment hand edits (commit e2cebf1):
- `shared/project.ts`: `ChunkRecord.editedSegs`. `service.editChunk` adds the ids whose final text it changed (in segment order); every place that clears `edited` clears it (`runner.ts` resetChunk, parkChunk, processChunk; `service.ts` submitTranslation).
- `project/refresh.ts`: `isHandEdit` uses `editedSegs`, and without it keeps BTT-32's guess (chunk `edited`, final differs from proofread or translation). `editsDropped` and `editedKept` both count segments; `keptChunk` re-keys `editedSegs`.
- Decision: for an old chunk without `editedSegs`, `editedKept` uses the same per-segment guess as `editsDropped` (not a count of chunks), so the number is always segments.
- `RefreshResult.editedKept` doc, the refresh log ("hand-edited segment(s)"), the CLI ("hand-edited segments kept").
- Tests: new case in `refresh.test.ts` (fails on master: editsDropped 1, editedKept 2; expected 0 and 3). The repeat-alignment case had no real hand edit (final equal to the translation) and asserted a chunk count: its translation of `o4` now differs, so it still asserts `editedKept: 1`.

Item 2, the create_project hint (commit 9631573):
- `shared/protocol.ts`: `CreateProjectResult` (`ProjectSummary` + `hint?`), the `createProject` response type.
- `service.createProject`: after making a new project, `editedSourceHint` looks for another project with the same resolved source path (case-insensitive on Windows) and target language (code, else name) and another hash; the hint names it, refresh_source, the app's Refresh source and `engine refresh`.
- MCP `create_project` description; `NewProject.tsx` toasts the hint (single file and batch) with the warning-style toast.
- Test: one assertion in the first `refresh.test.ts` case (fails without the service change).

Item 3, wording (commit 3c54fcc): `ProjectView.tsx` refresh toast, `cli.ts` refresh usage, `index.ts` usage say "changed or removed".

Checks after each commit: `npx vitest run` 399 passed, `tsc --noEmit` node and web clean, `npx eslint .` clean.
UNTESTED: the toasts in the app, the CLI output. The app was not started.
