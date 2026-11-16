# BTT-32 changelog

Branch `BTT-32_segment-reask-and-source-refresh`, three commits, not merged.

Feature 1, re-ask (commit 1):
- `pipeline/segments.ts`: `SegmentParse.conflicting`, `salvage()` (limits `max(2, ceil(n / 4))`, never when an id was not asked for).
- `pipeline/translator.ts`: `MAX_REASKS = 2`, `translatorUserContent` `style.next` ("Following passage"), `ask` takes a context override, the `reask` step in `attempt` (logged), then BTT-31's retry, rotation and split unchanged.
- `service.ts`: the client-submission parse gets `conflicting: []`. `mcp/server.ts`: `reask` in the `get_client_task` task example. README sentence. ROADMAP entry.
- Tests: R1 in `agents.test.ts` (fails before the change: ChunkFailure at the await), S1 in `segments.test.ts`; `withStray` helper and four mocks in `pipeline.test.ts` made unsalvageable so they keep proving the full retry, rotation and split.

Feature 2, refresh_source (commit 2):
- New `project/refresh.ts` (`refreshChunks`, `translatableBlocks`), `chunker.ts` `packSegments` (used by `planChunks`), `store.replaceSource` (backup to `refresh-backup/<time>/`, `chunks.next` swapped in).
- `service.refreshSource`, the export source check (`SOURCE_CHANGED`, before the untranslated guard, also with `allowPartial`, formats epub/docx/txt/md/pdf, skipped when the source file is missing), protocol command and `RefreshResult`, dispatcher case, MCP tool `refresh_source` (+ INSTRUCTIONS, `export_project` description), CLI `engine refresh`, UI Refresh source row, `exportFor` toasts a source refusal without "Export anyway". README.
- Tests: `refresh.test.ts` (R2, all eight steps), `refresh_source` in the `mcp.test.ts` tool list. No existing export test needed a change for the source check.
- Deviation: with no old chunks the report counts blocks directly (no re-chunk); with no chunks after a refresh the project status stays as it was.

Feature 3, typography fields (commit 3):
- `typography.ts` `languageDefault`, `ProjectDetail.typographyDefault`, `detail()`, `mergeSettings` clears `''` typography fields, the settings tab fields (dialogue select, quote marks, notes), the hint and the inconsistency warning.
- Test: two assertions added to the typography test in `dispatcher.test.ts` (it sets dialogue back to dash afterwards so the later assertions are unchanged).
- ROADMAP entry changed to the done wording.

Checks: `yarn test` 396 passed, `yarn typecheck` (node and web) and `yarn lint` clean after each commit.
UNTESTED: live checks L1-L5 (re-ask on chunk 37 of book 2, `refresh_source` on book 3's project, the Refresh source row and export refusal toast, the settings tab fields, the CLI). Nothing was started or built.
