# BTT-11: Roadmap fixes (client tasks, providers reload, client context, seed migration, localized VN names, book-folder picker)

Ticket folder: `.claude/tickets/BTT-11-roadmap-fixes/` (`plan.md` and `changelog.md`, as in BTT-08 and BTT-09)
Branch: `BTT-11_roadmap-fixes`, cut from `master` at 46747f8 (the BTT-10 merge; the tree is clean)
Repo: `C:\projects\Personal\book-translator`. Node comes from fnm: in PowerShell run `fnm env --use-on-cd | Out-String | Invoke-Expression` first.

## Context

The hub roadmap (`C:\projects\Personal\creative-hub\ROADMAP.md`, the "Book Translator" section and the cross-cutting X1 item) lists open gaps. The user asked to "fix all of them fully". Each item was checked against master at 46747f8.

| Item | Status on master | Summary |
|---|---|---|
| X1 Prompt sent twice | **Open** | `clientTaskResult` adds `messages` whenever there are 2 or more messages, which is every task. |
| B1 providers.md not reloaded | **Open** | `registry.load()` runs only at boot and on explicit commands. Nothing watches the file. |
| B2 Client context 8192 | **Open, and the BTT-10 seed fix does nothing** | The seed puts `context: 200000` on the *provider*. The schema and registry only read `context` on a *model*. |
| B3 Seed entries for existing folders | **Open** | `initDataFolder` copies only missing files. There is no migration. |
| B4 Localized VN names | **Open** (feature) | The bible and cover brief are copied. Names are pinned in the glossary as `Name -> Name`. |
| B5 New project picks a book folder | **Open, plus a bug** | "Open a folder" turns a Scriptorium book folder into a *batch* of `book.md` + `outline.md`, and the chapters are ignored. |
| B6 Real-model live runs | Verification only | No code. See the last section. |

Rules for the implementer:
- Never read or write `~/BookTranslator` from tests or scripts. Tests use temp data folders (`tests/helpers.ts` `tempDir` / `seededRegistry`, `tests/pipelineHelpers.ts` `rig`).
- Do not run `yarn build` / `yarn dist`. The hub may run the engine from `out/`.

---

## X1. A client task carries the prompt twice

**Status:** open.

**Root cause**
- `src/engine/models/client.ts:264`:
  ```ts
  ...(t.messages.length > 1 ? { messages: t.messages.map((m) => ({ role: m.role, content: m.content })) } : {}),
  ```
  `buildMessages` (`src/engine/pipeline/prompts.ts:62-75`) always produces `[system, user]`. So every task returns `system` + `user` and then the same text again in `messages`.
- The only multi-turn request is the JSON repair round in `chatJson` (`src/engine/pipeline/llm.ts:88-95`: `...messages, assistant, user`).
- `src/shared/protocol.ts:192` documents the current behaviour ("Only when the request has more than one message").
- `tests/client.test.ts:232` asserts it: `expect(task.messages).toHaveLength(2)`.

**Fix**
- `src/engine/models/client.ts` `clientTaskResult`:
  ```ts
  const rest = t.messages.filter((m) => m.role !== 'system')
  // `messages` only when `system` + `user` cannot say it all: a repair round (an assistant turn) or several user turns
  const multiTurn = rest.some((m) => m.role === 'assistant') || rest.filter((m) => m.role === 'user').length > 1
  ...(multiTurn ? { messages: t.messages.map((m) => ({ role: m.role, content: m.content })) } : {}),
  ```
  `system` and `user` stay exactly as they are, so nothing changes for clients that read only those two fields.
- `src/shared/protocol.ts:190-193`, the doc comments:
  - `user`: "The user and assistant messages in order, joined."
  - `messages`: "Only for a multi-turn request (an assistant turn, such as a JSON repair round, or more than one user message): the conversation in order; answer its last user message."
- `src/engine/mcp/server.ts:232`, the `get_client_task` description: add "messages (only for a multi-turn request such as a JSON repair round: answer its last user message)".

