# BTT-05: Port Scriptorium's provider updates, parallel translation, and model settings

**Ticket folder:** `.claude/tickets/BTT-05-providers-parallel-model-settings/`. Copy this plan there as `plan.md` when work starts, and write `changelog.md` there at the end. **Branch:** `BTT-05_providers-parallel-models`, cut from `origin/master` (`b14a935`).

## Context

Scriptorium (`C:\projects\Personal\scriptorium`, SCP-05 plus NO-TASK commits `a506a3d`, `ab1faef`, `d4b620d`, `f15caf3`, `f6492a9`, `5990d52`, `b3f5bd1`, `5583ebc`) moved ahead of book-translator in three areas:

- **OpenRouter:**
  - model discovery that reads the prices and context sizes OpenRouter lists, with `discover: free`
  - a requests-per-day limit
  - detection of the "per day" 429, so the app moves to the next model instead of retrying
- **Strata and LM Studio:**
  - `concurrency: auto`, which takes the server's own slot count, polled every 10 s
  - server-down detection, which skips a server that isn't running
  - LM Studio loads a model on demand: `lms load -c/--parallel/--ttl`, with LM Studio's REST load as the fallback, and per-model `load_context` / `load_parallel`
- **Model choice:**
  - a Models dialog: detect, filter, tick/hide, add a model by id, per-provider limits
  - group defaults (`paid` / `strata` / `lmstudio`) plus one fallback order for every role

book-translator shares the same base: the same `OpenAiCompatClient`, registry, limiter and router, and the Strata port from BTT-02. So most of this is a port.

