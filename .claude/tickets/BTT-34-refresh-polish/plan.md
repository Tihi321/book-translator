---
status: done
request: REQ-0028
repos: [book-translator]
branch: BTT-34_refresh-polish
updated: 2026-11-16
---

# BTT-34 refresh_source polish: name the dropped edits, the CLI hint, the edited badge, the wait cap

Follow-up to BTT-32 and BTT-33 (`.claude/tickets/BTT-32-segment-reask-and-source-refresh/`, `.claude/tickets/BTT-33-exact-edits-and-refresh-hint/`). Master has BTT-33 merged.

## Scope

1. **Name the dropped segments.** `RefreshResult.droppedEdits: Array<{ chunk, segment, text }>`, at most 20 entries: `chunk` is the old chunk index, `segment` the old segment id, `text` the old hand-edited final cut to about 160 characters. `editsDropped` stays the count. `refreshChunks` fills it; the unchanged and no-chunks paths of `service.refreshSource` give `[]`. The log line names the first few (short), the CLI `engine refresh` prints one line each, the Refresh source toast shows the first few and "see the log". The MCP result carries it (the dispatcher result is passed through); the `refresh_source` description names it.
2. **The CLI translate prints the create_project hint.** `engine translate` prints `note: <hint>` when `createProject` returns BTT-33's `hint`.
3. **Clear the edited badge.** In `keptChunk`, a kept part of a split chunk (not the whole old chunk) whose re-keyed `editedSegs` is empty gets `edited: false`, so it shows no "edited" badge. A chunk without `editedSegs` keeps today's behaviour, and so does a whole kept chunk.
4. **The wait_for_progress timeout.** The 60 s cap (`MAX_WAIT_SEC`) is deliberate (BTT-20: the MCP client's default request timeout is 60 s), and the parameter is `timeoutSec` in seconds; an unknown key such as `timeoutMs` is stripped by the schema, so the call waited the 25 s default. Keep the cap; the tool description and the `timeoutSec` schema say seconds, the default, the maximum and why, and to call again; the result carries `waitedMs`, the time the call actually waited.

## Out of scope

- Accepting `timeoutMs` as an alias, or refusing unknown keys.
- Any change to how blocks are matched or which chunks are kept.
- Changing the 60 s cap.

## Acceptance

- `tests/refresh.test.ts`: the moved/changed case asserts `droppedEdits` (chunk, segment, text); a case that splits a kept chunk asserts the part with no hand edit has `edited: false` and the part with one keeps `edited: true`. Both fail on master.
- `tests/mcp.test.ts`: the slow-chunk wait asserts `waitedMs`.
- `npx vitest run`, both `tsc --noEmit` configs and `npx eslint .` pass.
- ROADMAP.md entry, marked done on its branch. One commit per item, then one with the ticket folder.
