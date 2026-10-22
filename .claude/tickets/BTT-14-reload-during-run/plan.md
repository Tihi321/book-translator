# BTT-14: A providers reload reaches a run that is already going

Ticket folder: `.claude/tickets/BTT-14-reload-during-run/`. Branch: `BTT-13-14_roadmap` (one branch for the ROADMAP.md items BTT-13 and BTT-14, one commit per ticket), after BTT-13's commit.

Source: `ROADMAP.md` > "Engine": "Reload during a run. A running project keeps its chunk plan after a providers reload, and a request already waiting for a slot holds the old provider until it wakes."

## Today

- `Dispatcher.reloadConfig` (`src/engine/dispatcher.ts:262-284`) swaps `registry.providers` / `registry.models` for new objects and calls `limiter.wakeAll(p)` with the new providers.
- A request waiting in `ProviderLimiter.acquire(p)` (`src/engine/models/limiter.ts:34`) loops on `tryAcquire(p)` with the **old** `ProviderInfo`: the old `concurrency` decides whether it fits, and after the slot it sends with the old `client`, `extraBody` and prices (`src/engine/models/router.ts:146-176`). A provider or model removed from providers.md still gets the request.
- The model list of a call is resolved once at the start of `chat` (`router.ts:131`); a retry after a backoff also uses the old objects.
- Each agent call already resolves its refs afresh (`runner.ts` `makeCall`), so the next call after a reload uses the new providers. What stays fixed for the whole run: the chunk plan (`prepareChunks`, `runner.ts:193`) and the number of workers (`schedule`, `runner.ts:225`, from `workerCount`).

## Decisions

- **The waiting request follows the reload.** `ProviderLimiter.acquire(p, signal, current?)`: `current: () => ProviderInfo | undefined` is read before every try, so the reloaded `concurrency` decides. When it returns `undefined` (provider removed) `acquire` throws a `ProviderError` "provider <id> was removed from the config while the request waited" (not retryable). Slots are counted by provider id, so a slot taken under the old object is released correctly.
- **The router uses the reloaded model for every attempt.** `ModelRegistry` gets `generation` (incremented by each successful `load`). `chat` notes the generation at its start; before each attempt (after the slot and the rpm wait), if the generation changed it takes `registry.getModel(model.ref)`:
  - found, its provider enabled, `available` and with a client: the attempt uses it (new client, `extraBody`, prices; `done` reports it);
  - gone, disabled, or not usable: the slot is released, the failure reads "<ref>: removed or turned off in the config during the call", and the next model of the list is tried.
  - Refs resolved later in the list are looked up the same way, so a model added in front of the list does not join a call already going (the list stays the one the call started with; only the objects are refreshed).
  - A request already sent finishes on the client it was sent with.
- **The run's worker count follows the reload.** `ProjectRunner.configReloaded()`, called for every running project by a new `TranslationService.configReloaded()` from `Dispatcher.reloadConfig` after a successful load:
  - `schedule` keeps its queue and worker set on the runner; `configReloaded` recomputes `workerCount` and starts extra workers on the same queue when it went up. When it went down, workers finish their current unit and stop until the number of busy workers is at the new count. `schedule` awaits every worker it started, also those started later.
- **The chunk plan stays for the run** (re-planning would renumber chunk files that finished chunks, the UI and an outside translator refer to). `configReloaded` recomputes `budgetFor` and, when the new budget is smaller than the plan's (`project.chunking.budget`) and pending chunks are larger than the new budget, logs one warning per reload: "<n> pending chunk(s) are larger than the new chunk budget (<new> tokens, the plan used <old>). They keep the plan; a model too small for one hands it to the next model in its list." A budget that grew is logged as info only when the project has chunks still pending ("the plan keeps chunks of up to <old> tokens; a project with no chunk started re-plans at its next start"). The doc comment of `reloadConfigIfChanged` says what follows the reload and what does not.

## Checklist

- [x] 1. `src/engine/models/registry.ts`: `generation` counter, incremented at the end of a successful `load`.
  _Done: `generation = 0`, `this.generation++` after `configStamp` in `load`._
- [x] 2. `src/engine/models/limiter.ts`: `acquire(p, signal?, current?)` as above; `wakeAll` unchanged.
  _Done. Deviation: added `wakeEvery()` (wakes the waiters of every provider id) and `reloadConfig` calls it instead of the per-provider `wakeAll` loop: a waiter of a removed provider is not in the new providers map, so `wakeAll(p)` over the new map would never wake it. `wakeAll` itself is unchanged and still used elsewhere._
