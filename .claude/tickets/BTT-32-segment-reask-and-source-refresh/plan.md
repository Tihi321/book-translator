---
status: done
request: REQ-0026
repos: [book-translator]
branch: BTT-32_segment-reask-and-source-refresh
updated: 2026-11-16
---

# BTT-32 Re-ask only for the missing segments, refresh a project's source, and the typography field

From the hub's *Ash & Brass* run (creative-hub REQ-0026). Master is `efef8d6` (BTT-31 merged). Line numbers below were checked against that commit.

- **Feature 1, re-ask.** `acp/claude/claude-sonnet-5` dropped or repeated one segment id in long chunks (chunk 37 of book 2 hr: 25 segments, `d17.4` missing twice, then `d17.5` missing, then `d17.4` repeated). Today every such reply is thrown away whole: a full retry, then BTT-31's rotation to the next model, then the split. This is option B of `.claude/tickets/BTT-31-retry-and-export/research.md`: keep the segments that came back and ask again only for the missing or repeated ones.
- **Feature 2, source refresh.** A hand edit to the English book 3 never reached its Croatian project. The project id holds the source hash (`projectIdFor`, `src/engine/project/store.ts:32`). So `create_project` on the edited file makes a new, empty project. Nothing can re-read the source into the existing one. Export then writes the stale translation, and an EPUB is written by position into the edited file.
- **Feature 3, typography field.** BTT-30 (`.claude/tickets/BTT-30-parallel-style/`) added `ProjectSettings.typography { dialogue: dash | quotes | guillemets, quotes?, notes? }`. That setting is the typography part of the brief, merged field by field, with per-language defaults in `src/engine/pipeline/typography.ts`. The changelog's "Not done" item was: a field in the project settings tab (`src/renderer/ui/ProjectSettingsTab.tsx`).

Precondition: the user says yes to this plan. Unit tests, typecheck and lint use temporary data folders and can run at any time. Workers do not start, build or package the app.

Commands (yarn under fnm: put the fnm default alias dir on PATH; `fnm exec yarn` fails): `yarn test`, `yarn typecheck`, `yarn lint`.

## Scope

1. **Re-ask** (translator only, `src/engine/pipeline/translator.ts` and `segments.ts`):
   - A reply that fails the segment check but is salvageable (C1) keeps its good segments.
   - Up to `MAX_REASKS = 2` follow-up calls on the same model then ask only for the missing and conflicting ids, each with the passages around them as context (C2).
   - A filled reply is a success. It is not counted as a mismatch.
   - If the re-asks do not fill it, BTT-31's path runs unchanged: a full retry with a note, then the next model, then the split.
   - Each re-ask is logged.
2. **Source refresh**, through service, protocol, dispatcher, MCP `refresh_source {projectId, sourcePath?}`, CLI `engine refresh <projectId> [--source <file>]`, and a "Refresh source" button in the project view (C3-C7):
   - Re-reads the source into the existing project.
   - Keeps the translation, the QA verdict and any hand edit of every block whose text did not change.
   - Puts changed and new blocks into new pending chunks.
   - Drops removed blocks.
   - Backs up the old files first.
   - Export refuses while the source file differs from the one the project was made or refreshed from (C6), so a stale project can no longer export silently.
3. **Typography field** in the project settings tab (C8, C9):
   - A dialogue-style select, a quote-marks input and a notes input.
   - Each shows the language default as its placeholder.
   - An empty value clears the project's own setting, so the default applies again.
4. Docs (README, MCP descriptions and INSTRUCTIONS, CLI usage) and the ROADMAP.md entry.

## Out of scope

- Re-asking in the proofreader, QA, fixer and `retry-tags` paths, and in `submit_translation` / `submit_client_task`: an outside translator still gets "all or nothing" with the reason.
- Why sonnet drops or repeats an id.
- Refreshing `vn` (book folder v1) and `vnp` (pack v2) projects: refused with a message. A pack's hash is its identity in VN Studio's edition contract, and a changed pack keeps "create a new project". The new export source check (C6) also leaves `vn` and `vnp` as they are. `vnp` already refuses a changed pack.
- Updating the glossary or the brief for the new text (the glossary pass is not run again). Names in new paragraphs follow the existing glossary.
- Keeping the partial translation of a chunk that was pending or failed before the refresh: its blocks are translated again.
- `create_project` noticing that an existing project has the same source path and language with another hash (a hint to use `refresh_source`). Possible follow-up.
- A "source changed" flag in `get_project` or the UI. The export refusal and its message cover it.
- A typography field in the New project dialog. Clearing a typography field through MCP (its `dialogue` is an enum). Typography stays settable there as before.
- Hub changes (the `make-visual-novel` skill could mention `refresh_source`). Hub follow-up, not done here.

## Files and modules to touch

Feature 1:
- `src/engine/pipeline/segments.ts`: `SegmentParse.conflicting` (in `parseSegments`, lines 14-58), new `salvage()`.
- `src/engine/pipeline/translator.ts`:
  - `translatorUserContent` (lines 50-68): new optional `next` context.
  - `ask` (lines 71-80): optional context override.
  - New `MAX_REASKS` next to `MISMATCHES_PER_MODEL` (line 91), plus the doc comment of `translateChunk` (lines 93-101).
  - `attempt` (lines 139-170): the re-ask step.
- `src/engine/mcp/server.ts:302`: add `reask` to the example task list of `get_client_task`.
- `README.md:21`: one sentence.
- Tests: `tests/agents.test.ts` (new repro), `tests/segments.test.ts` (one new case), `tests/pipeline.test.ts` (four mocks changed, see Tests), `tests/pipelineHelpers.ts` (one helper).

