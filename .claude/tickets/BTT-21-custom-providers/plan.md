# Custom OpenAI-compatible providers, ACP proxy, named MCP clients

Tickets: **SCP-44** (Scriptorium), **BTT-21** (Book Translator), **VNO-39** (VN Studio). Before any code, save this plan as `.claude/tickets/<ticket>-custom-providers/plan.md` in each repo, and add a row to each `ROADMAP.md`. Build it in Scriptorium first, then port it to the other two. BTT-05 and VNO-01 were ported the same way, and the model layer files are near copies.

Scriptorium branch: `SCP-44_custom-providers` (from `origin/master` d7c4499). Scriptorium's plan lives in this folder (`SCP-44-custom-openai-compatible-providers-acp-proxy`).

## Checklist (Scriptorium, SCP-44)

- [ ] Engine: `custom`/`name` fields, own kind for custom providers, `saveCustomProvider` / `removeCustomProvider` / `testCustomProvider`, key names reported to the UI
- [ ] UI: Add provider form, Edit/Remove, provider names, Settings key select from the engine, demo fake backend
- [ ] Seed `acp` provider + migration, `yarn seed:hashes`
- [ ] Named MCP clients (`client` on tasks, lease filter, MCP tool arg, seed `antigravity`)
- [ ] Docs: design.md decisions/model layer/history, providers.md body, docs/mcp.md, ROADMAP row
- [ ] Tests, typecheck, lint, Playwright Models spec

## Checklist (Book Translator, BTT-21)