**What the user chose (2026-10-13):**
- **Providers:** port all four areas: OpenRouter, LM Studio auto-load, Strata auto slots and down detection, and the Models dialog.
- **Parallel:** each project gets a "Parallel" on/off switch and a "How many at once" setting (Auto = the provider's limit, or 1–16). An extra "Also split chapters" option runs chunks inside a chapter in parallel, without the previous-chunk context.
- **Models:**
  - per-agent fallback lists in New Project and in Settings
  - editing a project's settings after it is created
  - group defaults plus one order for every agent

What book-translator does today:
- Chapters run in parallel. The number at once is the first translator provider's `concurrency` (`runner.ts:189`).
- Chunks inside a chapter run one after another, because each gets the end of the previous chunk (`prevTail`).
- New Project sends only one model per agent (`NewProject.tsx:43`), so the fallbacks are lost.
- A project's settings can't be changed after it is created.

## A. Provider layer (engine): port from Scriptorium

**1. `src/shared/schemas.ts`**: copy the field definitions and doc comments from `scriptorium/src/shared/schemas.ts:25-101`.
- `providerModelSchema`: add `load_context` and `load_parallel`.
- `providerEntrySchema`:
  - `concurrency: number | 'auto'`
  - `rpd`
  - `discover: boolean | 'free'`
  - `discover_skip: string[]`
  - `load_models: boolean`
- New `modelsConfigSchema` for `config/models.md` (`kind: models`): `picked[]`, `hidden[]`, `limits{ concurrency?, rpm?, rpd? }`.
- `defaultsSchema` additions (`config/defaults.json`):
  - `groupDefaults: { paid?, strata?, lmstudio? }`: one `provider/model` each
  - `modelOrder: ('paid'|'strata'|'lmstudio')[]`, default `[]`
  - `lmstudio: { parallel 1–16 = 4, context ≥2048 = 131072, ttlMinutes ≥1 = 60 }`
  - `parallel: { enabled = true, maxAtOnce: 'auto' | 1–16 = 'auto', splitSections = false }`

**2. `src/engine/models/types.ts`**: add the `unreachable` flag (5th constructor argument) to `ProviderError`, as in Scriptorium.

**3. `src/engine/models/openaiCompat.ts`**: port from `scriptorium/src/engine/models/openaiCompat.ts`:
- the `UNREACHABLE` codes in `wrapFetchError`
- `loadConfig` / `lmsPath` options with `ensureLoaded` and `loadIfNeeded`. Loads of the same model are de-duplicated. A model LM Studio doesn't have fails without a retry.
- `listModelInfo()`, `ListedModel` and `listedModel()`: prices per 1M, a negative price counts as no price, and the `textOnly` check
- `listModels()` becomes a wrapper around `listModelInfo()`

**4. `src/engine/models/limiter.ts`**: port the per-day functions: `dayFull`, `markDayFull`, `requestsToday`, `dayResetsAt`, `utcDay`, and `rpd` counting in `noteRequest`. Also port `wakeAll`, and add `rpd` to `hasCapacity`.
- Simplification: the daily count is in memory only. Scriptorium seeds it from its spend files, which book-translator doesn't have. After a restart, OpenRouter's own "per day" 429 still marks the provider day-full.

**5. `src/engine/models/registry.ts`**: port from `scriptorium/src/engine/models/registry.ts`.
- New `ProviderInfo` fields: `concurrencyAuto`, `down`, `rpd`, `discoverSkip`, `loadModels`.
- `load()`:
  - read `config/models.md` (`readModelChoices`)
  - apply `limits`. These win over `providers.md`, and 0 means no limit.
  - add the `picked` models
  - keep the discovered models, minus anything `discover_skip` now excludes
  - keep the slot counts and down state across reloads
- `setupClient()`: pass `loadConfig` and `lmsPath` when `load_models` is on. `defaultLmsPath()` is `~/.lmstudio/bin/lms.exe`.
- `discover()`: the `free` mode, prices from the listing, `textOnly`, `discover_skip`, and the loaded-context override when `load_models` is on.
- New methods:
  - `catalog(providerId)`, `isShown(ref)`
  - `syncServerSlots()`: Strata `/status` `concurrency.serving`, or the LM Studio `/api/v1/models` `parallel` sum, capped at 16. It marks the server `down`.
  - `markDown()`, `loadConfigFor()`
  - `setDefaults({ aliases, order, lmLoad })`: book-translator reads these from `defaults.json`, not `settings.md`.
  - `resolve(alias)`, `groupOf(ref)`
  - `orderRefs(list)`: the stable sort by `modelOrder` that Scriptorium's `roleEntries` does
- Extend `guessFamily` with the OpenRouter maker prefix.

**6. `src/engine/models/router.ts`**, ported from `scriptorium/src/engine/models/router.ts:80-248`.
- `resolve(refs)`:
  - map the aliases with `registry.resolve`
  - apply `registry.orderRefs`
  - drop down and day-full providers, unless nothing else is left (`usable()`)
- `chat()` loop:
  - skip a provider that becomes unusable mid-run while a later model is left
  - an `unreachable` error on an auto server: call `markDown` and move to the next model without retrying
  - `isDailyLimitError`: call `markDayFull` and move to the next model
  - `isContextError`: no retry
  - when every model fails, throw "all models failed. a | b" listing why each one failed
- Add `onProviderDown` / `onProviderDayFull` callbacks. The service uses them to emit a `log` event and a fresh `models` event.

**7. Slot sync timer**:
- `serve.ts` (or `EngineService`) starts a 10 s `setInterval` that runs `registry.syncServerSlots()`.
- When anything changes, it calls `limiter.wakeAll(p)` and emits `models`.
- It is cleared on shutdown.
- It also runs once at startup and before a CLI `translate`.
- Copy `SLOT_SYNC_MS` and the `syncSlots` flow from `scriptorium/src/engine/engine.ts:52,193-230`.

**8. `seed/config/providers.md`**: update the frontmatter and the docs body from Scriptorium's seed.
- `openrouter`: `discover: free`, `discover_skip: [content-safety]`, `rpm: 20`, `rpd: 50`, `json_schema: false`.
- `lmstudio`: `concurrency: auto`, `load_models: true`, `discover_skip: [dflash]`.
- `strata`: `concurrency: auto`.
- `seed/config/defaults.json`: add `groupDefaults`, `modelOrder: []`, `lmstudio`, `parallel`.
- Note: `initDataFolder` never overwrites, so an existing data folder keeps its old `providers.md`. All new fields default to today's behavior. The Settings UI can switch a local provider to `auto`, and the changelog says so.

## B. Protocol and dispatcher

**`src/shared/protocol.ts`**:
- `ProviderSummary` gets: `concurrencyAuto`, `down`, `rpm`, `rpd`, `requestsToday`, `dayFull`, `dayResetsAt`, `loadModels`, `discover`.
- `ModelSummary` gets: `shown`, `picked`, `maxOutput`.
- New `CatalogModel` type, matching Scriptorium's.
- `ProviderPatch.concurrency` becomes `number | 'auto'`.
- `DefaultsPatch` gets: `groupDefaults`, `modelOrder`, `lmstudio`, `parallel`.

New commands, implemented in `src/engine/dispatcher.ts`. Each writes `config/models.md` with `atomicWrite` (keeping the Markdown body) or `defaults.json`, then runs `registry.load()` and returns `ModelsInfo`:

| Command | What it does |
|---|---|
| `detectModels { provider }` | `registry.catalog()`; the result is kept in memory per provider |
| `showModels { provider, refs, show }` | tick: add to `picked` with the listed price and context, remove from `hidden`; untick: add to `hidden` |
| `addModel { provider, id, priceIn?, priceOut?, context? }` | priced models are required for paid providers, as in Scriptorium |
| `setProviderLimits { provider, concurrency?, rpm?, rpd? }` | then `limiter.wakeAll` |
| `checkServers` | `syncServerSlots()` now |
| `updateProjectSettings { projectId, patch }` | rejected while the project is running ("pause it first"); `mergeSettings` plus `store.save`; returns `ProjectDetail` |

Other dispatcher changes:
- `setSecret` and `refreshModels` also re-run `discover()`, so OpenRouter's free models appear once a key is stored.
- `setDefaults` merges the new fields and calls `registry.setDefaults()`.

## C. Parallel translation

**Settings:**
- `src/shared/project.ts`: `ProjectSettings.parallel: { enabled: boolean; maxAtOnce: 'auto' | number; splitSections: boolean }`.
- `mergeSettings` (`src/engine/project/store.ts:193`) merges `parallel` like it merges `enabled`.
- `ProjectStore.load` fills in the default for an older `project.json`: `{ enabled: true, maxAtOnce: 'auto', splitSections: false }`, which is today's behavior.
- `service.defaultSettings()` takes `parallel` from `defaults.json`.

**`ProjectRunner.schedule()`** (`runner.ts:179`):
- **Units:** with `splitSections`, each chunk is its own queue item. Otherwise each section is one item, as today.
- **Workers:**
  - `!enabled` gives 1.
  - `'auto'` gives the resolved translator provider's `concurrency` (today's rule).
  - Otherwise `maxAtOnce`, clamped to 1–16.
  - The limiter still caps the requests sent to each provider.
