# BTT-14 changelog

## 2026-10-22: a providers reload reaches a project that is already running

Branch `BTT-13-14_roadmap`, after BTT-13's commit 809f4ef. Plan: `plan.md` in this folder.

### Files

- `src/engine/models/registry.ts`: `generation` counts successful `load`s.
- `src/engine/models/limiter.ts`:
  - `acquire(p, signal, current?)` reads the provider again before every try, so a reloaded `concurrency` decides for a request that is waiting.
  - A provider removed during the wait ends it with "provider <id> was removed from the config while the request waited".
  - New `wakeEvery()` wakes the waiters of every provider, including one that is gone.
- `src/engine/models/router.ts`:
  - When a reload happened since the call started, each attempt takes its model from the registry again. The new client, `extra_body` and prices apply, and the `attempt` and `done` events name that model.
  - A model that was removed, turned off or left without a client releases its slot and fails with "<ref>: removed or turned off in the config during the call". The next model in the list is tried.
  - A request already sent finishes on the client it was sent with.
- `src/engine/pipeline/runner.ts`:
  - The queue and the workers live on the runner.
  - `configReloaded()` recomputes the worker count. It starts more workers on the same queue when the count went up. When it went down, the extra workers stop after their current unit, checked and counted in one step, so no unit is lost or run twice.
  - `schedule` waits for workers started later too.
  - `configReloaded()` does nothing to workers before the chunks are prepared, during the glossary stage, or after an abort.
  - The chunk plan stays. When the new budget is smaller than the plan's, one warning names how many queued chunks no longer fit. A budget that grew is logged as info.
- `src/engine/service.ts`: `runs` keeps the runner. `configReloaded()` passes the reload to every running project.
- `src/engine/dispatcher.ts`: `reloadConfig` calls `wakeEvery()`, `emitModels()` and then `service.configReloaded()`. The doc comment of `reloadConfigIfChanged` says what follows a reload and what does not.
- `README.md`: the reload paragraph says the same.
- `ROADMAP.md`: the "Engine" item is gone. "Where it stands" has a line for this branch and says nothing of Book Translator's own is open.
- Tests:
  - `tests/limiter.test.ts` (+3): a higher reloaded concurrency takes the slot, a lower one keeps waiting, a removed provider rejects.
  - `tests/router.test.ts` (+4): a waiting request goes out on the reloaded client while the earlier one finishes on the old client. A removed model goes to the next model, or fails with the new text when it was the only one. A removed provider ends the wait. Without a reload the same objects are used.
  - `tests/dispatcher.test.ts` (+3, "config reload"): concurrency 1 → 2 adds a second worker. 4 → 1 drops workers, and every chunk is translated exactly once. A smaller context logs the budget warning once, and the chunk count stays the same.

### Deviations from the plan

- `wakeEvery()` replaces the per-provider `wakeAll` loop in `reloadConfig`. A waiter of a removed provider is not in the new providers map, so that loop would never wake it.
- The router tests reload by editing providers.md and calling `registry.load()`, then put a fake client on the new provider object, because the mock provider shares one client between models. The removed-provider-during-wait test was added beyond the plan's list.
- A chunk's size for the warning is the planner's measure: `countTokens` plus `SEG_OVERHEAD` per segment, over chunks still in the queue.

### Verification

- `yarn typecheck`, `yarn lint`: exit 0. `yarn test`: 24 files, 293 tests (baseline 283). The implementer and the orchestrator each ran it.
- The three touched test files ran 4 times in a row with no flakes. `yarn build:engine` passes.
- **Not run:** the live check in the dev app. The new dispatcher tests drive a real `EngineService` with the mock provider through a providers.md edit and `reloadConfigIfChanged`, which is the same path.

### Known limitations

- The rpm wait right after a slot still uses the rpm of the provider object the attempt started with. The next attempt uses the new one.
- The skip check for a down or day-full server, at the top of each model, reads the object the call resolved.

### Commit status

Committed on `BTT-13-14_roadmap` (not pushed).
