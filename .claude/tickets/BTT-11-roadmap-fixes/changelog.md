# BTT-11 changelog

## 2026-10-21 — BTT-11: hub roadmap fixes (client tasks, providers reload, client context, seed migration, localized VN names, book-folder picker)

Branch `BTT-11_roadmap-fixes` from master 46747f8. Plan: `plan.md` in this folder.

### What changed

- **X1, the prompt was sent twice.** `src/engine/models/client.ts` `clientTaskResult` adds `messages` only for a multi-turn request: an assistant turn (the JSON repair round) or more than one user message. `src/shared/protocol.ts` doc comments and the `get_client_task` description in `src/engine/mcp/server.ts` say so.
- **B2, the client context.**
  - `src/shared/schemas.ts`: a provider can have `context`.
  - `src/engine/models/registry.ts`: a model's context is its own `context`, else its provider's, else 200000 (`CLIENT_DEFAULT_CONTEXT`) for a `client` provider, else 8192.
  - `seed/config/providers.md`: `context: 200000` moved onto the `claude-code` model. The BTT-10 seed had it on the provider, where it was ignored. The text no longer says the client provider is off.
- **B1, providers reload.**
  - `registry.ts`: `configSignature` (mtime and size of providers.md, models.md and defaults.json), `configChanged` and `markConfigSeen`. LM Studio's loaded contexts survive a reload.
  - `src/engine/dispatcher.ts` `reloadConfigIfChanged`:
    - Runs every 3 s (`CONFIG_CHECK_MS`, timer in `src/engine/serve.ts`), and before `listModels`, `analyze`, `createProject`, `start`, `resume` and `retryChunk`.
    - Two callers share one reload.
    - It wakes the limiters and sends a `models` event.
    - A broken file keeps the previous providers and is logged once.
- **B3, seed migration.**
  - New `src/engine/store/migrate.ts` `migrateProviders`, called from `initDataFolder` (`src/engine/store/dataFolder.ts`).
  - It adds the seed providers missing from an existing `config/providers.md`, once each. The entries are copied as text with their comments, before `mock`. The user's text, comments, order and line endings stay.
  - `config/seed-state.json` records what was offered, so a deleted provider is not added back. A legacy folder counts the pre-`client` seed providers as offered, so only `client` is added.
  - `serve.ts` and `cli.ts` log what was added, and any warnings.
- **B5, opening a book folder.**
  - New `src/main/folders.ts` (`isBookFolder`, `listDocuments`): a book folder is one item. A folder of books lists each book folder.
  - New `host:pickBookFolder` (`src/main/index.ts`, `src/preload/index.ts`, `protocol.ts`).
  - `src/renderer/ui/NewProject.tsx`: an "Open a book folder" button (`choose-book-folder`) and a VN note. "Open a folder" and drag-and-drop of a book folder now make one VN project, not a batch of `book.md` + `outline.md`.
- **B4, localized character names (opt-in, default off).**
  - Setting: `ProjectSettings.localizeNames` (`src/shared/project.ts`).
  - New `src/engine/pipeline/names.ts`: `characterLabels`, `ensureNameEntries`, `nameMap`, `KEEP_NAME_NOTE`.
  - Glossary (`src/engine/pipeline/glossary.ts`, `runner.ts`, `service.ts`): the glossary builder is asked for localized names, and every character gets a `person` entry.
  - Translator note: `formats/index.ts` gets the option, with `VN_BRIEF_NOTE_LOCALIZED`.
  - Export: `src/engine/formats/vn.ts` `localizeScriptNames` and `localizeBible` rewrite speaker tags, `ON SCREEN:` names and the bible's character bullets from the glossary. A name that cannot be a speaker tag keeps its source form, with one warning.
  - Where it can be set:
    - MCP `create_project` / `update_project_settings`
    - CLI `--localize-names`
    - UI checkboxes `localize-names` and `settings-localize-names`
  - The dispatcher warns when the setting changes after chunks are done.
  - With the setting off, the export is byte-identical.
- **Docs:** `README.md` and the `seed/config/providers.md` body. They no longer mention a restart or adding `client` by hand.
- **Tests:** `tests/client.test.ts`, `registry.test.ts`, `dispatcher.test.ts`, `dataFolder.test.ts`, `vn.test.ts`, `mcp.test.ts`, `store.test.ts` (API mock), and the new `tests/folders.test.ts`.

### Deviations from the plan

- B3: the entries are inserted as text rather than through a re-serialized yaml `Document`. Re-serializing re-aligned the user's comments and flow lists. The result is still checked against `providersSchema` before it is written.
- B2: `cli.ts` `listModels` was not changed. The model's `context` now holds the effective value, so `(default)` no longer shows for the client.
- B5: `FORMATS` was left as it was, because the error toasts use it too. Only the drop-zone hint mentions book folders.
- B4: `KEEP_NAME_NOTE` lives in `names.ts`.

### Verification

- `yarn test`: 24 files, 283 tests pass (baseline 23 files, 247 tests). The orchestrator re-ran it.
- `yarn typecheck`, `yarn lint`, `git diff --check`: clean.
- Not run:
  - the Electron UI (picker IPC, checkboxes): typecheck only
  - `yarn build` / `yarn dist`
  - the live checks (plan B6): a real-model Croatian VN run with `vno_add_edition`, a `clientOnly` run over MCP after a rebuild and restart, a providers.md edit while running, and the first start writing `seed-state.json`

### Follow-ups

- Do the B6 live checks after the merge (needs `hub.ps1 build book-translator` and a restart).
- A running project keeps its chunk plan after a reload. A request already waiting for a slot holds the old provider until it wakes.

Committed on `BTT-11_roadmap-fixes`, not pushed or merged.