Feature 2:
- New `src/engine/project/refresh.ts`: the pure matching and re-chunking (C4).
- `src/engine/chunker.ts`: export the packing loop of `planChunks` (lines 112-135) as `packSegments(sectionId, segs, budget, firstIndex, count?)`. `planChunks` calls it, so its behaviour is unchanged.
- `src/engine/project/store.ts`: `replaceSource(id, ir, chunks)` (C5).
- `src/engine/service.ts`:
  - `refreshSource(id, sourcePath?)` (C3), next to `editChunk` (line 351).
  - The source check in `exportWithReport` (line 529, C6).
- `src/shared/protocol.ts`:
  - Command `{ type: 'refreshSource'; projectId; sourcePath? }` (near line 336).
  - `RefreshResult` type, and `CommandResults.refreshSource`.
  - `SOURCE_CHANGED` constant next to `EXPORT_REFUSED` (line 13).
- `src/engine/dispatcher.ts`: `case 'refreshSource'` (near `case 'editChunk'`, line 726).
- `src/engine/mcp/server.ts`:
  - The `refresh_source` tool (after `edit_chunk`, line 253).
  - INSTRUCTIONS (lines 26 and 36).
  - The `export_project` description (line 284): one clause.
- `src/engine/cli.ts`: `refreshProject(argv)`, plus `source` in `VALUE_FLAGS` (line 74).
- `src/engine/index.ts`: dispatch and a USAGE line.
- `src/renderer/ui/ProjectView.tsx`: the Refresh source button and row (next to Open folder, line 191, and the refusal row pattern at lines 196-202).
- `README.md`:
  - The CLI block (lines 79-90).
  - The Review line (127).
  - A short "Source changed" paragraph after the export notes near line 21.
- Tests: new `tests/refresh.test.ts`, and the tool name added to the list in `tests/mcp.test.ts:97-102`.

Feature 3:
- `src/engine/pipeline/typography.ts`: export `languageDefault(s)` (the table row for `languageCodeOf(s)`).
- `src/shared/protocol.ts`: `ProjectDetail.typographyDefault?: Typography` (lines 169-183).
- `src/engine/service.ts` `detail()` (line 271): set it.
- `src/engine/project/store.ts` `mergeSettings` (line 198): `''` clears a typography field.
- `src/renderer/ui/ProjectSettingsTab.tsx`: the fields (before "Chunk size", line 80).
- Tests: two assertions added to `tests/dispatcher.test.ts:585` (the typography test).

Both features: `ROADMAP.md`.

## Contracts

### C1. Salvageable reply (`segments.ts`)

`parseSegments` also returns `conflicting: string[]`: expected ids that appear more than once where a later text differs from the first. Texts are compared after `replace(/\s+/g, ' ').trim()`. Ids are in reply order. `duplicate` still lists every repeated id, and `ok` keeps its meaning (any duplicate means not ok), so `submitTranslation` and the client paths are unchanged.

**What counts as repeated:** an id that occurs more than once in the reply.
- An identical repeat (same normalized text) is harmless. The first occurrence is kept, and the id needs no re-ask.
- A conflicting repeat means the model probably wrote the next segment under the wrong id (the sonnet pattern: `d17.4` twice, `d17.5` missing). Neither occurrence is trusted, and the id is asked again.

```ts
/** What to keep from a reply that failed the check, and which ids to ask for again; undefined when the reply cannot be salvaged. */
export function salvage(p: SegmentParse, expectedIds: readonly string[]): { keep: Map<string, string>; ask: string[] } | undefined
```

- `undefined` when:
  - `p.extra.length > 0`: an id that was not asked for means the numbering drifted, so nothing in the reply is trusted.
  - or `keep.size === 0`.
  - or `ask.length >= expectedIds.length`.
  - or `ask.length > maxReaskIds(n)`, where `maxReaskIds(n) = Math.max(2, Math.ceil(n / 4))` and `n = expectedIds.length`. Examples: 25 segments allow 7, 4 allow 2, 2 allow 1 (by the `>= n` rule).
- `keep` = `p.segments` without the `conflicting` ids.
- `ask` = the expected ids that are in `p.missing` or `p.conflicting`, in expected order.
- `ask` may be empty: the reply only had identical repeats. The caller then accepts `keep` with no further call.

### C2. The re-ask step (`translator.ts`)

- `const MAX_REASKS = 2`: follow-up calls per salvaged full reply.
- `translatorUserContent(env, segs, prev, note, style)`: `style` gets `next?: PrevContext`. When it is set, the user content has a section `## Following passage (context only, do not translate it)\nSource:\n…\n\nTranslation:\n…`. It goes after the previous passage and before the note.
- `ask(env, segs, opts, note, task, skipModels, ctx?: { prev?: PrevContext; next?: PrevContext })`:
  - `ctx.prev` replaces `opts.prev` when `ctx` is given.
  - `ctx.next` goes to `style.next`.
  - Still returns `{ parse, model }`. The parse is against the ids of `segs`.
