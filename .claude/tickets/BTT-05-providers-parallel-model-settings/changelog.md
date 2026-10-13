# BTT-05 changelog

## 2026-10-13: DeepSeek V4.1 Flash (follow-up, the user asked for it)

This follows Scriptorium's `f592fe8` and its current seed.
- `seed/config/providers.md`, DeepSeek entry:
  - `deepseek-v4-flash` is renamed to `deepseek-flash` (DeepSeek-V4.1-Flash), priced $0.30 in, $1.20 out, $0.006 cached in.
  - It sends `extra_body: { thinking: { type: disabled } }`.
  - `deepseek-v4-pro` is repriced to $1.32 in, $3.96 out, $0.044 cached in.
  - The provider gets `json_schema: false`, because DeepSeek answers `response_format` json_schema with HTTP 400.
  - The pricing note in the docs is updated.
- `seed/config/defaults.json` and `README.md`: `deepseek/deepseek-v4-flash` becomes `deepseek/deepseek-flash`, in every agent list and in `groupDefaults.paid`.
- Tests:
  - `tests/router.test.ts`, `tests/registry.test.ts` and `tests/dispatcher.test.ts` use the new id.
  - The price expectations follow the new prices: the cost of 1M in plus 1M out goes from 0.42 to 1.5, and `priceIn` from 0.14 to 0.3 and from 1.74 to 1.32.

**Passed:**
- `yarn typecheck`, `yarn lint`
- `yarn test`: 18 files and 198 tests passed.
- `yarn engine models` on a new data folder lists `deepseek/deepseek-flash` at $0.3/$1.2.

**Not run:** a live DeepSeek request.

**Limitation:** an existing data folder and existing projects keep `deepseek/deepseek-v4-flash`. DeepSeek still accepts that name and serves V4.1 Flash with it. But the local price stays the old $0.14/$0.28, so cost estimates come out too low until `providers.md` is edited.

## 2026-10-13: Port Scriptorium's provider updates, parallel translation, and model settings

Outcome:
- Book-translator now has the newer Scriptorium provider handling:
  - **OpenRouter:** free-model discovery with prices, a per-day limit, and handling for its daily-limit 429.
  - **LM Studio:** loads models on demand.
  - **Strata and LM Studio:** `concurrency: auto` and server-down detection.
- Each project has its own parallel settings.
- Each agent has a fallback list, which accepts the API/Strata/LM Studio defaults and follows one shared order.
- There is a Models dialog, and a project's settings can be changed after it is created.

Repo `book-translator`, branch `BTT-05_providers-parallel-models` (from `origin/master` `b14a935`). 29 files changed and 5 added, +2313/−131.

### Engine and shared code
- `src/shared/schemas.ts`:
  - providers can use `concurrency: auto`, `rpd`, `discover: free`, `discover_skip` and `load_models`
  - models can have `load_context` and `load_parallel`
  - new `modelsConfigSchema` for `config/models.md` (picked, hidden, limits)
  - `defaults.json` gains `groupDefaults`, `modelOrder`, `lmstudio` (load settings) and `parallel`
- `src/shared/project.ts`: adds `ProjectSettings.parallel` (`enabled`, `maxAtOnce: 'auto' | n`, `splitSections`) and `DEFAULT_PARALLEL`.
- `src/shared/protocol.ts`:
  - `ProviderSummary` gains: auto, down, rpm/rpd, today's count, day-full, reset time.
  - `ModelSummary` gains: shown, picked, maxOutput.
  - New types `CatalogModel` and `CatalogResult`.
  - New commands: `detectModels`, `showModels`, `addModel`, `setProviderLimits`, `checkServers`, `updateProjectSettings`.
- `src/engine/models/types.ts`: `ProviderError.unreachable` (connection refused and similar).
- `src/engine/models/openaiCompat.ts`:
  - Before an LM Studio chat request, a model that isn't loaded is loaded. It uses `lms load -c --parallel --ttl`, or LM Studio's REST load when `lms` isn't installed.
  - Loads of the same model are de-duplicated. A missing model fails without a retry.
  - `listModelInfo` reads OpenRouter's prices, context, output limit and text-only flag.