- [x] Engine: `custom`/`name` fields, `saveCustomProvider` / `removeCustomProvider` / `testCustomProvider` (dispatcher.ts), key `CUSTOM_<ID>_API_KEY`, `keyNames` in the models info, remove cleans models.md and defaults.json
- [x] Groups widened: `groupDefaults` / `modelOrder` open strings (schemas, protocol), `groupOf` = `paid` for non-local non-custom, else provider id (client/mock: none), Settings group rows built from groups with a ticked model, labelled with the provider name
- [x] UI: Models dialog "+ Add provider", Edit/Remove, form with Test (`CustomProviderForm.tsx`), provider names in the dialog, settings table, ModelSelect, alias options
- [x] Seed `acp` provider (placeholder `custom` removed), body docs, migration adds it once
- [x] Named MCP clients: `client` on tasks, lease filter (missing = `claude-code`), MCP `client` arg on `get_client_task` / `release_client_task`, seed `client/antigravity`, one-time text migration for existing folders (`models` in `seed-state.json`)
- [x] Docs: README (Add your own provider, named clients, Antigravity CLI as a client), providers.md body, ROADMAP row
- [x] Tests added (registry, dispatcher, client/MCP, dataFolder); `yarn test` 333 passed (313 before, 24 files), `yarn typecheck` and `yarn lint` clean
- [ ] Live check not done (no app launched against the user's data folder): Add provider against LM Studio, run a job on it, MCP `client: "antigravity"` over HTTP

Deviations:
- `get_client_task` / `release_client_task` get the `client` arg; `list_client_tasks` takes none and lists every client's tasks (each shows `client`). `release_client_task` without `client` frees every client's leased tasks (only the lease is filtered by default).
- `testCustomProvider` also takes an optional `id` so an edit with an empty key field tests with the stored key.
- Saving a custom provider re-serializes providers.md with the yaml writer, as `saveProviders` already does: comments stay, but the spacing before trailing comments and `[a]` flow lists may be normalised.
- The antigravity model migration is separate from `migrateProviders`' provider list (it is a model, not a provider): it inserts text into the `client` entry once and records `models: ['client/antigravity']` in `config/seed-state.json`. It is reported in `migrated` as `client/antigravity`.
- `groupOf` returns undefined for `client` and `mock` providers (keeps the old behaviour; the plan's "else provider id" would have added a `client` group row).
- Not changed: BT has no hardcoded `KEY_NAMES` list (each provider row uses its `apiKeyEnv`), so only `keyNames` was added to the models info for clients.
- No `COMMAND_TYPE_SET` in BT, so nothing to register there; no demo/fake backend or Playwright spec exists in this repo.

## Context

All three apps can only use the providers their seed `providers.md` ships with. The user wants to add any OpenAI-compatible server at runtime, as many as they like: their own `api-acp-proxy` (Antigravity, Codex and Claude through ACP), and any later one. Each one should then appear in the model pickers and as its own kind/group in the fallback order.

They also want a seeded ACP proxy entry, and the `client` provider extended to named MCP clients, so that Antigravity CLI can take jobs the way Claude Code does.

The decisions the user made:
- Providers are added in a form in the Models dialog/page and saved to `config/providers.md`. Keys go to the credential store.
- The ACP proxy is seeded and off by default.
- `client` gets named clients (`claude-code`, `antigravity`, plus any added).

What the exploration found:
- An `openai-compat` entry in `providers.md` already works end to end: chat, Detect models, discovery, limits and budget, all through the shared `OpenAiCompatClient`. So no new HTTP client is needed.
- What is missing:
  1. A way to create, edit and remove entries from the UI.
  2. A free key name for each entry (today the key UI uses a hardcoded `KEY_NAMES` list).
  3. Each custom provider being its own kind/group. Today Scriptorium puts a non-local provider under `paid`, and BT and VN have a fixed `paid|strata|lmstudio` enum.
  4. Client tasks carry no client name, so any MCP client takes any task.

## Design (the same in all three apps)

### 1. The custom provider entry in `config/providers.md`

```yaml
- id: acp-home            # slug of the name, unique, not a seed id
  name: ACP proxy (home)  # label in the UI
  custom: true            # added in the UI: the form can edit/remove it
  kind: openai-compat
  enabled: true
  base_url: http://127.0.0.1:7461/v1
  api_key_env: CUSTOM_ACP_HOME_API_KEY   # only when a key was given
  local: true             # "free" in the form: no key needed, no budget, own kind
  json_schema: false
  concurrency: 2          # or auto
  discover: true
  models: []
```

- **Free and paid.** A "free" provider is `local: true`. That reuses the existing rules for local providers: no key required, never counted as paid, and its own kind. A paid provider is `local: false`; its models need prices (the `addModel` rule that exists today). In every app, a custom provider is **always its own kind/group, named by its id**, whether it is free or paid.
- **Writing the file.** Use the `yaml` `parseDocument` round trip, which keeps comments and hand edits. Book Translator already does this in `saveProviders` (`book-translator/src/engine/dispatcher.ts:415-436`). Only entries with `custom: true` are added, replaced or removed. The file watcher already reloads the registry and re-runs discovery when `providers.md` changes.
- **Keys.** The key name is `CUSTOM_<ID>_API_KEY`. Since it is the entry's `api_key_env`, the existing `allowedSecrets()` / `setSecret` allowlist accepts it with no change. The form saves the entry first, then the key, in one engine command. Removing a provider deletes its stored key (`deleteStoredKey` in `keys.ts`).

### 2. New engine commands
Add each to the `Command` union, `COMMAND_TYPE_SET` (main drops unlisted commands), the engine handler, and Scriptorium's `src/renderer/demo/fake.ts`.
- `saveCustomProvider { id?, name, baseUrl, apiKey?, free, jsonSchema, concurrency, enabled }`. It creates the entry, or edits it when `id` is given.
  - It validates the URL (http or https) and checks the name gives a unique slug.
  - An empty `apiKey` on an edit keeps the stored key.
- `removeCustomProvider { id }`. It removes the entry and its key, and drops its refs from `models.md` (`picked`, `hidden`, `limits`) and its fallback rows / group defaults.
  - roles.md entries that name it are left as they are. The existing "unresolved alias" or unknown-model handling already shows them.
- `testCustomProvider { baseUrl, apiKey? }` calls `GET /models` and returns a count or an error, so the form can say "reachable, 12 models" before it saves. It reuses `OpenAiCompatClient.listModelInfo`.

### 3. UI: the Models dialog / page
- An **"Add provider"** button under the provider list on the left.
- A custom provider row gets **Edit** and **Remove**.
- The form has these fields: Name, Base URL, API key (optional, password field, never shown again), Free (local) checkbox, Send JSON schema checkbox (default off), Parallel (number or auto), Enabled, and a **Test** button.
- The left list shows `name` (falling back to the id). Scriptorium's `PROVIDER_LABELS` (`src/renderer/store/model.ts:105`) falls back to the summary's `name`.
- Settings' **Provider API key** select drops the hardcoded `KEY_NAMES`. It lists every `api_key_env` the engine reports, which needs a new `keyNames` field in the settings/models info.
- Detect models, Tick and Add-by-id work unchanged (`canList` is `kind === 'openai-compat'`).

### 4. Own kind/group per custom provider
- **Scriptorium.**
  - `kindOfRef` (`src/engine/models/registry.ts:470`) changes to `p?.local || p?.custom ? p.id : 'paid'`.
  - Make the same change in the renderer copy `rowKind` (`src/renderer/ui/ModelsDialog.tsx:44`) and `summary.ts:159`.
  - `kindsFor` (`ModelsDialog.tsx:174`) then offers the custom kinds, and `kindLabel` shows the provider's name.
  - roles.md can say `acp-home` / `acp-home-2`, the same way it says `strata`.
- **BT and VN.**
  - Replace the fixed group enum `paid|strata|lmstudio` with open string groups.
    - BT: `schemas.ts:105-111`, `protocol.ts:234-236`, `ModelSelect.tsx:18`, `ModelListEditor.tsx:5`, `Settings.tsx:14-21`, `registry.ts groupOf:502`.
    - VN: `schemas.ts:137`, `protocol.ts:135`, `engine.ts:685`, `ModelsPage.tsx:41-46`, `registry.ts groupOf:487`.
  - `groupOf(provider)` becomes `paid` for a non-local seed provider, otherwise the provider id. So strata and lmstudio keep their names, and each custom provider gets its own.
  - The group rows ("API / Strata / LM Studio") are built from the groups that have a ticked model, in `model_order`, instead of three fixed rows. The label is the provider name.
  - Settings migration. VN: `default_paid_model`, `default_strata_model` and `default_lmstudio_model` become `group_defaults: {paid, strata, lmstudio}`. BT's `defaults.json` `groupDefaults` is already keyed by group; only widen its schema. Keep the old VN fields readable for one release, read them on load, and write only the new shape.

### 5. Seeded ACP proxy entry (all three apps)
Add an `acp` entry to the seed `providers.md`:
- `kind: openai-compat`, `enabled: false`, `local: true`, `base_url: http://127.0.0.1:7461/v1` (the hub port, per the creative-hub HUB-09 plan), `json_schema: false`, `concurrency: 2`, `discover: true`, `models: []`.
- It has no `custom` flag, so the form can't remove it, but its base URL and enabled state are edited like any seed provider's.
- Body text:
  - The proxy needs `PROXY_IGNORE_SAMPLING=1`, because the apps send `temperature`, `max_tokens` and `stream_options`.
  - It is text only: no vision, so it can't serve VN's art-critic.
  - `PROXY_TIMEOUT_MS` (default 5 min) must cover long requests.
  - The Antigravity terms risk, pointing to the hub ROADMAP section.
- Existing data folders get the entry through each app's seed migration. Scriptorium: a new text-insert migration beside `migrateClientProvider` (`src/engine/store/migrations.ts:313`). BT: `migrateProviders`, add it to the newer-seed list (`src/engine/store/migrate.ts:94`). VN: `seedMigrations.ts`.

### 6. Named MCP clients
- **Seed `client` models:** `claude-code` (the existing one) and `antigravity` (context 1000000, `vision: true` in VN). More can be added with "Add a model by its id" on the client provider; check that `addModel` accepts the client provider without prices.
- **Tasks.** `ClientTask` (Scriptorium `src/engine/models/client.ts:18`, and the same file in BT and VN) gets `client: string`, which is the model id. `ClientProvider.chat` sets it from `req.model`.
- **Filter.** `ClientTaskFilter` gets `client?: string`, and `lease()` matches on it.
  - When the field is missing it means `claude-code`, so Claude Code's existing prompts and skills keep working and never take Antigravity's jobs.
  - The task summaries/lists show `client`.
- **MCP tools.** Add an optional `client` argument to these tools:
  - Scriptorium: `get_client_task` / `list_client_tasks`.
  - BT: the same, in `src/engine/mcp/server.ts:243-274`.
  - VN: `vno_get_task` (`src/engine/mcp/tools-client.ts:54`).
  - The tool descriptions say "Antigravity: pass client: \"antigravity\"".
- **Docs.** `docs/mcp.md` (Scriptorium), the BT README MCP section, and VN `docs/mcp-guide.md` each get a short "Antigravity CLI as a client" part: how to add the app's MCP URL and bearer token to Antigravity CLI's MCP config, and the loop prompt it runs. Claude does not log into Antigravity; the user sets that up.

### 7. Docs and decisions
- Scriptorium `docs/design.md`:
  - New Decisions rows "Custom providers" and "Named MCP clients".
  - Update the "Models dialog" row and the UI decision row: Add provider, Edit and Remove are new on-screen controls the user asked for.
  - Update the "Model layer" section and the History.
- BT and VN: README provider sections and the `providers.md` body field docs (`custom`, `name`). VN also records the decision in its design notes.

## Order of work
1. **Scriptorium (SCP-44).** Engine and schema first, then commands, the dialog form, kinds, the ACP seed plus migration, named clients, docs, and `yarn seed:hashes` after the seed edits.
2. **BT (BTT-21).** Port, plus the group enum widening and the `defaults.json` schema.
3. **VN (VNO-39).** Port, plus the group enum and settings migration and the vision flag on `client/antigravity`.

Use the `implement` skill per repo, each on its own ticket branch.

## Verification (per repo)
- **Unit tests:**
  - The registry loads a `custom: true` entry, and it has its own kind/group (free and paid).
  - `saveCustomProvider` then `removeCustomProvider` round-trip `providers.md` with comments kept, store and delete the key, and clean up `models.md`.
  - The `setSecret` allowlist accepts `CUSTOM_<ID>_API_KEY`.
  - Alias `acp-home` resolves (Scriptorium). Groups widen and the old settings migrate (BT, VN).
  - Client lease: a task for `antigravity` is not leased without `client`; a `claude-code` task is leased without it.
  - The seed migration adds `acp` once.
  - Extend the existing fake-server OpenAI-compat tests for `testCustomProvider`.
- **Full run:** `yarn test`, typecheck and lint in each repo. Scriptorium: the Playwright `tests/renderer/office.spec.ts` Models dialog spec gets an add/remove-provider case against `demo/fake.ts`.
- **Live:**
  1. Start the app (or `yarn headless`). Add a custom provider pointing at LM Studio (`http://localhost:1234/v1`, free). Test, save, Detect models, tick one, and put it in the fallback order as its own kind. Run one small job on it.
  2. If the ACP proxy is running on 7461 with `PROXY_IGNORE_SAMPLING=1`, enable `acp` and run one request. This is otherwise left to HUB-09, which is on hold.
  3. Call `get_client_task` with `client: "antigravity"` via MCP and check it only returns Antigravity tasks.