- In `attempt`, after a reply `p` from `model` that is not ok, and after the existing log line `segment mismatch on ${model} (…)`:
  1. `s = salvage(p, group ids)`. If it is `undefined`, go to step 4.
  2. `merged = new Map(s.keep)`, `ask = s.ask`. If `ask` is empty, log `${unit}: identical repeated segment(s) ignored: ${p.duplicate.join(', ')}`, then `return accept(group, merged, failed)`.
  3. Up to `MAX_REASKS` times while `ask` is non-empty:
     - Log `${unit}: asking ${model} again for ${ask.length} segment(s) only: ${ask.join(', ')}`.
     - Build the context:
       - `prev`: `prevTail(...)` of the up to 2 group segments right before the first asked id, using their `merged` texts as the translation. When the first asked id is `group[0]`, use `opts.prev`.
       - `next`: the source and `merged` text of the group segment right after the last asked id, if it exists and is in `merged`.
     - Make the call: `ask(env, askSegs, opts, note2, 'reask', failed, ctx)`. `note2` = `Your previous answer had problems (${describeParse(p)}). The other segments are done. Translate only the segments below, which come between the passages above and below. Return each exactly once in its own seg element with the same id.`
     - If the reply has no `extra` ids, merge its `segments` minus its `conflicting` into `merged`. Otherwise ignore it.
     - `ask = ask.filter((id) => !merged.has(id))`.
     - A thrown error that is not an abort ends the re-ask step (log it). An abort is rethrown.

     When `ask` is empty: log `${unit}: the re-ask filled the chunk`, then `return accept(group, merged, failed)`. Otherwise log `${unit}: the re-ask left ${ask.join(', ')}; asking for the whole chunk again`.
  4. Today's code, unchanged:
     - `note = …`
     - The model/count bookkeeping, `count++`.
     - The full `retry`, the rotation after `MISMATCHES_PER_MODEL`, and the split.

  A reply that the re-ask filled never reaches step 4, so it never counts towards `MISMATCHES_PER_MODEL`.
- `failed` is passed as `skipModels`, so the re-ask goes to the model that answered (the first own model not yet failed). BTT-31's rotation stays the fallback.
- Worst case per model is 2 full calls plus 4 small re-ask calls, where it was 2 full calls before. A one-segment group never re-asks (`ask.length >= n`).
- `accept` is unchanged. It gets a map with every group id, so the `retry-tags` step still runs on the merged texts.
- The doc comment of `translateChunk` gets one sentence: "A reply that misses or garbles a few ids (no ids that were not asked for) keeps the rest, and up to MAX_REASKS small calls ask the same model for the missing ones only, with the passages around them; only if that fails is the whole chunk asked again."

### C3. `EngineService.refreshSource`

```ts
async refreshSource(id: string, sourcePath?: string): Promise<RefreshResult>
```

1. `this.refuseWhileRunning(id, 'refreshing the source')`. Load the project.
2. If the format is `vn` or `vnp`, throw `refresh_source does not take visual-novel folders or packs: create a new project for the changed book`.
3. `file = path.resolve(sourcePath ?? project.sourcePath)`. If `adapterFor(file)` gives another format than `project.format` (compare `ir.format` after reading), throw `the new source is <fmt>, the project is <fmt>`.
4. `hash = await hashSource(file)`. If `hash === project.sourceHash && file === project.sourcePath`, return `{ unchanged: true, sourcePath: file, blocks: { kept: 0, toTranslate: 0, removed: 0 }, chunks: { total: <current count>, kept: <current count>, toTranslate: 0 }, editedKept: 0 }` and write nothing.
5. `newIr = await adapterFor(file).read(file)`, `oldIr = store.readIr(id)`, `oldChunks = store.listChunks(id)`.
6. If `oldChunks.length === 0`, skip the re-chunk: `chunks = []`. Otherwise:
   - `budget = project.chunking?.budget ?? chunkBudget({ contexts: [], userMax: project.settings.maxChunkTokens })`.
   - `{ chunks, report } = refreshChunks(oldIr, oldChunks, newIr, budget)` (C4).
7. `backup = await store.replaceSource(id, newIr, chunks)` (C5).
8. Update the project:
   - `sourcePath = file`, `sourceHash = hash`.
   - `chunking = chunks.length ? { budget, chunks: chunks.length } : null`.
   - `status`:
     - `created` if there are no chunks and the status was `created`.
     - `incomplete` if any chunk is not `done`/`flagged`.
     - `done` otherwise.
   - Save the project.
9. Log to `log.md` and as an event: `info: source refreshed from <file>: <kept> block(s) kept (<editedKept> hand-edited chunk(s)), <toTranslate> to translate, <removed> removed; <chunks.total> chunks, <chunks.toTranslate> to translate; backup in <backup rel>`.
10. Emit `project.updated`, then return the result.

```ts
// src/shared/protocol.ts
export interface RefreshResult {
  /** Same file and hash as before: nothing was changed. */
  unchanged: boolean
  sourcePath: string
  /** Translatable blocks: kept with their translation, to translate (changed or new), removed. */
  blocks: { kept: number; toTranslate: number; removed: number }
  /** Chunks after the refresh: all, kept from before (translated), pending ones that need translation. */
  chunks: { total: number; kept: number; toTranslate: number }
  /** Kept chunks that carry a hand edit (edit_chunk). */
  editedKept: number
  /** The backup folder, relative to the data folder (forward slashes). Absent when unchanged. */
  backupRel?: string
}
```

### C4. `refreshChunks` (new `src/engine/project/refresh.ts`, pure, no I/O)

```ts
export function refreshChunks(oldIr: DocumentIR, oldChunks: readonly ChunkRecord[], newIr: DocumentIR, budget: number, count?: (t: string) => number): { chunks: ChunkRecord[]; report: Omit<RefreshResult, 'unchanged' | 'sourcePath' | 'backupRel'> }
```

