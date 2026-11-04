# BTT-24 changelog

## 2026-11-04 BTT-24: Book Translator follows whichever model Strata runs (hub HUB-26, T4)

Branch `BTT-24_strata-model-discovery`, from `master` (3b98d39). Committed on that branch; not pushed, not merged. Replay of VN Studio's VNO-60 (commit 9d0d173), adapted.

Behaviour: `strata/default` and `strata/default-low` are `loaded` rows. The engine asks Strata which model it serves (`/v1/status` `model` on the 10-second check, `/v1/models` at discovery), applies the matching `profiles` entry to those rows in place, shows `Strata: <model>` in the model pickers and follows a model switch within one status check. The old ids (`strata/qwen3.8-flash-next`, `-low`) resolve through `aliases`, so the projects that name them keep working.

### C1 rule -> file:line map (line numbers on this branch)

| C1 | what | where |
|---|---|---|
| C1.1 | model row `loaded`, `aliases`, `json_schema`; profile schema; provider `profiles` | `src/shared/schemas.ts:33-42` (row fields), `:45` (`providerProfileSchema`), `:94` (`profiles`) |
| C1.1 | seed block (rows, `discover: true`, profiles) | `seed/config/providers.md:98-123` (strata block), field-docs bullets after `load_context` (:222-223), `## Strata` section (:229) |
| C1.2 r1 | L from `/status` `model` | `src/engine/models/registry.ts:518-521` (`syncServerSlots`) |
| C1.2 r1 | L from `/models` (first entry without `alias_of`), `meta.n_ctx` | `registry.ts:553-557` (`noteServed`), `:448-453` (`discover`), `src/engine/models/openaiCompat.ts` `OpenAiModelEntry`/`ListedModel`/`listedModel` (`aliasOf`, `nCtx`) |
| C1.2 r1 | L kept across reloads, memory only; no answer or empty list leaves it | `registry.ts:190-191` (`servedIds`, `servedCtx`), `:276` (read back in `load`), `:555` (no non-alias entry: no change) |
| C1.2 r2 | profile K: same id, else longest prefix | `registry.ts:91-98` (`profileFor`) |
| C1.2 r3 | family, context, max_output, json_schema, extra_body of each `loaded` row; unknown L keeps the row's own | `registry.ts:571-583` (`applyServed`), `:303-308` (rows built in `load`) |
| C1.2 r4 | `-low` is only another `loaded` row | seed rows in `providers.md`; no code |
| C1.2 r5 | `strata` alias finds the first `strata/...` row of `fallbacks` | unchanged `aliasMap`; seed `defaults.json` `fallbacks`, `groupDefaults` |
| C1.2 r6 | legacy refs through `aliases` (not listed as models) | `registry.ts:307,311-312` (`aliasRefs`), `:594-595` (`getModel`), `:600` (`contextLength` uses `getModel`), `:663-664` (`resolve`) |
| C1.2 r7 | discovery adds no models; `picked` of such a provider skipped; catalog lists none | `registry.ts:448-453`, `:320` (picked skipped), `:384-388` (`catalog`) |
| C1.2 r8 | switch re-applies in place; `served` changes returned; log and event | `registry.ts:560-568` (`setServed`), `:549` (result `{ slots, served }`), `src/engine/dispatcher.ts:268` (log `strata now serves <L> (was <old>)`), `:276` (`models` event) |
| C1.2 r9 | Strata down keeps L | `registry.ts:560-568` (L never cleared); `ProviderSummary.served` stays set while `down` |
| C1.2 r10 | `served` on model and provider summaries, discovery result | `src/shared/protocol.ts:58-61,91-93,123`, `src/engine/dispatcher.ts:186-187,209-210`; label `src/renderer/ui/ModelSelect.tsx:4-15`; Settings discovery line and text `src/renderer/ui/Settings.tsx:389,392`; `engine models` CLI `src/engine/cli.ts:33` |
| C1.2 r11 | per-model `json_schema` | `src/engine/models/router.ts:186` (the one chat call, next to `extraBody`), `openaiCompat.ts:74`, `src/engine/models/types.ts:30` |
| C1.3 | neutral refs in defaults and seed | `src/shared/schemas.ts:138`, `src/engine/dispatcher.ts:594`, `registry.ts` `modelDefaultsOf`/`setDefaults` fallbacks, `seed/config/defaults.json:3-11` |
| C1.4 | migration | `src/engine/store/migrate.ts:212-320` (constants, `migrateStrataLoaded`), `:75-102` (`migrations` kept in seed-state.json), `src/engine/store/dataFolder.ts:86-88` |

