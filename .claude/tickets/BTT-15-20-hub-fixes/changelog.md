# BTT-15 to BTT-20 changelog

## 2026-10-23: the findings of the hub's HUB-02 and HUB-05 runs fixed

Branch `BTT-15-20_fixes` (from master 9c36c1a), one commit per ticket. Committed, not pushed.

| Ticket | Commit | Files | What changed |
|---|---|---|---|
| BTT-15 | 4cdd689 | `src/engine/pipeline/qa.ts`, `src/engine/formats/inline.ts`, `tests/agents.test.ts` | The "untranslated" check counts only words outside inline tags (`textOutsideTags`), so a kept VN line like `<1>INÈS (angry):</1> Basszus.` is not flagged; glossary keep rows (source = target) are taken out before counting. |
| BTT-16 | 98f57f8 | `src/engine/pipeline/glossary.ts`, `src/engine/pipeline/runner.ts`, `tests/glossary.test.ts`, `tests/pipeline.test.ts` | The glossary pass merges into the user's brief (`mergeBriefText`): the user's text stays verbatim; a field (Genre, Tone, Register, Narrator, Address) or character is appended only if the text never mentions it. |
| BTT-17 | cd99ad4 | `src/engine/pipeline/glossary.ts`, `src/engine/pipeline/qa.ts`, `tests/glossary.test.ts`, `tests/agents.test.ts` | Glossary entries match as Unicode whole words (phrases across any whitespace). QA's glossary check accepts inflected targets: each target word's stem (minus 2 letters at 7+, minus 1 at 5-6) must be in the translation. |
| BTT-18 | 5450b90 | `src/engine/publish/cover.ts` (new), `src/engine/formats/epub.ts`, `src/shared/ir.ts`, `src/shared/protocol.ts`, `src/engine/service.ts`, `src/engine/dispatcher.ts`, `src/engine/mcp/server.ts`, `src/engine/cli.ts`, `src/engine/index.ts`, `tests/epub.test.ts` | EPUB cover alt text is "<word for cover>: <translated title>" (just the title for an unknown language). `export_project {cover: "title"}` / `--cover title` writes a generated SVG title-page cover (`translated-cover.svg`) and makes it the cover; the default stays the source cover. |
| BTT-19 | 4cbd198 | `src/engine/store/lock.ts`, `tests/lock.test.ts` | `engine.lock` holds `pid`, start time and process name. A live pid is the engine only if its start time matches (10 s); an old lock without one needs a Book Translator, Node or Electron process name. Unknown: the lock is respected. |
| BTT-20 | 8d8e1c6 | `src/engine/models/client.ts`, `src/engine/mcp/server.ts`, `src/engine/dispatcher.ts`, `src/shared/protocol.ts`, `src/shared/project.ts`, `src/engine/pipeline/runner.ts`, `src/engine/cli.ts`, `src/renderer/ui/ProjectSettingsTab.tsx`, `tests/client.test.ts`, `tests/pipeline.test.ts` | `wait_for_progress {role}` filter (cap stays 60 s). Leases default to 10 min (was 30), `get_client_task {leaseMinutes}` (1-60), a refused submit renews the lease, `release_client_task {project?, role?}` without a task id frees every matching lease. New project setting `fixMinorIssues` (default off, also a settings checkbox) sends minor QA issues to the fixer; minors are listed in `wait_for_progress` and `engine status`. |
| docs | fd72d6b | `ROADMAP.md`, `README.md`, this ticket's `plan.md` | BTT-15 to BTT-20 done; "Where it stands" corrected (BTT-08 to BTT-14 merged); README describes the new options. |

## Deviations

- BTT-15: the brief's "kept as is" rule is free text and is not parsed; a glossary keep row silences a line.
- BTT-18: no UI control (the app has no export-options dialog). The source PNG stays in the package, no longer marked as the cover.
- BTT-20: the MCP endpoint is stateless (no session to watch closing), so shorter leases with renewal and release-by-project replace "release on session close".

## Verification

- Run: `yarn test` (24 files, 313 tests), `yarn typecheck`, `yarn lint`, all pass.
- Not run: a live translation with a real model, the Electron UI (the new checkbox), the SVG cover in a real EPUB reader, the `ps` lock lookup on Linux/macOS.

## Follow-ups

- BTT-20: a client task that takes longer than 10 minutes must ask for `leaseMinutes`, or it goes back to the queue.