**Translatable blocks** are the blocks `planChunks` takes: not `meta`, and text not blank.

**Block match.** Matching is by exact `block.text` (inline placeholders included), never by id. Ids are positional (`d3.17`, `b12`, `p4`), so an inserted paragraph renumbers everything after it. The old and new sequences of block texts are aligned in order (`alignTexts`, patience-diff style), so matched pairs keep their relative order:
  1. A common prefix and a common suffix match first.
  2. Texts that occur exactly once on each side of the range are anchors; their longest chain that is increasing on both sides matches, and each gap between anchors is aligned the same way.
  3. A gap with no anchor gets an exact LCS, or a greedy in-order match (each new text takes the first old copy after the last match) when the gap is over 1,000,000 cells.

  This is linear in practice on a book of thousands of blocks. An identical repeat ("* * *", "Yes.") matches the copy in its own place: deleting the first of two "Yes." keeps the second one's translation and hand edit.
  4. A second pass (`matchMoved`): each new block still unmatched takes an unused old block with exactly the same text, the first such one in old order. So a moved paragraph (swapped, or moved to the front or the end) keeps its translation, QA data and hand edit; it goes into its own kept chunk, re-keyed from its old chunk, with its `final` and state.
- Old blocks left unused are counted as `removed`.
- New blocks with no match are counted as `toTranslate`.
- `editsDropped`: segments of an `edited` old chunk whose `final` differs from its proofread (or translation) text and that are not carried, because their block changed or was removed. It is in the log line, the UI toast and the CLI output; the old text stays in `refresh-backup/`.

**Carried segment.** For a new block matched to old block `o`, take the new segments `segmentsForBlock(newBlock, budget, count)`. Their old counterparts are `o.id` for a single segment, or `${o.id}#${part}`.

A new segment is carried only when all of these hold:
- The old segment exists in some old chunk `c` with the same text.
- `c.state` is `done` or `flagged`.
- `c.final[oldSegId] !== undefined`.

Its carried data is `translation`, `proofread` and `final` of `oldSegId` from `c`. `final` holds the hand edit if there was one. Anything else counts as needing translation, and the whole block's segments go to translation together: if one part of a block is not carried, none is.

**Chunks.** Walk `newIr.sections` in order, and within a section walk the segments of translatable blocks in order. Each run of segments becomes chunks:
- **A run of consecutive carried segments from the same old chunk `c`** becomes one kept chunk:
  - `index`: the new number. `sectionId`: the new section. `segments`: the new ones.
  - `blockIds`.
  - `translation`, `proofread` and `final`, re-keyed to the new segment ids.
  - `qa`: `issues` re-keyed and filtered to the run's segments. `score`, `model` and `edited` as in `c`.
  - `state`, `model` and `edited` as in `c`.
  - `tokens`, `costUsd` and `ms` as in `c` when the run is all of `c`'s segments. Otherwise zeros: the spend is already in `project.spend`.
  - `error`: undefined.
- **A run of consecutive segments that need translation** is packed with `packSegments(sectionId, segs, budget, nextIndex, count)`, the loop of `planChunks` (same budget and overhead rule). Each result becomes `emptyChunk(...)`, state `pending`.

So a kept chunk is never run again, and a hand-edited text can never go through the translator, proofreader or QA again. The runner only schedules `pending` chunks (`runner.ts:244-256`), and a flagged chunk stays flagged.

Indexes run 1..N in document order. The runner's previous-passage context (`runner.ts:312-317`) then comes from the kept chunk before a new chunk.

Report:
- `blocks` counts translatable blocks.
- `chunks.kept` counts kept chunks, `chunks.toTranslate` the pending ones.
- `editedKept` counts kept chunks with `edited`.

### C5. `ProjectStore.replaceSource(id, ir, chunks): Promise<string>`

1. Make `refresh-backup/<ISO time with : and . replaced by ->/` in the project folder. Copy `source.json`, `project.json` and the whole `chunks/` folder (`fs.cp`, recursive) into it.
2. Write every new chunk into `chunks.next/` (same file names, `chunkName`).
3. `fs.rm(chunks)`, then `fs.rename(chunks.next, chunks)`.
4. `atomicWrite(source.json, JSON.stringify(ir))`.
5. Return the backup folder, relative to the data folder, with forward slashes.

Backups are kept (JSON only, small). A crash between steps leaves the backup, and the log names it.

### C6. Export source check (`exportWithReport`)

The check runs first in `exportWithReport`: before the untranslated guard, before `mkdir`, and only for the formats `epub`, `docx`, `txt`, `md` and `pdf`.
- If `project.sourcePath` exists and `await hashSource(project.sourcePath) !== project.sourceHash`, throw `new ExportRefused(\`${SOURCE_CHANGED} ${project.sourcePath} was edited after the project was made or last refreshed, so the translation no longer matches it. Run refresh_source (the app: Refresh source; CLI: engine refresh <id>) to keep the translations of unchanged blocks and translate the rest.\`)`.
- A missing source file skips the check, so the adapter behaves as today.
- `allowPartial` does not bypass this check. An EPUB or DOCX is written by block position into the source file, so a stale IR would put text into the wrong paragraphs.

`SOURCE_CHANGED = 'export refused: the source changed:'` lives in `src/shared/protocol.ts`. It starts with `EXPORT_REFUSED`, so `exportRefusal()` in the UI matches it as a refusal. The UI must not offer "Export anyway" for it (see T5).