### Files changed

`src/shared/schemas.ts`, `src/shared/protocol.ts`, `src/engine/models/{registry,router,openaiCompat,types}.ts`, `src/engine/{dispatcher,cli}.ts`, `src/engine/store/{migrate,dataFolder}.ts`, `src/renderer/ui/{ModelSelect,Settings}.tsx`, `seed/config/{providers.md,defaults.json}`, `tests/{registry,dataFolder,router,dispatcher}.test.ts`, `ROADMAP.md`, this folder.

### Differences from VNO-60

- Migration: one function, `migrateStrataLoaded`, instead of three `SEED_MIGRATIONS` entries (BT has no migration list). It runs once by recording `strata-loaded-v1` in a new `migrations` list of `config/seed-state.json` (`writeState` keeps that list). A folder without a seed state (the seed could not be read) is not recorded, so the provider migration still sees it as an old folder. It returns `strata-loaded-v1` in `InitResult.migrated` only when it changed a file.
- BT only: a numeric `concurrency` on `strata` becomes `auto` (also when the provider has `loaded` rows already).
- The ref rename is in `config/defaults.json` (there is no roles.md or settings.md), done as exact quoted-string text replacement so the file keeps its layout; it covers `agentModels`, `fallbacks` and `groupDefaults`. A `defaults.json` that does not parse is left alone and the migration is not recorded.
- providers.md is edited through the yaml document of its frontmatter (comments kept, line endings kept, the result checked against the schema before it is written); the body is kept byte for byte.
- No Models page in BT: the label is in the model picker (`ModelSelect.tsx`, `servedLabel`), the provider summary carries `followsServer` and `served`, and the Settings discovery line says `runs <L>`. The UI text `Strata: not running (last: <L>)` has no place in BT's UI (the provider row shows `down`; `served` is in the summary for it).
- No spend event and no per-call usage row in BT: chunk records keep the ref (`strata/default`).
- `contextLength(ref)` also resolves a legacy ref (it used `models.get`), so a project planned on `strata/qwen3.8-flash-next` keeps its context window.
- Existing tests adjusted for the new default refs and the `{ slots, served }` shape: `tests/registry.test.ts`, `tests/router.test.ts`, `tests/dispatcher.test.ts`.

### Verification

- `yarn typecheck`: no errors. `yarn lint`: no output. `yarn test` (vitest): 25 files, 364 tests, all passed.
- AC-1: the extended test "marks a server that does not answer as down ... its loaded rows follow the model it runs" (`tests/registry.test.ts:357`): DeepSeek served gives family deepseek and `reasoning_effort` none / low; legacy `strata/qwen3.8-flash-next-low` is the `-low` row; discovery adds no `strata/<id>` model; a switch to `qwen3.8-flash-next-iq3_s` changes the same objects to family qwen; down keeps L, also across a reload.
- AC-3: new case in `tests/dataFolder.test.ts:167` (old rows replaced, own row kept, profiles added, `concurrency: 1` -> `auto`, defaults.json refs renamed with its layout kept, runs once, a deleted strata provider untouched).
- AC-2: the existing seed-config test (`tests/registry.test.ts:14`) green, on the new refs.
- AC-5 (this repo): grep for `run-iq2_xs`, `coder-iq1_m`, `84 GB`, `Qwen3.8-Flash-Next server`, `server for Qwen3.8` over `seed/config`: no hit.

### Not run

- Nothing against a running Strata (hub live checks L2, L4); no app started; no user data touched (`~\BookTranslator` is migrated when Book Translator next starts).
- The picker label and Settings text were typechecked, not looked at in the running app.

## Polish (checker findings)

- `resolve()` now also maps an alias whose fallback row still names an old ref of a `loaded` row (`strata/qwen3.8-flash-next`) to the row (`strata/default`), as Scriptorium does, so the shared-order list holds `strata/default` once. One assertion added to the existing AC-1 Strata test; it failed before the fix and passes after.

- MCP `list_models` (`trimModels`) now carries `served` (the model id a `loaded` row runs) when set, per plan C1 rule 10. The existing key-shape test still holds (mock has no `served`); no new test.