- **Previous-chunk context:**
  - When not split: same as today.
  - When split: passed only if the previous chunk in the same section already has a `final`, i.e. it is done or flagged from an earlier run. Otherwise it is left out.
- Update the class doc comment.

**Estimate**: `service.ts:176` divides by the effective worker count, not the provider concurrency.

The glossary passes stay sequential, because each pass builds on the terms found so far.

## D. Model choice and UI (renderer)

**Aliases:**
- `paid`, `strata` and `lmstudio` may appear in any `agentModels` list, in defaults or in a project.
- They resolve at call time through `groupDefaults`, and `modelOrder` sorts every list. Both happen in `router.resolve`, so `budgetFor` and `makeCall` get them for free.

**New `src/renderer/ui/ModelListEditor.tsx`** (ordered fallback list):
- One `ModelSelect` row per entry, with ↑, ↓ and ✕ buttons, plus "+ Add fallback".
- The options include the alias entries "API default (deepseek/...)", "Strata default (…)" and "LM Studio default (…)".
- `ModelSelect` gains an `aliases` prop and hides models whose `shown` is false, unless one is the current value.

**`Settings.tsx`**:
- **Providers table:**
  - The Parallel cell becomes a number input plus an "auto" checkbox (local providers only). It saves through `saveProviders` with `'auto'`.
  - New per-minute and per-day inputs, saved through `setProviderLimits`.
  - The status column shows "down" or "daily limit used, resets HH:MM", and has a **Check now** button (`checkServers`).
  - A **Models…** button opens the Models dialog.