### C7. Wiring

- Protocol command: `{ type: 'refreshSource'; projectId: string; sourcePath?: string }`. Result `RefreshResult`.
- Dispatcher: `case 'refreshSource': return s.refreshSource(cmd.projectId, cmd.sourcePath)`. If the result has `backupRel`, it is passed through unchanged.
- MCP tool `refresh_source`. Input: `{ projectId, sourcePath: z.string().optional().describe("Absolute path of the edited source, the same format (default: the project's source path)") }`. Description:

  > Reads the source document again after it was edited and keeps the translation of every block whose text did not change, hand edits (edit_chunk) and QA verdicts included. Changed and new blocks go into new pending chunks: start_translation (or get_translation_task) translates only them. Removed blocks are dropped. Chunk numbers change. The old chunks, source.json and project.json are copied to refresh-backup/ first. Refused while the project runs, and for visual-novel folders and packs.

  Not read-only.
- INSTRUCTIONS:
  - Line 26 (operator path), add: "If the source was edited after the project was made, refresh_source keeps the translations of unchanged blocks; export_project refuses until then."
  - Line 36, replace the last sentence with: "Projects are named after the file, the language and a hash, so the same file and language give the same project; an edited file gives a new id, so use refresh_source on the existing project instead of create_project."
- `export_project` description: add "and while the source file changed since the project was made (run refresh_source)".
- CLI:
  - `engine refresh <projectId> [--source <file>]` prints `unchanged` or the counts, one line each (`blocks: …`, `chunks: …`, `hand-edited chunks kept: N`, `backup: …`). Exit code 0.
  - Errors use the usual `error:` path in `index.ts`.
  - Add `'source'` to `VALUE_FLAGS`.
  - USAGE line in `index.ts`, and the README CLI block.
- UI: see T5.

### C8. Typography default in the detail

- `typography.ts`: `export function languageDefault(s: Pick<ProjectSettings, 'targetLanguage' | 'targetLanguageCode'>): Typography | undefined` returns `TYPOGRAPHY_DEFAULTS[languageCodeOf(s)]`.
- `ProjectDetail.typographyDefault?: Typography` (doc: "The target language's default typography, if the table has one; the UI shows it as the placeholder"). `detail()` sets it when defined.

### C9. Clearing a typography field

In `mergeSettings` (`store.ts:198`), after the field-by-field merge of `typography`, delete every key whose value is `''` or `undefined`. If nothing is left, drop `typography` from the settings. So `patch: { typography: { dialogue: '' } }` clears the project's own dialogue style, and the language default applies again (`effectiveTypography`). The MCP schema is unchanged.

## Tasks for workers

Feature 1 (T1), feature 2 (T2-T5) and feature 3 (T6) touch different code, with these overlaps:
- `protocol.ts`: T3 and T6.
- `service.ts`: T2/T3 and T6 (`detail`).
- `store.ts`: T2 (`replaceSource`) and T6 (`mergeSettings`).

Run T1 and T6 in parallel with T2. T3 waits for T2. T4 and T5 wait for T3's protocol contract. T7 runs last. Each commit holds only its feature's files.

### T1. Re-ask for missing or repeated segments (commit 1)

- Inputs: C1, C2; `segments.ts`, `translator.ts`, `tests/segments.test.ts`, `tests/agents.test.ts` (`envWith`), `tests/pipeline.test.ts:215-346`, `tests/pipelineHelpers.ts`.
- Do:
  - `conflicting` and `salvage` (C1).
  - The `next` context, the `ask` override and the re-ask step (C2).
  - The doc comment.
  - `reask` in the `get_client_task` task example (`server.ts:302`).
  - `README.md:21`: "A reply that misses or garbles a few segment ids keeps the rest, and the same model is asked for just those (twice at most) before the whole chunk is retried."
- Change the existing tests whose mocks now get salvaged (see Tests). Add the helper `withStray(segs)` to `pipelineHelpers.ts`. It returns `asSegs([...segs, { id: 'stray', text: '?' }])` and makes a reply unsalvageable.
- Outputs: R1 and S1 pass. Every changed test keeps its old expected call sequence. Full suite, typecheck and lint green.

### T2. Refresh core: matching, re-chunking, store (commit 2)

- Inputs: C4, C5; `chunker.ts`, `store.ts` (`emptyChunk`, `chunkName`, `atomicWrite`), `src/shared/project.ts` (`ChunkRecord`, `SegmentRec`), `src/shared/ir.ts`.
- Do:
  - `packSegments` in `chunker.ts`, with `planChunks` using it (no behaviour change: `tests/chunker.test.ts` stays green).
  - `refresh.ts` (`refreshChunks`).
  - `ProjectStore.replaceSource`.
- Outputs: `refreshChunks` and `replaceSource` as specified. Proved by R2 through the service (T3); no separate unit test.

### T3. Refresh in the service and the export check (commit 2)

- Inputs: C3, C6, C7 (protocol part); T2's functions; `service.ts:351-400`, `:529-585`; `formats/index.ts` (`hashSource`, `adapterFor`).
- Do:
  - `RefreshResult`, the `refreshSource` command, its `CommandResults` entry and `SOURCE_CHANGED` in `protocol.ts`.
  - `EngineService.refreshSource`.
  - The source check in `exportWithReport`.
  - The dispatcher case.
- Outputs: R2 passes. The full suite stays green. If an existing export test now fails on the source check, the test changed its source on purpose: say so in the report, and do not weaken the check.

### T4. Refresh through MCP and the CLI (commit 2)