**Tests**, in `tests/client.test.ts`:
- Change line 232 to `expect(task.messages).toBeUndefined()`.
- New `describe('clientTaskResult')`, using a `ClientTaskQueue` and `clientTaskResult` (import it):
  - `[system, user]`: no `messages`. `system` and `user` are filled.
  - `[system, system, user]`: no `messages`.
  - `[system, user, assistant, user]` (the repair shape from `chatJson`): `messages` has 4 entries in order, and `user` holds all three non-system texts.
  - `[system, user, user]`: `messages` is present.
- New end-to-end case. A rig on the client provider with a glossary task. The client's first answer passes the queue's schema check but fails the zod schema, so `chatJson` makes a repair round. One way: put a structurally valid but zod-invalid value in a field that the light checker ignores. If that is impractical, drive `chatJson` directly with a `ChatFn` that goes through `ClientProvider`. The second leased task (`#2`) has `messages` with an `assistant` turn.

**Acceptance:** a normal `get_client_task` reply has no `messages` key. A repair-round task has it.

---

## B2. A client model without `context` is planned at 8,192 tokens

**Status:** open. BTT-10 (323e16c) tried to fix it in the seed, but the fix has no effect.

**Root cause**
- `seed/config/providers.md:140` sets `context: 200000` at the **provider** level of `client`.
- `providerEntrySchema` (`src/shared/schemas.ts:35-66`) has no provider `context`. It is a `looseObject`, so the key is kept but never read.
- `ModelRegistry.load` (`src/engine/models/registry.ts:187`) takes only `m.context`.
- `contextLength` (`registry.ts:421-424`) falls back to `DEFAULT_CONTEXT = 8192` (`registry.ts:99`).
- Result: a new data folder plans `client/claude-code` at 8192. The user's own `~/BookTranslator` was fixed by hand with `context` at model level, so it works today. A fresh seed does not.

**Effect** (`chunkBudget`, `src/engine/chunker.ts:33-38`):
- At 8192, translator chunks cap at 2418 source tokens. So any chunk size above about 2400 is cut down.
- Glossary passes (`service.ts:226`, `pipeline/glossary.ts:182`) shrink from 6000 to about 3259 tokens, so the glossary needs about twice as many passes.

**Fix**
1. `src/shared/schemas.ts` `providerEntrySchema`: add `context: z.number().int().positive().optional()` with the doc comment "Context window for this provider's models that have no `context` of their own".
2. `src/engine/models/registry.ts`:
   - Export `CLIENT_DEFAULT_CONTEXT = 200_000`, with the comment "the context of Claude Code, the usual client".
   - In `load()`, for providers.md models: `const ctx = m.context ?? p.context ?? (p.kind === 'client' ? CLIENT_DEFAULT_CONTEXT : undefined)`.
   - Use `ctx` in place of `m.context` in both branches of line 187. The `load_models` branch becomes `Math.min(ctx ?? Infinity, ...)`.
   - Update the `contextLength` doc comment: "... else `context` of the model or its provider in providers.md (200000 for a `client` provider), else 8192".
3. `seed/config/providers.md`:
   - Move `context: 200000` from the provider to the `claude-code` model, under `family: claude`. Keep the line order `id`, `kind`, `enabled` at the top of the entry: `tests/client.test.ts` `clientRig` matches it with a regex.
   - Body, "Fields of a provider": add "`context`: the context window of the provider's models that have none of their own."
   - Body, "Context size" paragraph: "... `context` from this file (the model's, else the provider's), 200000 for a `client` provider, and 8192 if that is missing."
   - Line 182 says the client provider "is switched off in a new data folder". Since BTT-10 that is wrong: change it to "enabled". Line 184 is rewritten in B3.
4. `README.md:129`: drop "add `context: 200000` by hand" (it is the default now). The B3 wording replaces the rest of that step.
5. `src/engine/cli.ts` `listModels` (line ~36) prints `(default)` when `m.context === undefined`. Base the note on `contextLength` vs `m.context`, so the client model's 200000 is not shown as "(default)". Small change, optional.