- [x] 3. `src/engine/models/router.ts`: pass `() => this.registry.providers.get(provider.id)` to `acquire`; the generation check and the fresh model before each attempt; the "removed or turned off" failure goes to the next model. Keep the existing paths (held slots, down servers, day-full) as they are.
  _Done. `generation` is noted once per `chat`; each model of the list keeps its own `seenGeneration`, so a later model of the list is refreshed at its first attempt after a reload. The check sits after the slot and the rpm wait and before `noteRequest`. A model removed/turned off: failure `<ref>: removed or turned off in the config during the call`, `lastError` set to a ProviderError of it, `break` (finally releases the slot), next model._
- [x] 4. `src/engine/pipeline/runner.ts`: queue and workers on the runner; `configReloaded()` (worker count up/down, the budget warning).
  _Done. Runner fields `queue`, `workers`, `alive`, `target`, `split`, `scheduling`, `fatal`; `spawn()` / `work()` split out of `schedule`. A worker checks `alive > target` and decrements `alive` in the same synchronous step before taking a unit, so down-scaling stops exactly the surplus and never drops a unit (a unit is shifted only after the check); `schedule` awaits `workers` in a loop until the set is empty, so late workers are awaited. `configReloaded` is a no-op until `this.chunks` is filled (glossary stage) and skips workers unless `scheduling` and not aborted. The size of a pending chunk is the sum of `countTokens(seg.text) + SEG_OVERHEAD` over its segments (the planner's measure); only chunks still in the queue count as pending. The warning is only logged when at least one queued chunk is larger; the info line for a grown budget when the queue is not empty._
- [x] 5. `src/engine/service.ts`: keep the runner in `this.runs`; `configReloaded()` calls each running runner. `src/engine/dispatcher.ts` `reloadConfig` calls it after `emitModels`; update its doc comment.
  _Done: `runs` holds the runner; `EngineService.configReloaded()`; `reloadConfig` calls `wakeEvery()`, `emitModels()`, `service.configReloaded()`; doc comment of `reloadConfigIfChanged` rewritten._
- [x] 6. Tests:
  - `tests/limiter.test.ts`: a waiter woken after `current()` gives a higher concurrency takes the slot; with a lower one it keeps waiting; `current()` returning `undefined` rejects with the removed-provider error.
  - `tests/router.test.ts`: a request waiting for a slot while the registry reloads is sent with the new client (two mock clients, the first slot held by a blocked request); a model removed during the wait goes to the next model with the "removed or turned off" failure text; no reload → the same objects are used (generation unchanged).
  - `tests/dispatcher.test.ts` "config reload": a running mock project (parallel on, `maxAtOnce: 'auto'`, provider concurrency 1) gets a second worker after providers.md raises the mock provider's concurrency to 2 (two chunks in flight at once afterwards); a reload that lowers the context below the plan's chunk size logs the warning once.
  _Done: 3 limiter tests, 4 router tests, 3 dispatcher tests (second worker after concurrency 1 to 2; a worker dropped after 4 to 1 with every chunk translated exactly once; the warning once with the plan unchanged). Gated with deferred promises and `setImmediate` ticks, no sleeps. Deviation: the router tests reload by editing providers.md and calling `registry.load()` then setting a fake client on the new provider object (the mock provider has one client for all), and a provider-removed-during-wait test was added._
- [x] 7. `README.md` (where providers reload is described) and `ROADMAP.md` (drop the "Engine" item); `changelog.md` in this folder.
  _Done: README line about reloads rewritten; ROADMAP "Engine" section removed (it had only this item); the orchestrator reworded "Where it stands" (a line for this branch, 293 tests, nothing open) and wrote `changelog.md`._

## Verification

- `yarn typecheck`, `yarn lint`, `yarn test` green; `yarn build` green.
- Live (mock only, the BTT-13 dev harness): start a mock run with `BOOK_TRANSLATOR_MOCK_DELAY` large enough to queue requests, raise the mock provider's `concurrency` in providers.md while it runs, and see the log line for the reload and more chunks in flight; then remove nothing the run needs.

## Verification evidence (implementation)

- `yarn typecheck` exit 0, `yarn lint` exit 0, `yarn test` 24 files / 293 tests pass (baseline 283 + 10 new; the three touched test files run 4 times in a row, 73 passed each), `yarn build:engine` exit 0.
- Live check skipped: the new dispatcher tests run a real `EngineService` with the mock provider through a providers.md edit and `reloadConfigIfChanged`, which is the same path; no headless mock-only harness was started, so no processes were started.