- Inputs: C7; `server.ts`, `cli.ts`, `index.ts`, README.
- Do:
  - The `refresh_source` tool, INSTRUCTIONS and the `export_project` description.
  - `refreshProject` in `cli.ts`, `VALUE_FLAGS`, and the dispatch and usage in `index.ts`.
  - README: the CLI block, the Review line (127), and a paragraph "Source changed" near line 21: "Edited the source after translating? `refresh_source` (CLI `engine refresh <id>`, the app's Refresh source) re-reads it into the same project: unchanged paragraphs keep their translation and hand edits, changed and new ones are translated by the next run, removed ones are dropped. Export refuses until the project matches its source."
  - Add `'refresh_source'` to the tool list in `tests/mcp.test.ts:97-102`.
- Outputs: the MCP tool-list test passes; typecheck.

### T5. Refresh in the UI (commit 2)

- Inputs: C7, `RefreshResult`; `ProjectView.tsx`; `getApi().pickFile()` (as in `NewProject.tsx:144-147`); the inline row pattern of the export refusal (`ProjectView.tsx:196-202`); `toast`, `attempt` and `loadDetail` from the store.
- Do:
  - A button `Refresh source` (`data-testid="refresh-source"`) after Open folder. It is disabled while `running` and hidden for `vn`/`vnp`. It opens a row (`data-testid="refresh-row"`) with:
    - Text: `Re-read the source and keep the translations of unchanged paragraphs (hand edits too). Changed and new paragraphs are translated by the next run.`
    - `Refresh from <file name>` (`data-testid="refresh-same"`).
    - `Choose another file...` (`data-testid="refresh-pick"`): `pickFile`, then refresh with `sourcePath`.
    - `Cancel`.
  - Sending `{ type: 'refreshSource', projectId: id, sourcePath? }` through `attempt`.
  - On success:
    - Unchanged: toast `The source has not changed`.
    - Otherwise toast `Source refreshed: <kept> paragraphs kept, <toTranslate> to translate, <removed> removed` (`info`).
    - Then `loadDetail(id)`.
  - In `exportFor`: a refusal whose message starts with `SOURCE_CHANGED` is toasted as an error and does not set `refused`, so "Export anyway" is never offered for it.
- Outputs: typecheck and lint. UNTESTED in the app.

### T6. Typography field (commit 3)

- Inputs: C8, C9; `ProjectSettingsTab.tsx` (the `draft`/`set` pattern, `locked`), `typography.ts`, `service.detail()`, `store.mergeSettings`, `tests/dispatcher.test.ts:585-610`.
- Do:
  - `languageDefault`, `ProjectDetail.typographyDefault`, and the `mergeSettings` clearing.
  - In the settings form, before "Chunk size", three controls. Let `t = s.typography ?? {}`, `d = detail.typographyDefault`. Each one calls `set({ typography: { ...t, <field>: value } })`, and all are disabled while `locked`.
    - `<label>Dialogue</label>` with a `<select data-testid="settings-dialogue">`. Options:
      - `''`: `Language default (<style of d>)`, or `Not set` without a default.
      - `dash`: `Dash at the start (– Text – he said.)`.
      - `quotes`: `Quotation marks`.
      - `guillemets`: `Guillemets « »`.
    - `<label>Quote marks</label>` with `<input data-testid="settings-quotes" style={{ width: 80 }} placeholder={d?.quotes ?? '„…”'}>`.
    - `<label>Typography notes</label>` with `<input data-testid="settings-typography-notes" placeholder="Number format, ellipsis, ...">`.
  - Below the form, a `dim small` hint: "Typography goes into every translator and proofreader prompt; chunks translated before keep their style."
  - When `detail.typography.inconsistent`, a `warn small` line with `detail.typography.message`.
  - Saving uses the existing Save button. No new command.
- Outputs: the two new assertions in `dispatcher.test.ts` pass; typecheck and lint. The UI is UNTESTED in the app.

### T7. Roadmap, docs check, changelog

- ROADMAP entry (below): add it in commit 1 as open, and change its opening to the done wording in commit 3.
- The changelog in this folder, per the `implement` skill.
- The final DONE / NOT DONE / UNTESTED list.

## Tests

Follow the test-discipline skill: one new test per new behaviour. Mocks of existing tests change only where the new re-ask would otherwise change what they prove.

### Reproduction test for feature 1 (fails before the change)

**R1** (new, `tests/agents.test.ts`, in `describe('translator')`): "asks again only for a dropped and a garbled segment, with the passages around them".
- Segments `a`..`h` (8 segments, texts `One`..`Eight`).
- `envWith` reply, by the number of segments in the request:
  - 5 or more: echo `T <text>` for all, but leave out `e` and add a second `c` whose text is `T Five`. This is the sonnet pattern: `d17.4` repeated, `d17.5` missing.
  - 3 or 4: leave out the last segment.
  - 1 or 2: echo.
- Expect:
  - `tasks` is `['translate', 'reask']`.
  - `segsIn(users[1]).map((s) => s.id)` is `['c', 'e']`.
  - `users[1]` contains `Previous passage` with `T Two` (the passage before `c` holds `a` and `b`) and `Following passage` with `T Six` (the segment after `e` is `f`).
  - The result's `translation` has all 8 ids, each `T <its own text>`. `c` is `T Three`, not `T Five`.
  - A log line matches `/asking mock\/m again for 2 segment\(s\) only: c, e/`.