**Tests**
- `tests/registry.test.ts`, the test 'reports the effective context' (line 49): add `expect(r.contextLength('client/claude-code')).toBe(200000)`.
- New test 'a client model takes its context from the model, then the provider, then 200000'. Write a providers.md with three providers: `client` (kind client, model with `context: 50000`), `client2` (kind client, provider `context: 120000`, model without context), `client3` (kind client, no context anywhere). Expect 50000, 120000 and 200000. An `openai-compat` model with no context, under a provider with `context: 64000`, gives 64000. `mock/mock-translator` stays 8192.
- `tests/registry.test.ts`, the test 'loads the providers and models': assert `client` is available and local.

**Acceptance:** a fresh seeded registry reports 200000 for `client/claude-code`. An older providers.md with provider-level `context` works too.

---

## B1. `config/providers.md` is not reloaded while the engine runs

**Status:** open.

**Root cause**
- `registry.load()` runs at boot (`src/engine/serve.ts:57`).
- Otherwise only from explicit commands: `refreshModels`, `setSecret`, `saveProviders`, `setDefaults` and the models dialog (`src/engine/dispatcher.ts:278, 411, 439, 445, 451`).
- The only timer is the slot sync (`serve.ts:70`, `SLOT_SYNC_MS = 10_000`, `dispatcher.ts:39`), and it never re-reads files.
- Scriptorium reloads on change with a chokidar watcher (`scriptorium/src/engine/engine.ts:556-595`). Book Translator has no chokidar dependency.

**Design** (decision: mtime polling, no new dependency)
1. `src/engine/models/registry.ts`
   - Add `private configStamp = ''` and `async configSignature(): Promise<string>`. It stats `config/providers.md`, `config/models.md` and `config/defaults.json` and joins `mtimeMs:size` per file (`missing` for ENOENT).
   - In `load()`, compute the signature **before** reading the files. Store it in `configStamp` only after a successful load.
   - Add `async configChanged(): Promise<boolean>`.
   - Add `markConfigSeen(sig: string)`, so a broken file is not retried every tick.
   - Keep the LM Studio loaded contexts across a reload (collect `loadedContext` per ref before rebuilding, copy back after).
2. `src/engine/dispatcher.ts`
   - Add `async reloadConfigIfChanged(): Promise<boolean>`: serialized with `private reloading?: Promise<boolean>`; compare signature; on change `await applyModelDefaults(this.registry, this.dataDir)`, `await this.registry.load()`, log info "config changed on disk, providers and models reloaded", `limiter.wakeAll(p)` per provider, `this.emitModels()`, `void this.discover().then(() => this.emitModels())`, return true.
   - On error: `registry.markConfigSeen(sig)`, log `warn` once: "config/providers.md (or models.md / defaults.json) could not be read, keeping the previous providers: <message>". Return false.
   - At the top of `handle(cmd)`, for `listModels`, `analyze`, `createProject`, `start`, `resume` and `retryChunk` (check the exact names in `shared/protocol.ts`), run `await this.reloadConfigIfChanged()`.
