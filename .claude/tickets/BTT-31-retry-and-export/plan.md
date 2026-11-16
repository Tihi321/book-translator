---
status: done
request: REQ-0025
repos: [book-translator]
branch: BTT-31_retry-and-export
updated: 2026-11-16
---

# BTT-31 Retry on the next model, and refuse an export with untranslated blocks

From the hub's *Ash & Brass* run, book 2 hr (project `the-automaton-who-confessed-hr-8e147b`), creative-hub REQ-0025, bugs 5 and 6. Research: `research.md` in this folder (read it first; line numbers below were checked against master `205a9c5`).

- Bug 5: chunk 37 failed on a segment mismatch four times on `acp/claude/claude-sonnet-5`; `acp/antigravity/gemini-4-argon`, second in the translator list, was never asked, and translated it on the first manual `retry_chunk`.
- Bug 6: `export_project` wrote the book while chunk 37 was failed, with 19 English paragraphs and no warning.

Precondition: no code is changed until the REQ-0024 production has stopped Book Translator, and the user has said yes to this plan. Unit tests, typecheck and lint use temporary data folders and are fine to run then; the app is not started or built by the workers.

## Scope

1. **Bug 5, rotate before split.** A chunk whose reply fails the segment check gets `MISMATCHES_PER_MODEL = 2` calls on a model (`translate`, then `retry` with the note), then moves to the next model of the translator's list (fresh `translate` with no note, then `retry`), and so on; only when every model of the list has failed twice is the chunk split. "The list" is ONLY the project's own list for the agent (`agentModels[agent]`, with `translatorModel` first, resolved and deduplicated); a mismatch never moves a chunk onto a row of the registry's shared fallback list (a paid per-token or a weak local model). The router's provider-error fallback (unreachable, limits, context, `router.ts:~125-215`) is unchanged. Each half starts again at the head of the list with the same rotation and no further split; a half that exhausts the list throws `ChunkFailure` as today. Every switch is logged. A one-model list behaves exactly as today (translate, retry, split, halves translate/retry, fail).
2. **Bug 6, refuse by default.** `exportWithReport` refuses while any block that a chunk covers has no translation (a `failed`, `pending` or in-progress chunk, or no chunks yet), with one message naming the chunks, the block count and the `retry_chunk` hint. `allowPartial: true` exports anyway and adds one warning (log, `log.md`, the report's `warnings`) naming the same chunks and count. Applies to every format, packs (`vnp`) included.
3. Wiring of `allowPartial` and the refusal through protocol, dispatcher, MCP `export_project`, CLI (`engine export --allow-partial`; the end of `engine translate` passes `allowPartial: true`) and the UI (an "Export anyway" confirmation on Export and Read translation, warnings shown as toasts).
4. Docs: MCP tool description and INSTRUCTIONS, CLI usage strings, README.
5. ROADMAP.md entry for BTT-31.

## Out of scope

- Asking again only for the missing or repeated segments of a reply (research option B). Recorded as an extra idea.
- Why sonnet drops or repeats one segment (d17.4).
- Changing callers in the hub or other tools (none breaks, see "Callers outside this repo").
- Rotation for the proofreader, QA or fixer; the tag retry (`retry-tags`) keeps its single call (it only inherits the skip list, see T1).
- A new toast kind or other UI restyling.

## Callers outside this repo (grep of `C:\projects\Personal`, excluding node_modules)

No code outside book-translator calls `export_project`, `exportWithReport` or the `export` command. Only docs and run notes mention it:

| Caller | What it does | Effect of BTT-31 |
|---|---|---|
| `creative-hub/.claude/skills/make-visual-novel/SKILL.md:107` (reader EPUB), `:111` (pack edition), `:143` | `wait_for_progress` until `done`, then `export_project` | Does not break: a run that reaches `done` has no failed or pending chunk. A run that ends `incomplete` (the Ash & Brass case) now gets the refusal message instead of a silent partial book; the message says what to do. |
| `creative-hub/.agents/skills/make-visual-novel/SKILL.md:107`, `:111`, `:139` | same text, the Codex copy | same |
| creative-hub `runs/*.md`, `.claude/tickets/HUB-02,05,16,SCP-10-12/plan.md`; scriptorium `.claude/tickets/REQ-0006,REQ-0008,SCP-10-12/*` | past plans and run logs | none (history) |

Flag: nothing breaks. The skill could add one sentence ("export_project refuses while a chunk is failed or pending: retry_chunk it, or pass allowPartial true") as a hub follow-up; not done here.

## Files and modules to touch

Bug 5:
- `src/engine/pipeline/env.ts:7-16` `CallRequest` (+ `skipModels`), `:30-42` `AgentEnv` (+ `models`).
- `src/engine/pipeline/runner.ts:429-444` `makeEnv` (wire `models`), `:446-492` `makeCall` (skip filter).
- `src/engine/models/router.ts:16-17` `RoutedRequest` (+ `lead`, `skip`), `:93-110` `resolve` (apply them).
- `src/engine/pipeline/translator.ts:70-80` `ask` (return the model, pass the skip list), `:90-151` doc comment and `attempt` (rotation), `:105-133` `accept` (tag retry passes the skip list).
- `tests/pipeline.test.ts:291-318` (`describe('translator retries')`): one new test.

Bug 6:
- `src/shared/protocol.ts:330` the `export` command (+ `allowPartial`), plus the shared `EXPORT_REFUSED` prefix constant next to it; `:392-405` result type keeps its shape; only the doc comment of `warnings?` (`:403`, today "Visual-novel packs: ...") becomes "Any format: what the export had to say (blocks left in the source language, ...)".
- `src/engine/service.ts:488-508` `translations()` (accept already listed chunks), `:510-513` `export()` and `:519-556` `exportWithReport()` (guard and warning), new exported `ExportRefused` error class.
- `src/engine/dispatcher.ts:731-741` (pass `allowPartial`).
- `src/engine/mcp/server.ts:26` INSTRUCTIONS (operator path), `:284` `export_project` (schema field and description).
- `src/engine/cli.ts:170` (`allowPartial: true`), `:190-199` (`--allow-partial`, usage), `src/engine/index.ts:14` (usage line).
- `src/renderer/ui/ProjectView.tsx:113`, `:132-147`, `:179-182` (refusal confirmation, warnings toasts).
- `README.md:84` (CLI line), `:126`/`:147` (MCP review/export notes), one line in the export notes near `:21`.
- Tests: `tests/pipeline.test.ts:158-192` (pause test) and `:320-346` (failed-chunk test), `tests/vnPack.test.ts:713-720` (pack-changed test), one new case in `tests/mcp.test.ts`.
- `ROADMAP.md`.

## Contracts between the tasks

**C1. `CallRequest.skipModels`** (`env.ts`):
```ts
/** Resolved model refs (as `CallResult.model` returns them) that already failed this piece of work. The call starts at the first model of the project's own list for the agent not in it; if that would leave none of the own models, the call is made as today. */
skipModels?: readonly string[]
```
Empty or absent: today's behaviour exactly.

**C2. `AgentEnv.models`** (`env.ts`), so the translator knows whether another own model is left without spending a call:
```ts
/** The project's own models for the agent (agentModels[agent], translatorModel first), resolved and deduplicated, in order. Never the shared fallback rows. Absent: treated as one model, no rotation. */
models?: (agent: AgentName) => string[]
```
Hand-built envs in `tests/agents.test.ts` leave it out and keep today's behaviour.

**C3. Resolution in the runner and the router.**
- Runner helper `ownModels(agent) = this.deps.router.resolve(refs, { exact: true }).map((m) => m.ref)`, where `refs` is today's list (`agentModels[agent]` with `translatorModel` first for the translator, `runner.ts:448-449`). `exact: true` keeps only the listed models (no shared fallback rows), resolved, deduplicated, available. `makeEnv` sets `models: (agent) => this.ownModels(agent)`.
- `makeCall`: the client-only refusal (`runner.ts:451-467`) still runs on the raw `refs` first. When `req.skipModels` is non-empty: `lead = ownModels(agent).filter((m) => !skip.has(m))`; if `lead.length > 0`, call `router.complete(refs, { ..., exact: clientOnly, lead, skip: req.skipModels })`; else call exactly as today. Compare resolved refs, never aliases.
- Router (`RoutedRequest`): `lead?: readonly string[]` and `skip?: readonly string[]` (resolved refs). In `ModelRouter.resolve`, after today's ordering and filtering: drop the `skip` models (unless that empties the list), then move the `lead` models to the front in their order; the rest of the effective list (shared fallback rows included) follows unchanged. So the call starts on the next own model, and a provider error on it still falls back as today. Without `lead`/`skip`, `resolve` is unchanged.
- The rotation (C5) picks the next model only from `env.models('translator')`; once every own model has failed twice, the chunk splits. It never asks a shared fallback row because of a mismatch. A shared row can still answer when an own model has a provider error (unchanged router behaviour); its reply counts under its own ref, and the rotation carries on through the own list.

**C4. `ask` in `translator.ts`** returns `{ parse, model }` where `model` is `CallResult.model`; takes `skipModels` and passes it in the `CallRequest`.

**C5. Rotation in `attempt(group, canSplit)`** (per call of `attempt`, so each half starts afresh):
- `failed: string[] = []`, `note`, `count = 0`, `current: string | undefined`.
- Loop: `{ parse, model } = ask(group, note, count === 0 ? 'translate' : 'retry', skipModels: failed)`. Ok: `accept(group, parse.segments, failed)` and return. Else log `${unit}: segment mismatch on ${model} (${describeParse(p)})`; if `model !== current` reset `count` to 0 and set `current = model` before counting; `count++`.
- When `count === MISMATCHES_PER_MODEL`: add `model` to `failed`; `left = (env.models?.('translator') ?? [model]).filter((m) => !failed.includes(m))`; if `left.length > 0`: log `${unit}: segment mismatch ${MISMATCHES_PER_MODEL} times on ${model}, trying ${left[0]}`, reset `count = 0`, `note = undefined`, continue; else leave the loop.
- After the loop: split as today (`canSplit && group.length > 1`, log "splitting the chunk in two", two `attempt(half, false)`), else `throw new ChunkFailure(... (${note}))` with the existing text.
- A model the router fell back to on a transport error is counted under the model that answered (`CallResult.model`), which is correct.
- `MISMATCHES_PER_MODEL = 2`, a module const.

**C6. Export option and error shape.**
- Service: `exportWithReport(id, outPath?, opts: { cover?: 'source' | 'title'; allowPartial?: boolean })`; `export()` takes the same `opts`.
- Protocol: `{ type: 'export'; projectId: string; outPath?: string; cover?: 'source' | 'title'; allowPartial?: boolean }` (doc comment: "false/absent: refused while a block is untranslated; true: exports anyway, with a warning").
- Refusal: `class ExportRefused extends Error` (`name = 'ExportRefused'`), message starts with the shared constant `EXPORT_REFUSED = 'export refused:'` (in `src/shared/protocol.ts`, importable by the renderer). Only the message crosses the wire: dispatcher reply `{ ok: false, error: message }` (`dispatcher.ts:815`), MCP `isError: true` with the message (`server.ts:39`), CLI `error: <message>` and exit code 1 (`index.ts:46-49`), UI matches `message.startsWith(EXPORT_REFUSED)`.
- Message (one line, chunk lists capped at 20 indexes then "and N more", a failed chunk's error cut to 160 chars):
  `export refused: 19 block(s) would stay in the source language: chunk 37 failed (the model did not return the segments correctly ...); chunks 38, 40 pending. Retry a failed chunk with retry_chunk (optionally with model: another model), finish the run with start_translation, or export with allowPartial: true.`
  Groups appear only when non-empty: `failed` (with each error), `pending`, `in progress` (the IN_PROGRESS_STATES). No chunk files yet: `export refused: nothing is translated yet (N block(s)). Start the translation (start_translation or prepare_chunks) first, or export with allowPartial: true.`
- Warning (allowPartial and blocks untranslated), through the existing `onWarning` (`service.ts:536-540`): `19 block(s) stay in the source language: chunk 37 failed; chunks 38, 40 pending` (no errors, no hint). A complete project gives no warning with or without `allowPartial`.
- Result: unchanged shape; `warnings` already reaches MCP and CLI (`dispatcher.ts:739`, `cli.ts:180`).
- Counting: `chunks = store.listChunks(id)`; `translations = this.translations(id, chunks)`; untranslated blocks = distinct `seg.blockId` over all chunk segments with `!translations.has(blockId)` (a split block counts once and only when it is incomplete); a chunk is named when it has such a block or its state is not `done`/`flagged`. No chunks: the blocks of `planChunks(ir, <any budget>)` (the block set does not depend on the budget). The guard runs before `fs.mkdir` and before the `vnp` branch, so a refusal writes nothing.

## Tasks for workers

Two workers can run in parallel (T1 and T2 touch different files); T3 and T4 depend on T2's contract only; T5 last.

### T1. Bug 5: rotate the translator before the split (commit 1)
- Inputs: C1-C5; `env.ts`, `runner.ts:429-492`, `translator.ts:70-156`; `tests/pipeline.test.ts:291-346`, `tests/pipelineHelpers.ts` (rig, `MODEL`, `QA_MODEL`, `r.mock.calls` has `model` and `meta`).
- Do: add `skipModels` and `models` (C1, C2); router `lead`/`skip` in `resolve`, runner helper `ownModels` and the `makeCall` change (C3); `ask` returns the model (C4); rotation in `attempt` (C5); `accept` passes `failed` as `skipModels` to its `retry-tags` call so it stays on the model that answered; update the `translateChunk` doc comment (`translator.ts:90-96`).
- Outputs: the new test (below) passes; the existing tests at `pipeline.test.ts:292`, `:304`, `:320` and `tests/agents.test.ts` pass unchanged; typecheck, lint.
- Check while implementing: that `router.resolve([MODEL, QA_MODEL], { exact: true })` in the test rig keeps that order, and how the rig's registry takes a shared fallback list (`defaults.shared`, `fallbacks`, `registry.ts:138-170`) for R5. Verify `registry.resolve` of an `acp/...` ref returns the same string as the list entry (research open question; C3 compares resolved refs either way).

### T2. Bug 6: the guard and the warning in the service (commit 2, with T3 and T4)
- Inputs: C6; `service.ts:486-566`; `src/shared/project.ts` (`IN_PROGRESS_STATES`), `chunker.ts` (`planChunks`).
- Do: `translations(id, chunks?)`; `ExportRefused`; `EXPORT_REFUSED` constant in `src/shared/protocol.ts`; the counting and message helpers (a small pure function `untranslatedReport(chunks, translations)` returning `{ blocks, failed: {index, error}[], pending: number[], running: number[] }` plus `formatRefusal`/`formatWarning`); guard before `mkdir`; warning through `onWarning` before the `vnp` branch; doc comments of `export`/`exportWithReport` ("Works with partial progress" becomes "refuses ... unless allowPartial").
- Outputs: the changed tests at `pipeline.test.ts:181` and `:333-345` pass; `vnPack.test.ts:720` updated (below); full suite green.

### T3. Bug 6: wiring through protocol, dispatcher, MCP and CLI
- Inputs: C6, T2's service signature.
- Do: protocol `allowPartial` (`protocol.ts:330`) and the `warnings?` doc comment (`:403`); dispatcher passes `allowPartial: cmd.allowPartial === true` (`dispatcher.ts:732`); MCP `export_project` gets `allowPartial: z.boolean().optional().describe('Default false: refused while any block is untranslated (a failed or pending chunk); the error names the chunks. true: export anyway, untranslated blocks keep the source text and warnings says which')` and passes it; tool description: drop "partial progress works ...", say it refuses with untranslated blocks unless `allowPartial`; INSTRUCTIONS `server.ts:26`: after "then export_project" add "(it refuses while a chunk is failed or pending and names them: retry_chunk them, or pass allowPartial true to export anyway with a warning)". CLI: `engine translate` end (`cli.ts:170`) passes `{ allowPartial: true }` (it still exits 1 when not done and prints `note:` lines); `engine export` reads `argv.includes('--allow-partial')`; usage strings `cli.ts:194`, `index.ts:14`, doc comment `cli.ts:190`; README `:84`, `:126`/`:147`, and an export note near `:21`.
- Outputs: the new MCP test passes; typecheck.

### T4. Bug 6: the UI
- Inputs: C6 (`EXPORT_REFUSED`, `allowPartial`), `ProjectView.tsx:113-147`, `:179-182`; the inline confirm pattern in `src/renderer/ui/ProjectsList.tsx:38-47`; `attempt`/`toast` in `src/renderer/store/store.ts:295-302`, toast kinds `'error' | 'info'`.
- Do: one `exportFor(action: 'open' | 'read', allowPartial = false)`: sends `{ type: 'export', projectId: id, allowPartial }` in a try/catch (not `attempt`, so the refusal can be told apart); a message starting with `EXPORT_REFUSED` sets `refused = { message, action }`; any other error toasts as today. Success: `open` toasts `Exported to <path>` and shows the folder, `read` opens the reader; then each `res.warnings` entry is a toast `Export warning: <text>` (kind `error`, so it reads as a problem; no new kind). While `refused` is set, the row with the Export button shows the message (`small`), `Export anyway` (`data-testid="export-anyway"`, resends with `allowPartial: true` and finishes the same action) and `Cancel` (`data-testid="export-cancel"`). Update the two button titles ("Writes the document; asks first when something is untranslated").
- Outputs: typecheck and lint. No renderer test exists; the UI is UNTESTED until the user's live check (the app is in use now).

### T5. Roadmap and wrap-up
- Add to `ROADMAP.md`, directly under the intro paragraph, a new section (same style as the *The Rooster* section):

```md
## Open: found by the hub's *Ash & Brass* run (2026-11-15)

- **BTT-31 (branch `BTT-31_retry-and-export`; creative-hub REQ-0025, bugs 5 and 6; plan `.claude/tickets/BTT-31-retry-and-export/plan.md`): a segment mismatch never reached the next model, and an export with a failed chunk was silent.** Book 2 hr: chunk 37 failed four times on `acp/claude/claude-sonnet-5` (twice, split, twice) while `acp/antigravity/gemini-4-argon`, second in the translator list, was never asked; it translated the chunk on the first manual `retry_chunk`. The router falls back only on provider errors, and a mismatch is a reply that arrived. Then `export_project` wrote the book with 19 English paragraphs and no warning. Fix: (1) two mismatches on a model move the chunk to the next model of the role's list (`CallRequest.skipModels`), the split comes only after every model failed, each switch is logged, and a one-model list is unchanged; (2) export refuses while any block is untranslated (a failed or pending chunk), naming the chunks, the block count and `retry_chunk`; `allowPartial: true` (MCP, protocol, CLI `--allow-partial`, the app's "Export anyway") exports anyway with a warning; `engine translate` passes it.
```
  When done, the implementer changes the opening to "done on branch `BTT-31_retry-and-export`, not merged" and adds what was not done, as BTT-30 does.
- Commits: `BTT-31: roadmap item for retry on the next model and export with untranslated blocks` (roadmap), `BTT-31: a segment mismatch moves the chunk to the next model before the split` (T1), `BTT-31: export refuses with untranslated blocks unless allowPartial, and warns` (T2-T4). Heredoc messages, blank line after the subject.
- Changelog in this folder (the `implement` skill).

## Tests

Follow test-discipline: one new test per bug where the behaviour is new, the rest by changing existing tests that already set up the case.

### Reproduction tests that fail before the fix

**R5, bug 5** (new, `tests/pipeline.test.ts`, in `describe('translator retries')`): "moves to the next model after two mismatches, and splits only when every model failed".
- `r.create({ agentModels: { glossary: [MODEL], translator: [MODEL, QA_MODEL], proofreader: [MODEL], qa: [QA_MODEL] } })`, with the registry given a shared fallback list that has a third mock model (`mock/mock-fallback`, registered in the mock provider and echoing correctly) as a row after the own models, so the router's effective translator list is `[mock-translator, mock-reviewer, mock-fallback]`.
- Mock translator: `chunk-2` on `mock-translator` answers with the last segment dropped; `chunk-2` on `mock-reviewer` echoes `[hr]`. `chunk-3` with 3 or more segments answers with the first segment dropped on both models; fewer segments (the halves) echo. Everything else echoes.
- Expect: status `done`; the `(model, task)` sequence of `r.mock.calls` for `chunk-2` is `[mock-translator translate, mock-translator retry, mock-reviewer translate]`, its `chunk.model` is `mock/mock-reviewer`; for `chunk-3` it is `[translator translate, translator retry, reviewer translate, reviewer retry, translator translate, translator translate]` (split after both models, halves start at the list head), every segment final starts with `[hr] `; `mock-fallback` gets no translator call at all (`r.mock.calls` filtered by that model is empty), even though chunk 3 used up both own models; the project log (`r.events` of type `log`) has a line matching `/chunk-2: segment mismatch 2 times on mock\/mock-translator, trying mock\/mock-reviewer/`.
- Before the fix: chunk 2 goes `translate, retry, translate, translate` on `mock-translator` only, its halves fail on the dropped segment or end with `chunk.model` `mock/mock-translator`; chunk 3 splits after two calls. The test fails on the first sequence assertion.

**R6, bug 6** (change of the existing test `tests/pipeline.test.ts:320` "marks a chunk failed, carries on with the others, and retries it on request", lines 333-337 and after 345):
- Replace "export works: the failed chunk's blocks keep the source text" by:
  - `await expect(r.service.exportWithReport(id)).rejects.toThrow(/^export refused: \d+ block\(s\) would stay in the source language: chunk 3 failed .*retry_chunk.*allowPartial/)`, and the default output file does not exist afterwards;
  - `const partial = await r.service.exportWithReport(id, undefined, { allowPartial: true })`: the file contains `\n${failedText}\n` and `[hr] `; `partial.warnings` is exactly one entry matching `/^\d+ block\(s\) stay in the source language: chunk 3 failed/`.
- After the successful `retryChunk` (line 345): `expect((await r.service.exportWithReport(id)).warnings).toEqual([])`.
- Before the fix: the first `exportWithReport` resolves, so the `rejects` assertion fails.

### Changes to existing tests
- `tests/pipeline.test.ts:181` (pause then partial export): `service.export(id)` becomes `service.exportWithReport(id, undefined, { allowPartial: true })`; keep the two `toContain` checks on its file; add `expect(report.warnings).toEqual([expect.stringMatching(/stay in the source language: chunks? [\d, ]+ pending/)])`. This proves the pause-then-partial-export path keeps working with a warning. Line 190 (export after `done`) is unchanged and proves no refusal and no warning on a complete project.
- `tests/pipeline.test.ts:304` ("splits the chunk in half when the retry fails too", one model) stays unchanged: it proves a one-model list keeps `['translate', 'retry', 'translate', 'translate']`. `:292` and `:320`'s failure part stay unchanged too.
- `tests/vnPack.test.ts:720` (pack changed; the project was never started, so it has no chunks and the new guard would answer first): pass `{ allowPartial: true }` so the test still reaches the pack-hash check it is about.
- Any other export in the suite is of a finished project (checked: `dispatcher.test.ts:88,654`, `mcp.test.ts:192,270,318`, `pipeline.test.ts:49,78,502,527`, `vn.test.ts:290-464`, `vnPack.test.ts:684-705,792,816`); if one fails, it exported partial progress on purpose: add `allowPartial` there, do not weaken the guard.

### New wiring test
- `tests/mcp.test.ts`, operator flow: "export_project refuses while a chunk failed, and exports with allowPartial". Translator mock answers `garbage` for `chunk-2`; start, wait until not running; `export_project {projectId}` gives `isError: true` with text starting `export refused:` and naming chunk 2; `export_project {projectId, allowPartial: true}` returns a `path` and `warnings` with one entry naming chunk 2. Proves the field reaches the service through MCP and the dispatcher and the error text reaches the client unchanged.

Not added (covered or not worth a test): the `makeCall` fallback to the full list when every model is skipped (defensive; the translator never asks with the whole list skipped because `models` says nothing is left); CLI `--allow-partial` and the `translate` ending (one-line wiring, typecheck); the UI (no renderer tests; live check).

## Acceptance criteria

| # | Criterion | Proved by |
|---|---|---|
| A1 | Two mismatches on a model move the chunk to the next model of the translator list, with a fresh `translate` call | R5 (chunk 2 sequence, `chunk.model`) |
| A2 | The split comes only after every model of the list failed twice; the halves start at the list head | R5 (chunk 3 sequence) |
| A2b | A mismatch moves a chunk only within the project's own list for the agent, never to a shared fallback row; the router's provider-error fallback is unchanged | R5 (`mock-fallback` never called); existing `tests/router.test.ts` green |
| A3 | Each switch is logged with both model refs | R5 (log line) |
| A4 | A one-model list behaves as today | `pipeline.test.ts:304` and `:320` unchanged and green |
| A5 | Export refuses while a chunk is failed, names the chunk, the block count, `retry_chunk` and `allowPartial`, and writes nothing | R6 |
| A6 | `allowPartial: true` exports with the source text for the missing blocks and one warning naming the chunks and count | R6 |
| A7 | A complete project exports with no warning | R6 after `retryChunk`; `pipeline.test.ts:190` |
| A8 | Pause then partial export works with `allowPartial` and a warning; without it, pending chunks refuse | changed `pipeline.test.ts:181` (with); the guard counts pending (R6 message format, same helper) |
| A9 | MCP `export_project` accepts `allowPartial`, returns the refusal as `isError` with the message, and the warnings | new `mcp.test.ts` case |
| A10 | CLI: `engine translate` still writes the file with `note:` lines when chunks failed; `engine export --allow-partial` works; without it the CLI prints `error: export refused: ...` and exits 1 | typecheck; UNTESTED otherwise (not run while the production uses the app) |
| A11 | UI: Export and Read translation show the refusal with "Export anyway"/"Cancel"; "Export anyway" finishes the action; warnings appear as toasts | typecheck and lint; UNTESTED until the user's live check |
| A12 | Docs (MCP description and instructions, CLI usage, README) say export refuses unless `allowPartial` | review of the diff |
| A13 | Full suite, `typecheck` and `lint` green | `yarn test`, `yarn typecheck`, `yarn lint` (yarn under fnm: put the fnm default alias dir on PATH; `fnm exec yarn` fails) |

## Decided (director, 2026-11-15)

- `allowPartial` adds a warning whenever a block is untranslated; a complete project exported with `allowPartial` gets no warning.
- A mismatch rotates only through the project's own list (`agentModels[agent]`, `translatorModel` first), never through the shared fallback rows; then the split.

## Open points for the reviewer

- A chunk translated partly by the second model mixes models; `chunk.model` records only the last one (as today).
- Cost: worst case per chunk goes from 2 + 2 + 2 calls to 2M + 2M + 2M with M models (12 with two). Free ACP models in practice.