- Before the change: the 8-segment reply fails, then the retry fails, then the split gives two 4-segment halves that each fail twice, and `translateChunk` rejects with `ChunkFailure`. The test fails at the `await`.

**S1** (new, `tests/segments.test.ts`): "salvage keeps good segments, asks for missing and garbled ones, and refuses drift". Five assertions on `salvage(parseSegments(...), ids)`:
1. An identical repeat gives `ask: []`, and `conflicting` is empty.
2. A conflicting repeat plus a missing id gives `ask` with both, and `keep` without the conflicting id.
3. Any `extra` id gives `undefined`.
4. With 8 ids, 3 missing gives `undefined` (`max(2, ceil(8/4)) = 2`), and 2 missing does not.
5. A 2-id reply with 1 missing gives `ask: [that id]`, and a 1-id reply that is empty gives `undefined`.

This test pins the limits.

### Existing tests whose mocks change (feature 1)

Each keeps its expected call sequence. Each mock gets a stray id, so the reply stays unsalvageable and the test still proves what it was written for:
- `tests/pipeline.test.ts:298` ("retries once with a note when segments are missing"): the `translate` reply becomes `withStray(segs.slice(0, -1).map(...))`. Rename the test to "retries once with a note when a reply cannot be salvaged".
- `:317-318` (BTT-31 rotation): both broken replies get `withStray`.
- `:336` ("splits the chunk in half when the retry fails too"): the broken reply gets `withStray`.
- `:229` (the pause inside a split): the full-chunk reply gets a stray id.
- `tests/agents.test.ts:60-79`: unchanged (`'no segments at all'` and `'garbage'` are never salvageable).

### Feature 2

**R2** (new `tests/refresh.test.ts`, `rig()` with `bookText()` as `book.md`, `maxChunkTokens: 100`; Markdown has the same positional ids as EPUB): "refresh keeps unchanged blocks and a hand edit, translates only changed and new ones, drops removed ones; export refuses a changed source".
1. Start the run, which ends `done`. Then `editChunk(id, 1, { [firstSegOfChunk1]: 'HAND EDIT' })`, where chunk 1 is in the meta or chapter 1 part that will not change.
2. Rewrite `r.file`:
   - Delete "Paragraph 3 of chapter 1".
   - Change "Paragraph 5 of chapter 1" to "Paragraph 5 of chapter 1 was rewritten.".
   - Insert "A new paragraph in chapter 2." after "Paragraph 8 of chapter 2".
3. `exportWithReport(id, undefined, { allowPartial: true })` rejects with `/^export refused: the source changed:.*refresh_source/`.
4. `refreshSource(id)` gives:
   - `unchanged: false`.
   - `blocks: { toTranslate: 2, removed: 2 }`. The removed blocks are the deleted paragraph and the old text of the changed one.
   - `blocks.kept` equals the old translatable block count minus 2.
   - `editedKept: 1`, `chunks.toTranslate >= 1`.
   - The project id is unchanged, and `sourceHash` is the new one.
   - A `refresh-backup/` folder exists with `chunks/`.
5. After the refresh, `listChunks`:
   - The chunk holding `HAND EDIT` has it in `final`, `edited: true`, state `done`.
   - The pending chunks' segments are exactly the 2 new texts.
   - Every chunk's segments, concatenated in index order, equal the new document's translatable blocks in order.
6. Count `r.calls('translator')` before and after a second `start(id)`, which ends `done`. Only the pending chunks' units were asked, and the asked segments (`segsIn` of those calls) are exactly the two new texts.
7. The `exportWithReport(id)` file contains `HAND EDIT`, `[hr] Paragraph 5 of chapter 1 was rewritten.` and `[hr] A new paragraph in chapter 2.`. It contains neither "Paragraph 3 of chapter 1" nor the old "Paragraph 5 of chapter 1:" text.
8. A second `refreshSource(id)` gives `unchanged: true`.

Before the change, `refreshSource` does not exist and the export at step 3 resolves, so the test fails.

**MCP**: `'refresh_source'` added to the tool list at `tests/mcp.test.ts:97-102`. It proves the tool is registered; the dispatcher and protocol are covered by typecheck.

Not added: a refusal test for `vn`/`vnp` or a format mismatch (one-line guards); a separate `refreshChunks` unit test (R2 covers it through the service); CLI and UI (no tests exist for them; live check).

### Feature 3

In `tests/dispatcher.test.ts:585` (the existing typography test), after the `updateProjectSettings` call at line 589:
- `detail.typographyDefault` equals `{ dialogue: 'dash', quotes: '„…”' }` (Croatian).
- A second `updateProjectSettings` with `{ typography: { dialogue: '' as never } }` leaves `project.settings.typography` as `{ notes: 'Numbers in words.' }` (dialogue cleared, notes kept).

The UI is not unit-tested (no renderer test for the settings tab).

## Acceptance criteria