- **"Default models" card:**
  - one select per group (API, Strata, LM Studio), with ↑/↓ for the order
  - a checkbox "Use one fallback order for every agent", which sets `modelOrder`
  - each agent's `ModelListEditor`, replacing the single select. Saving sends the whole list.
- **"Parallel" defaults:** the on/off switch, How many (Auto or 1–16), and Also split chapters.
- **"LM Studio loading":** parallel, context window, and unload after N idle minutes.

**New `src/renderer/ui/ModelsDialog.tsx`**, a port of `scriptorium/src/renderer/ui/ModelsDialog.tsx`:
- the provider list on the left
- for the selected provider:
  - Detect models
  - a filter box, "free only", and "ticked only"
  - Tick all / Untick all
  - one row per model: id, context, price (free / local / $in-$out / no price)
  - add a model by id
- The group-defaults part stays in Settings and is not duplicated here.
- The zustand store (`src/renderer/store/store.ts`) gets `catalogs: Record<provider, {models, loading, error}>`.

**`NewProject.tsx`**:
- one `ModelListEditor` per agent, seeded from the defaults, sending the whole list (fixes the dropped fallbacks)
- a Parallel section: the on/off switch, How many at once (Auto / 1–16), and "Also split chapters (faster, loses the previous-passage context)"

**`ProjectView.tsx`**: a new **Settings** tab (`Tab` adds `'settings'`) in a new `ProjectSettingsTab.tsx`.
- It has the agents' `ModelListEditor`s, the agent on/off switches, the parallel options, and pause-after-glossary.
- It is disabled while running, with a "Pause the project to change its settings" note.
- Save sends `updateProjectSettings`.
- A note says a chunk-size change applies only while every chunk is still pending (the existing `prepareChunks` rule).

## E. Tests (vitest, `tests/`)

- **`openaiCompat.test.ts`**:
  - `listModelInfo`: OpenRouter prices to per-1M, a negative price counts as no price, `textOnly`
  - the `unreachable` flag on `ECONNREFUSED`
  - `ensureLoaded` through the REST stub (`lmsPath: null`): loads only once for parallel requests, a missing model is not retryable, an already-loaded model is not loaded again
- **`registry.test.ts`**:
  - `discover: free`, `discover_skip`
  - `models.md` picked, hidden and limits (0 means none)
  - `syncServerSlots` with Strata `/status` and the LM Studio `/api/v1/models` stubs, down when there's no answer
  - alias resolution and `orderRefs`
- **New `limiter.test.ts`**: rpd, dayFull, `markDayFull`, and the reset at UTC midnight (injected `now`).
- **`router.test.ts`**:
  - a daily-limit 429 goes to the next model with no retries, and the provider is skipped afterwards
  - an unreachable auto server is marked down and skipped
  - the aggregated "all models failed" message
- **`dispatcher.test.ts`**:
  - `detectModels`, `showModels`, `addModel` (paid without a price is rejected), `setProviderLimits`
  - `saveProviders` with `'auto'`
  - `updateProjectSettings` is rejected while running
- **`pipeline.test.ts`** (mock with a delay, counting the most requests in flight):
  - parallel off gives 1 at a time
  - `maxAtOnce` 3 gives at most 3
  - `splitSections` runs chunks of one section at the same time and sends no previous-chunk context
  - an old `project.json` without `parallel` still runs

