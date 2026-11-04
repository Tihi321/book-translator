# BTT-24 Strata model discovery (Book Translator)

Branch: `BTT-24_strata-model-discovery` (from `master`). Ticket of the hub task HUB-26, task T4: a replay, adapted, of VN Studio's VNO-60 (`C:\projects\Personal\visual-novels-orchestrator`, branch `VNO-60_strata-model-discovery`, commit 9d0d173; replay bundle `.claude/tickets/VNO-60-strata-model-discovery/replay-bundle.md` there).

The plan is `C:\projects\Personal\creative-hub\.claude\tickets\HUB-26-strata-model-discovery\plan.md`. Read these parts of it:

- "C1. The shared contract" (C1.1 providers.md shape and schema fields, C1.2 resolution rules 1-11, C1.3 neutral refs, C1.4 migration contract).
- Table "Files and modules per repo", row `book-translator`.
- "T4 (replay of T1, adapted)" and "T7", the paragraph "Seed doc text for T1-T6".
- Acceptance criteria AC-1 to AC-4 (AC-5 over this repo's `seed/config`).

## Adapted from VNO-60

- Migration: BT has no list of migration ids. `migrateStrataLoaded` in `src/engine/store/migrate.ts`, called from `initDataFolder` (`src/engine/store/dataFolder.ts`) after `migrateProviders`; it records `strata-loaded-v1` in `migrations` of `config/seed-state.json` so it runs once. Plus (BT only): a numeric `concurrency` on `strata` becomes `auto`, and the ref rename is in `config/defaults.json` (`agentModels`, `fallbacks`, `groupDefaults`).
- Code defaults: `src/shared/schemas.ts` (`fallbacks` default), `src/engine/dispatcher.ts` (`seedFallbacks`), `src/engine/models/registry.ts` (`modelDefaultsOf`, `setDefaults`) -> `strata/default`.
- Display: `served` in the dispatcher's models summary (`modelsInfo`), `src/renderer/ui/ModelSelect.tsx` label, `Settings.tsx` text "context from Strata".
- Keep VNO-60's deviations: `syncServerSlots` returns `{ slots, served }`; `catalog` lists nothing for a provider with `loaded` rows.

## Checklist

- [x] C1.1 schema fields: `loaded`, `aliases`, model `json_schema`, provider `profiles` (`src/shared/schemas.ts`)
- [x] C1.2 rules 1-11 in `registry.ts`, `router.ts`, `openaiCompat.ts`, `types.ts`, `dispatcher.ts`, `ModelSelect.tsx`, `Settings.tsx`, `cli.ts`
- [x] C1.3 neutral refs in `seed/config/defaults.json` and the code defaults
- [x] C1.4 migration `migrateStrataLoaded` (providers.md, concurrency, defaults.json)
- [x] Seed docs (T7 text) in `seed/config/providers.md`
- [x] Tests: AC-1 (`tests/registry.test.ts`, the down/up test), AC-3 (`tests/dataFolder.test.ts`, one case)
- [x] `ROADMAP.md` row
- [x] `yarn typecheck`, `yarn lint`, `yarn test` green (AC-4); AC-5 grep over `seed/config`

Result and the C1 rule to file:line map: `changelog.md` in this folder.
