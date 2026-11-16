# BTT-34 changelog

Branch `BTT-34_refresh-polish`, cut from master `5f8a8b1`, not merged.

Item 1, name the dropped segments (commit 0eb81da):
- `shared/protocol.ts`: `RefreshResult.droppedEdits: Array<{ chunk, segment, text }>`; `editsDropped` stays the count.
- `project/refresh.ts`: `refreshChunks` collects the dropped hand edits (old chunk index, old segment id, old final), lists the first 20 (`MAX_DROPPED_LISTED`) with the text cut to 160 characters (`DROPPED_TEXT_CHARS`, exported `cut`).
- `service.refreshSource`: `[]` on the unchanged and no-chunks paths; the log line names the first five (`chunk N id "text cut to 40"`, then "N more").
- `cli.ts` `engine refresh`: one line per entry, then "N more" when the list was capped. `ProjectView.tsx` toast: the first three, then "see the log". MCP: the dispatcher result passes through; the `refresh_source` description names the field.
- Test: the moved/changed case in `refresh.test.ts` asserts `droppedEdits: [{ chunk: 1, segment: 'o4', text: 'DELTA-EDIT' }]`. On master: fails (no `droppedEdits` in the report).

Item 2, the CLI hint (commit 92eee00): `engine translate` prints `note: <hint>` after the project line when `createProject` returns one. No test (CLI text).

Item 3, the edited badge (commit 8468b7e):
- `keptChunk`: a kept part that is not the whole old chunk and whose re-keyed `editedSegs` is empty gets `edited: false`. A whole kept chunk and a chunk without `editedSegs` keep `edited` as before.
- Test: the BTT-33 editedSegs case now has hand edits only on o3 and o4 (o1 untouched); refreshing with o2 changed splits the chunk into n1 (kept), n2 (pending), n3+n4 (kept), and the test asserts `n1:false`, `n3+n4:true`; `editedKept` is 2 and `editedSegs` `['n3','n4']`. On master: fails with `n1:true`.

Item 4, wait_for_progress (commit 17c8879):
- Finding: the cap is `MAX_WAIT_SEC = 60` in `mcp/server.ts`, deliberate since BTT-20 (the MCP client's default request timeout is 60 s). The parameter is `timeoutSec`; zod strips an unknown `timeoutMs` key, so a call with `timeoutMs: 600000` waited the 25 s default and returned `timedOut: true`.
- Kept the cap. The tool description and the `timeoutSec` schema say seconds (not ms), default 25, at most 60, why, and to call again. The result carries `waitedMs` (a few ms when it returns at once).
- Test: the slow-chunk wait in `mcp.test.ts` asserts `waitedMs` is above 0 and no more than the call took. The existing check that `timeoutSec: 61` is refused covers the cap.

Checks after the last code commit: `npx vitest run` 399 passed (27 files), `tsc --noEmit` node and web clean, `npx eslint .` clean.
UNTESTED: the toast in the app and the CLI output of `engine refresh` and `engine translate`. The app was not started.