## Verification

1. `yarn typecheck`, `yarn lint` and `yarn test` all pass.
2. Live check with a throwaway data folder (`BOOK_TRANSLATOR_DATA=.claude/temp/bt-data yarn dev`):
   - **Strata running:** the Settings provider row shows auto with its slot count. Stop Strata: the row turns "down" after the next sync or the first failed request, and a run falls back to DeepSeek. **Check now** restores it.
   - **LM Studio:** pick a model that isn't loaded, start a small TXT. It loads with the configured context and parallel count (`lms ps`), and the auto slots follow.
   - **OpenRouter** (key stored): the free models appear. The Models dialog's Detect lists prices. Tick, hide and add-by-id survive a restart (`config/models.md`).
   - **Parallel:** a one-chapter TXT with "Also split chapters" shows several chunks translating at once. With parallel off, only one at a time.
   - **Fallbacks:** a project created in the UI keeps its fallback lists (check `project.json`). Its Settings tab can change models while paused, but not while running.
3. Write `changelog.md` in the ticket folder, using the BTT-02 layout.

## Implementation status

Engine side (sections A, B, C, E) by the first implementer. Section D (renderer) by the second implementer.

- [x] A. Provider layer: schemas (`load_context`/`load_parallel`, `concurrency: auto`, `rpd`, `discover: free`, `discover_skip`, `load_models`, `modelsConfigSchema`, defaults `groupDefaults`/`modelOrder`/`lmstudio`/`parallel`), `ProviderError.unreachable`, openaiCompat (UNREACHABLE codes, `ensureLoaded`/`loadIfNeeded`, `listModelInfo`/`listedModel`), limiter (rpd/day functions, `wakeAll`), registry (models.md choices and limits, discover free/skip/prices, `catalog`, `isShown`, `syncServerSlots`, `markDown`, `loadConfigFor`, `setDefaults`, `resolve`, `groupOf`, `orderRefs`, `guessFamily`), router (`usable()`, alias/order resolve, down/day-full skip, daily-limit and context handling, aggregated message, `onProviderDown`/`onProviderDayFull`), slot sync timer in `serve.ts` (10 s, runs once at start; CLI `translate` syncs once), seed `providers.md` and `defaults.json`.
- [x] B. Protocol and dispatcher: new `ProviderSummary`/`ModelSummary` fields, `CatalogModel`, `CatalogResult`, `ProviderPatch.concurrency` as `number | 'auto'`, `DefaultsPatch` additions, commands `detectModels`, `showModels`, `addModel`, `setProviderLimits`, `checkServers`, `updateProjectSettings`; `setSecret` re-runs discovery; `setDefaults` merges the new fields and calls `registry.setDefaults()`; the registry gets `setDefaults()` from `defaults.json` at startup (serve and CLI) and after `setDefaults`/`refreshModels`.
- [x] C. Parallel translation (engine): `ProjectSettings.parallel`, `mergeSettings`, `ProjectStore.load` default, `service.defaultSettings`, `workerCount()` and `schedule()` units/workers/previous-chunk rules, estimate divides by the worker count.
- [x] E. Tests: `openaiCompat`, `registry`, new `limiter`, `router`, `dispatcher`, `pipeline` (parallel), all as listed in section E.
- [x] D. Renderer UI:
  - [x] `ModelSelect.tsx`: `aliases` prop, hides `shown === false` models unless current; `seedList()` and `GROUP_ALIASES` helpers.
  - [x] `ModelListEditor.tsx` (ordered list, up/down/remove, "+ Add fallback", alias options "API/Strata/LM Studio default (<ref>)" only when set).
  - [x] `ModelsDialog.tsx` (providers, Detect models, filter, free only, ticked only, Tick/Untick all, rows, Add model by id) and `catalogs` + `detectModels` in the store (the `models` event was already applied).
  - [x] `Settings.tsx`: Parallel number + auto checkbox, per min/day inputs (`setProviderLimits` on blur/Enter), status (down / daily limit / today's count), Check now, Models... button; Default models card (group defaults, order, shared-order checkbox, per-agent lists); Parallel card; LM Studio loading card.
  - [x] `NewProject.tsx`: whole lists per agent (fixes the single-model bug), Parallel options seeded from defaults.
  - [x] `ProjectView.tsx` Settings tab + `ProjectSettingsTab.tsx` (locked while running, save -> `updateProjectSettings` then `loadDetail`).
  - [x] `styles.css`: dialog/models classes.

### Deviations

- `detectModels` returns `CatalogResult` (`{ provider, models: CatalogModel[], at }`) and throws when the provider can't be asked, instead of `ModelsInfo`. The UI needs the list itself; `showModels`/`addModel`/`setProviderLimits`/`checkServers` return `ModelsInfo` as planned.
- `showModels` takes `{ provider, refs, show }` as in the plan; it throws (instead of logging) for an unknown provider, a ref of another provider, an undetected model, or a paid model without a listed price. `addModel`, `setProviderLimits` throw for an unknown provider.
- The Scriptorium `models.catalog`/`servers` events are not ported: replies carry the data, and server changes use the existing `models` event (plus a `log` event). The slot sync logic lives in `CommandDispatcher.syncSlots()` (called by the timer in `serve.ts`, by `checkServers`, and after `saveProviders`), not in `EngineService`; the router callbacks `onProviderDown`/`onProviderDayFull` are wired in the dispatcher constructor.
- `applyModelDefaults(registry, dataDir)` added in `src/engine/config.ts` (reads defaults.json, calls `registry.setDefaults`). The registry's default `defaults` before that call is the schema's defaults.
- `ModelRegistry.discover()` keeps BT's `loadedContext` field: for `load_models` providers the loaded window goes to `context` (as Scriptorium), for other providers to `loadedContext` (as before).
- The glossary estimate is no longer divided by the glossary model's concurrency (glossary passes are sequential); translator/proofreader/QA are divided by the worker count (`workerCount`).
- `setProviderLimits` also copies the new limits onto the old `ProviderInfo` object: requests already waiting for a slot hold it across a `registry.load()`.
- `saveProviders` also runs `syncSlots()` after reloading, so a switch to `auto` shows its slot count at once.
- Tests helper change: `rig()` now defaults to an offline `fetchImpl` and `lmsPath: null` (no real network/LM Studio in tests). No existing expectation was changed.
- Renderer: section D added a small shared `ParallelFields.tsx` (used by Settings, NewProject, ProjectSettingsTab) that the plan did not list.
- Settings: the per minute / per day inputs share one "Per min / day" column and are shown for API providers only (local providers have no such limits); the three defaults cards (models, Parallel, LM Studio) share one draft, and each card's Save defaults button saves it all.
- The Models dialog has no limits or LM Studio loading fields (those live in Settings); `ModelSummary` has no `source`, so the row source label is derived from `picked`/`discovered`.
- The Parallel options in New Project sit inside the "Agents and models" card, not their own card.
- No changes to src/shared or src/engine.

### Verification

- `yarn typecheck`: pass (node + web projects).
- `yarn lint`: pass (no output, exit 0).
- `yarn test`: 18 test files, 198 tests, all passed (was 17 files / 120 tests before).
- Not run: the live checks of the Verification section above (Strata, LM Studio, OpenRouter, UI) and `changelog.md`.

### Verification (section D)

- `yarn typecheck`: pass (exit 0). `yarn lint`: pass (exit 0).
- `yarn test`: 18 files, 198 tests, all passed.
- `yarn build`: renderer and main bundle built.
- Not run: any visual or live check of the UI (no Electron session was started), so layout of the wider providers table, the dialog and the Settings tab is unchecked.