- `src/engine/models/limiter.ts`: requests per day, counted from UTC midnight and in memory only, plus day-full marking and `wakeAll`.
- `src/engine/models/registry.ts`:
  - reads the `config/models.md` choices and limits; limits win over `providers.md`, and 0 means no limit
  - discovery handles `free`, `discover_skip` and listed prices
  - new: `catalog`, `syncServerSlots` (Strata `/status`, or LM Studio's loaded `parallel` sum, capped at 16), `markDown`, the group aliases, and `orderRefs`
- `src/engine/models/router.ts`:
  - resolves aliases and the shared order
  - skips down and day-full providers while another model is left
  - an unreachable auto server is marked down with no retries
  - a daily-limit 429 marks the provider day-full and moves on
  - a context error is not retried
  - when every model fails, the error lists why each one failed
- `src/engine/dispatcher.ts`: implements the new commands and `syncSlots()`.
  - `setSecret` and `refreshModels` re-run discovery.
  - `saveProviders` accepts `'auto'`.
  - `updateProjectSettings` is refused while the project runs.
- `src/engine/serve.ts`: slot sync once at start, then every 10 s. `src/engine/cli.ts`: `translate` syncs once before it starts.
- `src/engine/config.ts`: `applyModelDefaults` loads the group defaults, order and LM Studio settings into the registry.
- `src/engine/project/store.ts`: an old `project.json` without `parallel` gets the default, which is today's behavior. `mergeSettings` merges `parallel`.
- `src/engine/pipeline/runner.ts`:
  - `workerCount()`: parallel off gives 1; `auto` gives the translator provider's concurrency; otherwise 1–16.
  - `splitSections` queues chunks one by one. A chunk then gets the previous chunk's end only if that chunk is already finished.
- `src/engine/service.ts`: new-project settings take `parallel` from the defaults. The time estimate divides by the worker count, and the glossary is not divided.
- `seed/config/providers.md`:
  - OpenRouter: `discover: free`, rpm 20, rpd 50, `json_schema: false`
  - LM Studio: `concurrency: auto`, `load_models`, skips `dflash`
  - Strata: `concurrency: auto`
  - documentation updated to match
- `seed/config/defaults.json`: adds the group defaults, order, LM Studio loading and parallel.

### Renderer
- `ui/ModelSelect.tsx`: alias options. Models hidden in the Models dialog are left out unless one is the current value.
- `ui/ModelListEditor.tsx` (new): ordered list of a main model plus fallbacks.
- `ui/ParallelFields.tsx` (new): Parallel on/off, How many (Auto or 1–16), and Also split chapters.
- `ui/ModelsDialog.tsx` (new):
  - per provider: Detect models, filter, free only, ticked only, tick/untick all
  - Add model by id; paid providers must give prices
- `ui/Settings.tsx`:
  - **Providers table:** auto checkbox for local providers, per-minute and per-day limits, status (down, daily limit with reset time, count against rpd), Check now, and a Models… button.
  - **Cards:** Default models (group defaults, order, shared-order checkbox, per-agent lists), Parallel, and LM Studio loading.
- `ui/NewProject.tsx`: sends each agent's whole list. Before, it sent only the first model, so the fallbacks were lost. Also adds the Parallel options.
- `ui/ProjectView.tsx` and `ui/ProjectSettingsTab.tsx` (new): a Settings tab for an existing project, locked while it runs.
- `store/store.ts`: `catalogs` state and a `detectModels` action. `styles.css`: dialog and models styles.

### Tests
- `tests/openaiCompat.test.ts`, `registry.test.ts`, `router.test.ts`, `dispatcher.test.ts` and `pipeline.test.ts` are extended. `tests/limiter.test.ts` is new.
- `tests/pipelineHelpers.ts`: `rig()` is offline by default (no network, no `lms`).
- No existing expectation was changed.

### Deviations
- Plan-mode tooling first wrote this plan over `.claude/tickets/BTT-02-strata-as-a-local-provider/plan.md`. That file was restored from git, and this plan was moved to the BTT-05 folder.
- `detectModels` returns `CatalogResult` and throws when the provider can't be reached. The other new commands return `ModelsInfo`.
- Bad input throws an error instead of being logged.
- Scriptorium's `models.catalog` and `servers` events were not ported. Server changes reuse the `models` event plus a `log` line.
- The slot sync lives in `CommandDispatcher.syncSlots()`, not in `EngineService`.
- The requests-per-day count is in memory only, because book-translator has no spend files to seed it from. After a restart, OpenRouter's own "per day" 429 still marks the provider day-full.
- `setProviderLimits` also updates the old provider object, so requests already waiting for a slot wake up after the change.
- The per-minute and per-day inputs show for API providers only. The three defaults cards share one draft.
- The Models dialog has no limits section, because the limits are in Settings.
- A `ParallelFields` component was added that the plan didn't list.

### Verification
**Passed:**
- `yarn typecheck`: exit 0.
- `yarn lint`: exit 0.
- `yarn test`: 18 files and 198 tests passed. Before: 17 files and 120 tests.
- `yarn build`: built.
- CLI check with a new data folder (`BOOK_TRANSLATOR_DATA=.claude/temp/bt-data yarn engine models`): the seed config parses and the providers list correctly. LM Studio discovery reports "fetch failed" because the server isn't running.

**Not run:**
- Live Strata and LM Studio checks (neither server was running), and the OpenRouter check (no key in the test folder).
- Any visual check of the UI in Electron: the providers table layout, the Models dialog and the project Settings tab.

### Follow-ups and limitations
- An existing data folder keeps its old `providers.md`, because the seed never overwrites. To get the new behavior there:
  - switch Strata and LM Studio to auto in Settings, and add `load_models: true` to LM Studio by hand
  - add `discover: free`, `rpd: 50` and `json_schema: false` to OpenRouter
- The per-day count resets when the app restarts.

### Commit status
Uncommitted, on branch `BTT-05_providers-parallel-models`.
