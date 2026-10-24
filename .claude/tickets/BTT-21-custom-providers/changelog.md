# BTT-21 changelog

## 2026-10-24: custom OpenAI-compatible providers, open groups, seeded ACP proxy, named MCP clients

Branch `BTT-21_custom-providers` (from origin/master). **Uncommitted.** 18 files changed, plus the new file `src/renderer/ui/CustomProviderForm.tsx`.

### What changed
- **Provider fields.** `src/shared/schemas.ts` adds the provider fields `name` and `custom`. `groupDefaults` is now an open record and `modelOrder` an open list, so old `defaults.json` files still parse.
- **Registry.** In `src/engine/models/registry.ts`, `ProviderInfo` gets `name` and `custom`. There is a new `testEndpoint`.
  - `groupOf` returns `paid` for non-local seed providers and the provider id for the others. It returns nothing for the client and mock providers.
- **New commands.** `src/engine/dispatcher.ts` has `saveCustomProvider`, `removeCustomProvider` and `testCustomProvider`:
  - The key is stored as `CUSTOM_<ID>_API_KEY`.
  - `providers.md` is edited only for `custom: true` entries, with a `parseDocument` round trip.
  - Removing a provider deletes its key and cleans `models.md` and the refs in `defaults.json`.
  - The models info carries `name`, `custom`, `jsonSchema` and `keyNames`.
- **UI.**
  - The new `CustomProviderForm.tsx` is the add/edit form.
  - `ModelsDialog.tsx` has "+ Add provider", plus Edit and Remove (with a confirm) for custom providers.
  - `Settings.tsx` builds its group rows from the groups in use, labelled with the provider name, and the providers table shows names.
  - `ModelSelect.tsx` and `ModelListEditor.tsx` no longer hardcode the three groups.
- **Named clients.**
  - In `src/engine/models/client.ts`, tasks record `client`, and the lease filters on it (no client named means `claude-code`).
  - In `src/engine/mcp/server.ts`, `get_client_task` and `release_client_task` take `client`.
- **Seed and migration.**
  - `seed/config/providers.md`: the disabled `custom` placeholder is replaced by `acp` (off, local, port 7461, no JSON schema). The client provider gets `antigravity` (1M context, vision). The field docs are extended.
  - `src/engine/store/migrate.ts`: `migrateProviders` adds `acp` once, and the new `migrateClientModels` adds antigravity once. Both are tracked in `seed-state.json`.
- **Docs.** `README.md` has new sections on adding your own provider, named clients, and Antigravity CLI as a client. `ROADMAP.md` has a BTT-21 entry.

### Deviations
- The client and mock providers have no group.
- `testCustomProvider` takes an optional `id`, so testing during an edit can use the stored key.
- `release_client_task` with no client named frees the tasks of every client.
- BT has no hardcoded key list and no demo backend, Playwright or `seed:hashes`, so none of those were touched.
- Saving `providers.md` may normalise spacing in the same way the existing `saveProviders` does.

### Verification
- `yarn test`: 333 tests in 24 files pass (313 before). New tests are in `registry`, `dispatcher`, `client` and `dataFolder`.
- `yarn typecheck` and `yarn lint` are clean.
- **Not run:**
  - The renderer in a running app (the form and group rows were only typechecked).
  - The live check with LM Studio, the ACP proxy and an Antigravity MCP call.

### Notes
- The branch is cut from master, without the unmerged `BTT-15-20_fixes`. Expect small merge conflicts in the model and client files.
- The scratch scripts in `.claude/temp/` can be deleted.