3. `src/engine/serve.ts` `bootEngine`: `export const CONFIG_CHECK_MS = 3000` (in `dispatcher.ts`, next to `SLOT_SYNC_MS`); a second `setInterval(..., CONFIG_CHECK_MS)` with `unref()`, cleared in `stopTimer`.
4. Parked client tasks survive a reload (the queue is the service's; no change, but a test guards it).
5. Docs: `seed/config/providers.md:156` ("reads this file when it starts, and again within a few seconds when it changes"), line 184 (no restart), `README.md` "Providers and API keys", `INSTRUCTIONS` (`src/engine/mcp/server.ts:27`) and the prompt text at `server.ts:325`: remove "restart".

**Limitations** (changelog, not fixed): a running project keeps its chunk plan; a request already waiting in `limiter.acquire` holds the old `ProviderInfo` until it wakes.

**Tests**
- `tests/registry.test.ts` `describe('config reload')`: `configChanged()` false after load; rewrite providers.md with client `context: 100000`, bump mtime with `fs.utimes`; true; after `load()` false and `contextLength('client/claude-code') === 100000`.
- `tests/dispatcher.test.ts` `describe('config reload')`: add provider `extra` (kind mock, model `x`), bump mtime, `listModels` lists `extra/x` with no `refreshModels`; `reloadConfigIfChanged()` false right after; a `models` event was emitted; invalid YAML → false, previous models stay, exactly one warn, second call none; fix the file → true.
- `tests/client.test.ts`: a waiting `router.complete`, then edit providers.md (client `concurrency: 4`) and reload; `lease()` + `submit()` still resolves the original promise.

**Acceptance:** adding `client` or changing a model's `context` in a running engine shows in `list_models` at once or within 3 s, no restart. Parked client tasks are not lost. A broken file keeps the previous config and logs once.

---

## B3. Seed entries added later never reach existing data folders

**Status:** open.

**Root cause:** `src/engine/store/dataFolder.ts:53-72` `copyTree` copies each seed file with `COPYFILE_EXCL`. A `config/providers.md` from before BTT-09 never gets `client`. Prompt files are whole files (missing ones are copied) and `defaults.json` uses zod defaults, so only **provider entries inside `providers.md`** need a migration.

**Design**
- New module `src/engine/store/migrate.ts`, called by `initDataFolder` (app/headless `serve.ts:51` and CLI `cli.ts:19`).
- Never overwrite user edits: existing entries unchanged; text, comments and order kept (yaml `parseDocument`); **a provider the user deleted is not added back.**
- State file `config/seed-state.json`: `{ "providers": [...ids offered...] }`.
  - Freshly seeded folder: all seed ids, nothing added.
  - Legacy folder (no state): starts from `LEGACY_SEED_PROVIDERS = ['deepseek','openai','openrouter','anthropic','gemini','lmstudio','strata','ollama','custom','mock']` plus ids already in the file. So only `client` is new for legacy folders.
  - Missing = seed ids not in the file and not offered → copied in. Afterwards state = offered ∪ every seed id.

```ts
export interface MigrationResult { added: string[]; warnings: string[] }
export async function migrateProviders(dataDir: string, seedDir: string, opts: { fresh: boolean }): Promise<MigrationResult>
```

Steps:
1. If `fresh`: write the state with all seed ids and return.
2. Read the user's providers.md (`splitFrontmatter` + `parseDocument`). On no frontmatter / YAML errors / `providers` not a sequence: warning, return **without** writing the state.
3. Parse the seed file; clone each missing id's item node (`node.clone()`, else `doc.createNode(item.toJSON())` + `commentBefore`).
4. Insert before the `id: mock` item if any, else at the end.
5. Validate with `providersSchema.safeParse(doc.toJS())`; on failure warn, write nothing.
6. Output `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`, preserving CRLF if the original used it; body byte for byte.
7. `atomicWrite` providers.md, then `seed-state.json` (pretty, sorted).

`initDataFolder`: after `copyTree`, if the seed has `config/providers.md`, call `migrateProviders(..., { fresh: result.copied.includes('config/providers.md') })`. Add `migrated` and `warnings` to `InitResult`. `bootEngine` logs `[engine] config/providers.md: added <ids> from the seed` and warnings to stderr, and once through the dispatcher log. `cli.ts` `loadRegistry` writes the same to stderr.

Behaviour notes: `client` is added as the seed has it (enabled, local, concurrency 8, model `claude-code` with context 200000). An existing disabled `client` stays disabled. Docs: `seed/config/providers.md:184`, `README.md:129` and "Data folder", `INSTRUCTIONS` `server.ts:27` and `:325`.

**Tests** (`tests/dataFolder.test.ts`, `describe('seed migration')`): fresh folder; legacy folder (remove `client` and `ollama`, keep `# my note` and `deepseek concurrency: 3` → `migrated: ['client']`, comment and edit kept, no `ollama`, `client` before `mock`, schema parses, registry sees `client/claude-code` with 200000, body unchanged); second run unchanged (byte compare); user deletes `client` after migration → not re-added; CRLF preserved; invalid providers.md → one warning, untouched, no state; future seed provider `newone` added and nothing else.

**Acceptance:** an existing folder without `client` has it after one start, enabled, context 200000; edits and comments survive; deleted providers stay deleted; a fresh folder is unchanged.

---

## B5. The New project screen cannot pick a book folder

**Status:** open, plus a bug: "Open a folder" and drag-and-drop turn a book folder into a batch of `book.md` + `outline.md` (`src/renderer/ui/NewProject.tsx:142-150, 275-281`, `listDocuments` in `src/main/index.ts:90-99`). The engine already handles folders (`formats/index.ts:30-44`).

**Fix**
1. New `src/main/folders.ts` (no electron import): `isBookFolder(dir)` (book.md + chapters/, same as `isVnFolder` in `formats/vn.ts`, duplicated with a comment) and `listDocuments(dir, extensions)`: a book folder → `{ folder, files: [folder], book: true }`; else documents by extension plus subfolders that are book folders, sorted `localeCompare(..., { numeric: true, sensitivity: 'base' })`.
2. `src/shared/protocol.ts`: `FolderListing.book?: boolean`; `BookTranslatorApi.pickBookFolder(): Promise<string | null>`.
3. `src/main/index.ts`: use `./folders` `listDocuments` in `host:pickFolder` and `host:listFolder`; add `host:pickBookFolder` (env override `BOOK_TRANSLATOR_PICK_BOOK_FOLDER`, title "Choose a visual-novel book folder (book.md and chapters/)", throws `Not a visual-novel book folder: it needs book.md and a chapters folder`).
4. `src/preload/index.ts`: `pickBookFolder`.
5. `NewProject.tsx`: button "Open a book folder" (`data-testid="choose-book-folder"`) → `openFile(dir)`; `FORMATS` text adds "or a visual-novel book folder"; a VN note for `f?.format === 'vn'`.
6. `README.md:182` updated.

**Tests:** new `tests/folders.test.ts` (sorted documents; soother copy → book; folder with two books and a txt; book.md without chapters is not a book; bad input rejects). `yarn typecheck` covers the wiring.

**Acceptance:** "Open a book folder" gives one `VN` project; "Open a folder" and drop of a book folder also give one project.

---

## B4. Translated character names for visual-novel folders (opt-in)

**Current behaviour:** `src/engine/formats/vn.ts:281-283` copies `bible/bible.md` and `cover-brief.md`; `bibleNames` (`vn.ts:309-322`); `service.ts:184-186` seeds `Name -> Name`; `VN_BRIEF_NOTE` (`vn.ts:384-387`) says names stay; speaker tags kept (`vn.ts:94-128`). VN Studio (`visual-novels-orchestrator/src/engine/vn/align.ts:99-118, 188-199`) matches edition characters by name else bullet position, so localized names must appear together in speaker tags, `ON SCREEN:` names and the bible's bold names, in the same bullet order.

**Design** (default off; the glossary is the name map)
- `ProjectSettings.localizeNames?: boolean` (`src/shared/project.ts`), ignored for other formats.
- Name map = glossary `person` entries whose source matches a character label (`normalizeTerm`) and whose target differs.
- Character labels = bible names ∪ script speaker labels (regex `^<1>\**\s*([^(:*<]+?)\s*\**(?:\s*\([^)]*\))?\s*:\**\s*<\/1>`), title-cased; bible spelling wins.

**On export** (only when on and the map is not empty):
- Spoken line: `LABEL` → `target.toLocaleUpperCase(langCode)`, expression and `**` kept; validate with `classifyScriptLine`; if invalid (no capitals, too long, `:` or `(`) keep the source label and warn once per name.
- `ON SCREEN:` line: split at top-level commas; rename each item's leading name.
- `bible/bible.md`: only `- **Name**` bullets under `## Characters` / `## Likovi` renamed, order kept.
- `cover-brief.md`: copied as now.
- Narration and speech: the translator uses the glossary names (localized format note).
- Two characters → same target: warning, renames still applied.

**Pipeline** when `format === 'vn' && localizeNames`:
1. `service.createProject`: no identity name entries; export `KEEP_NAME_NOTE`.
2. `buildGlossary` option `localizeNames?: string[]` appends to `briefInstruction`: "The character names of this visual novel are localized for {targetLanguage} readers: add a term of type person for each of these names with the form {targetLanguage} readers should see, the same form everywhere (it also becomes the speaker tag); keep a name only when it already suits {targetLanguage}: ...". `ProjectRunner.glossaryStage` (`runner.ts:149-178`) passes labels; `existing` skips identity entries with `KEEP_NAME_NOTE`.
3. New `src/engine/pipeline/names.ts`: `characterLabels(ir)`, `ensureNameEntries(store, projectId, ir)` (missing labels get identity `person` entries with note 'character name: no localized form yet, change Target to localize it'), `nameMap(glossary, labels)`. Call `ensureNameEntries` after `writeGlossary` (before the `pauseAfterGlossary` stop), before `prepareChunks` in `run()`, and in `service.prepareChunks`. Log info when the glossary agent is off.
4. `formatNote(format, opts?)` / `briefWithNote(brief, format, opts?)`; new `VN_BRIEF_NOTE_LOCALIZED` ("Character names are localized: write every name as the glossary gives it, in narration and in what characters say. Still copy the speaker tag such as <1>PETRA (grumpy):</1> unchanged; the app writes the localized name into it."). Callers `runner.ts:303`, `service.ts:383`.
5. Export: `WriteOptions.names?: Record<string, string>` (`src/shared/ir.ts`); `service.export` computes it; `writeVnFolder` uses exported `localizeScriptNames(text, names, lang, onWarning)` (body only, line endings and count kept) and `localizeBible(text, names)`. With no names the output is byte-identical.
6. Settings: MCP `create_project` / `update_project_settings` gain `localizeNames` (description as designed); `INSTRUCTIONS` sentence; CLI `translate --localize-names`; UI checkboxes `localize-names` (NewProject) and `settings-localize-names` (ProjectSettingsTab, disabled while locked).
7. `updateProjectSettings` warns in the project log when `localizeNames` changes after chunks are done ("localizeNames changed: chunks translated before keep the names they have, retry them to follow the new setting").

**Tests** (`tests/vn.test.ts`): `localizeScriptNames` (PETRA→PETRICA with expression, BLUE DRAGON→PLAVI ZMAJ, ON SCREEN lists, narration and SCENE unchanged, line count and CRLF kept, CJK target keeps PETRA with one warning, bold tags stay bold); `localizeBible` (only character bullets, order, places untouched); `characterLabels` on soother; engine run with localizeNames on (glossary prompt has the instruction, translator prompt has the localized note, identity entries for the rest, export has `PETRICA (grumpy):`, line shapes match, bible renamed in order, cover brief identical); edit before export (`Nib→Nibko`); default off unchanged plus `PETRA (grumpy):`. `tests/dispatcher.test.ts` saves the setting; `tests/mcp.test.ts` schema has the key.

**Acceptance:** off = byte-identical; on = speaker tags, ON SCREEN names and bible bullets follow the glossary consistently, every line keeps its class so `vno_add_edition` / `vno_align_report` still pair beats; names reviewable before export.

---

## B6. Real-model live runs (verification only, after merge)

1. BTT-08: a real-model run of the soother book into Croatian, then `vno_add_edition` + `vno_align_report` (0 missing, 0 extra).
2. BTT-09: after `hub.ps1 build book-translator` and a restart, a small `clientOnly: true` text answered through `get_client_task`/`submit_client_task`; no `messages` key (X1). Needs `BOOK_TRANSLATOR_MCP_TOKEN`.
3. BTT-11: edit providers.md while running and see it in `list_models` (B1); first start writes `seed-state.json` and adds nothing (B3); one VN run with `localizeNames: true` then `vno_add_edition` (B4).

---

## Phases (in order)

Each phase ends with `yarn test`, `yarn typecheck` and `yarn lint` green.

### Phase 0: setup
- [x] Branch `BTT-11_roadmap-fixes` from master 46747f8. This plan (`changelog.md` is written by the orchestrator).
- [x] Baseline: `yarn test` 23 files / 247 tests passed; `yarn typecheck` and `yarn lint` clean.

### Phase 1: X1
- [x] `models/client.ts`, `protocol.ts` comments, `get_client_task` description; tests. Tests 252 (+5: four `clientTaskResult` cases and the chatJson repair round end to end). Typecheck and lint clean.

### Phase 2: B2
- [x] Schema, `CLIENT_DEFAULT_CONTEXT`, `registry.load` fallback; seed; tests. Tests 253. Typecheck and lint clean. Deviation: no change in `cli.ts` `listModels`, because the model's `context` now holds the effective value, so `(default)` is no longer shown for the client model. README step 1 reworded together with B3.

### Phase 3: B1
- [x] Registry signature/stamp (`configSignature`, `configChanged`, `markConfigSeen`, loaded contexts kept); `dispatcher.reloadConfigIfChanged` + on-demand calls (`listModels`, `analyze`, `createProject`, `start`, `resume`, `retryChunk`); 3 s timer in `bootEngine`; tests. Tests 260 (+7). Typecheck and lint clean. Docs for this phase are in Phase 7.

### Phase 4: B3
- [x] `store/migrate.ts`, `initDataFolder` hook (`migrated`, `warnings`), logs in `serve.ts` (stderr and dispatcher log) and `cli.ts`; tests. Tests 267 (+7). Typecheck and lint clean. Deviation: new entries are copied as text (with the comments above them) into the original frontmatter, not through a yaml `Document` re-serialization, because `doc.toString` re-aligned the user's comments and flow lists, which broke "text kept". The result is validated with `providersSchema` before it is written.

### Phase 5: B5
- [x] `src/main/folders.ts`, IPC (`host:pickBookFolder`), preload, protocol, NewProject button, `tests/folders.test.ts`. Tests 272 (+5). Typecheck and lint clean. Deviation: `FORMATS` is unchanged (it is also used in the "No ... files" and "Not a ... file" toasts); only the drop-zone hint says "a visual-novel book folder". Also added `pickBookFolder` to the API mock in `tests/store.test.ts`.

### Phase 6: B4
- [x] Setting, `pipeline/names.ts`, glossary option, hooks, format note, export, MCP/CLI/UI, warning; tests. Tests 283 (+11). Typecheck and lint clean. Notes: `KEEP_NAME_NOTE` lives in `names.ts` (service imports it); the "localizeNames changed" warning is in the dispatcher's `updateProjectSettings` (that is where settings are saved); `WriteOptions.names` is keyed by the lower-cased source name.

### Phase 7: docs and wrap-up
- [x] README (reload, client section, data folder, formats, VN character names, CLI, MCP `messages`), seed providers.md body, `INSTRUCTIONS` and prompt in `mcp/server.ts`.
- [ ] `changelog.md` (the orchestrator writes it).
- [x] Final `yarn test` 24 files / 283 tests passed, `yarn typecheck` clean, `yarn lint` clean.

## Verification commands

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
cd C:\projects\Personal\book-translator
yarn test
yarn typecheck
yarn lint
```

Do not run `yarn build`, `yarn dev` or `yarn dist`. Do not point any command at `~/BookTranslator`.

## Overall acceptance criteria

1. `get_client_task` returns `messages` only for multi-turn requests.
2. Edits to `config/providers.md` (and `models.md` / `defaults.json`) apply in a running engine within 3 s, or at once on the listed commands. Client tasks survive. A broken file keeps the previous config and logs once.
3. `client/claude-code` plans with 200000 tokens in a fresh seed, with model-level, provider-level or no `context`.
4. An existing data folder gets newly seeded providers once at start, without changing existing entries, comments or order, and without restoring deleted ones.
5. The New translation screen opens a Scriptorium book folder as one `vn` project.
6. `localizeNames` (default off) gives consistent localized names; off is byte-identical.
7. Tests, typecheck and lint green; docs describe the new behaviour; no mention of adding `client` by hand or restarting after a providers edit is left.

## Decisions (defaults; the user can override)

- B1: 3 s polling + on-demand checks, no watcher; `defaults.json` included.
- B2: model `context`, then provider `context`, then 200000 for `kind: client`, then 8192.
- B3: `seed-state.json`; legacy folders treat every pre-`client` seed provider as offered; added `client` is enabled; an existing disabled `client` stays disabled.
- B4: opt-in per project; glossary `person` entries are the map; bible bullets renamed, bible prose and cover brief stay English; non-bible speakers localized too; untaggable names keep the source tag with a warning; changing the setting later is allowed with a warning.
- B5: separate "Open a book folder" button; "Open a folder" / drop recognise book folders too.