| # | Criterion | Proved by |
|---|---|---|
| A1 | A reply with a few missing ids or conflicting repeats, and no stray ids, keeps its good segments; the same model is asked only for those ids, with the passages around them; the merged chunk is accepted with no full retry | R1 |
| A2 | Limits: at most `MAX_REASKS = 2` re-asks per full reply; re-ask only when the ids to ask are at most `max(2, ceil(n/4))` and fewer than `n`; an identical repeat is ignored, a conflicting repeat is asked again, and a stray id disables the re-ask | S1, R1 |
| A3 | A reply the re-ask cannot fill falls back to BTT-31: full retry, next model, split, with unchanged sequences | the changed tests at `pipeline.test.ts:298`, `:317`, `:336`, `:229`, and `agents.test.ts:60-79` green |
| A4 | Each re-ask is logged with the model and the ids | R1 (log line) |
| A5 | `refresh_source` keeps the translations of unchanged blocks, including a hand edit, and those chunks are not run again | R2 steps 4-6 |
| A6 | Changed and new blocks are in pending chunks; the next run translates only them; removed blocks are gone from chunks and export | R2 steps 4-7 |
| A7 | The project id stays the same, the hash and path follow the new file, the old files are backed up, and a second refresh with no change is a no-op | R2 steps 4 and 8 |
| A8 | Export refuses while the source file changed since the project was made or refreshed, also with `allowPartial`; the message names `refresh_source` | R2 step 3 |
| A9 | MCP `refresh_source`, CLI `engine refresh`, the protocol command and the UI button exist | MCP tool list test; typecheck; CLI and UI UNTESTED |
| A10 | Refresh is refused while running and for `vn`/`vnp` | code review of the guards (not tested) |
| A11 | The settings tab has dialogue, quote-mark and notes fields with the language default as placeholder; an empty value clears the project's own setting | `dispatcher.test.ts:585` assertions (engine side); UI UNTESTED |
| A12 | Docs: README, MCP descriptions and INSTRUCTIONS, CLI usage | review of the diff |
| A13 | Full suite, `typecheck` and `lint` green after each commit | `yarn test`, `yarn typecheck`, `yarn lint` |

## ROADMAP.md entry

Add under `## Open: found by the hub's *Ash & Brass* run (2026-11-15)`, after the BTT-31 bullet:

```md
- **BTT-32 (branch `BTT-32_segment-reask-and-source-refresh`; creative-hub REQ-0026; plan `.claude/tickets/BTT-32-segment-reask-and-source-refresh/plan.md`): ask again only for the missing segments, refresh a project's source, and the typography field.** (1) `acp/claude/claude-sonnet-5` dropped or repeated one segment id in long chunks; the whole reply was thrown away. Now a reply with a few missing ids or garbled repeats (and no ids that were not asked for) keeps the rest, and the same model is asked for just those, with the passages around them (twice at most), before BTT-31's full retry, next model and split. (2) A hand edit to the English book 3 never reached its Croatian project: the project id holds the source hash, and nothing re-read the source. `refresh_source {projectId, sourcePath?}` (CLI `engine refresh`, the app's Refresh source) re-reads it into the same project: unchanged blocks keep their translation, QA verdict and hand edits, changed and new blocks go into new pending chunks, removed ones are dropped, the old files are backed up; export refuses while the source file changed. Not for visual-novel folders or packs. (3) BTT-30's leftover: dialogue style, quote marks and notes in the project settings tab.
```

When done, the implementer changes the opening to "done on branch `BTT-32_segment-reask-and-source-refresh`, not merged" and adds what was not done or is UNTESTED, as the BTT-31 bullet does.

## Live checks (all UNTESTED until run with the user)

Run only when Book Translator is not in use by a production, and with the user's yes. Never start Scriptorium for this.

- L1 (feature 1): retry chunk 37 of `the-automaton-who-confessed-hr-8e147b` on `acp/claude/claude-sonnet-5` only (`retry_chunk {model}`). Either the log shows a `reask` with the dropped ids and the chunk ends `done` with fewer full calls, or a clean first answer. UNTESTED.
- L2 (feature 2): on a copy of book 3's Croatian project, `refresh_source` with the edited English EPUB. The counts are plausible. The hand edit is still in `get_chunk`. `start_translation` translates only the new chunks. The exported EPUB opens, and the edited paragraph is in Croatian at the right place. UNTESTED.
- L3 (feature 2 UI): the Refresh source row, both buttons, the toast, and the export refusal toast with no "Export anyway". UNTESTED.
- L4 (feature 3 UI): the settings tab shows the Croatian default as placeholders. Choosing `quotes` and saving shows in `get_project`. Choosing "Language default" clears it. UNTESTED.
- L5 (CLI): `engine refresh <id>` and `engine refresh <id> --source <file>` print the counts. UNTESTED.

## Commit plan

One commit per feature on `BTT-32_segment-reask-and-source-refresh`, cut from master `efef8d6`. Messages use a Bash heredoc (`git commit -F - <<'EOF'`), with a blank line after the subject and the attribution line.

1. `BTT-32: a reply with a few missing or garbled segments asks again only for those` (T1, plus the ROADMAP entry as open).
2. `BTT-32: refresh_source re-reads an edited source and keeps unchanged translations and hand edits` (T2-T5).
3. `BTT-32: typography fields in the project settings tab` (T6, the ROADMAP status line, the changelog).

If the `implement` skill closes the ticket files (plan status, changelog) in a commit of their own, as BTT-31 did, that commit comes last.

## Open points for the reviewer

- C6 refuses an export of a project whose source file was edited, even with `allowPartial`. That is a behaviour change for anyone who edits a source file after translating. The message says what to do. A warning instead would leave the EPUB case writing translations into the wrong paragraphs.
- Matching is by exact block text. A paragraph with one changed comma is translated again as a whole, and its old translation is lost from the chunks; the backup still has it.
- A new paragraph gets its own small chunk, translated with the previous kept chunk's tail as context. A paragraph rewritten mid-scene can read slightly differently from its neighbours. QA and the typography check still run on it.
- Chunk numbers change after a refresh. Outside translators and run logs that hold chunk numbers must read `get_project` again.
