# Changelog: BTT-22 Fallback models as an open list

Date: 2026-10-24
Ticket: BTT-22 (branch `BTT-22_fallback-models`)
Status: Committed to BTT-22_fallback-models

## Summary
Migrated Scriptorium's open fallback list models change (SCP-19 / commit `f1f42f6`) into Book Translator. Users can now configure an arbitrary number of fallback models programmatically and in the UI across API, Strata, LM Studio, client, and custom providers, and toggle a shared fallback order for all agents.

## Behavioral Changes by File

### 1. `src/shared/schemas.ts`
- Added `fallbacks: z.array(z.string().min(1)).min(1).default(['deepseek/deepseek-flash', 'strata/qwen3.8-flash-next'])` and `fallbackShared: z.boolean().default(false)` to `defaultsSchema`.
- Preserved `groupDefaults`, `modelOrder`, and `fallback_shared` as optional for backward compatibility with existing data folders and tests.

### 2. `src/shared/protocol.ts`
- Added `kind: string` to `ModelSummary` so the UI knows each model's kind without guessing.
- Added `fallbacks?: string[]` and `fallbackShared?: boolean` to `DefaultsPatch`.

### 3. `seed/config/defaults.json`
- Added seed values for `"fallbacks": ["deepseek/deepseek-flash", "strata/qwen3.8-flash-next"]` and `"fallbackShared": false`.

### 4. `src/engine/models/registry.ts`
- Updated `ModelDefaults` interface and `modelDefaultsOf()` to carry `fallbacks` and `shared`, with backward-compatible extraction from legacy `groupDefaults` / `modelOrder` when `fallbacks` is omitted.
- Added `kindOfRef(ref: string)`: derives the kind from the model's provider (provider id for local, custom, or client providers; `'paid'` for remote API providers).
- Added `kindOf(ref: string)`: returns `kindOfRef(this.resolve(ref))`.
- Added `aliasMap()`: maps the first row of each kind to its kind name (`paid`, `strata`, `lmstudio`, `client`, or custom id) and subsequent rows to `<kind>-<n>` (`paid-2`, `paid-3`, etc.).
- Updated `resolve(ref: string)`: resolves aliases via `aliasMap()` and preserves existing alias mappings.
- Added `fallbackRefs()`: exposes the fallback list.
- Updated `orderRefs(list)`:
  - When `fallbackShared` is `true`: applies Scriptorium's open fallback order substitution algorithm. A concrete model specified by an agent replaces the first untaken row of its kind; concrete models with no matching row and remaining aliases follow; client models always go first; duplicates are dropped.
  - When `fallbackShared` is `false`: maintains the list's order (supporting legacy `modelOrder` if present).
- Preserved `groupOf(ref)` for backward compatibility with existing components and tests.

### 5. `src/engine/dispatcher.ts`
- `modelsInfo()`: populates `kind: this.registry.kindOf(m.ref)` on each `ModelSummary`.
- `setDefaults()`: handles `patch.fallbacks` (deduplicated, non-empty) and `patch.fallbackShared`.
- `cleanDefaults()`: cleans removed custom provider model refs from `fallbacks`, defaulting back to seed fallbacks if all are removed.

### 6. `src/renderer/ui/ModelsDialog.tsx`
- Added the Scriptorium Fallback models section at the top of the dialog, matching the user's uploaded reference UI:
  - Header & description for kind/model rows and alias mapping.
  - "One fallback order for every role" checkbox (`data-testid="order-shared"`).
  - Row list with row index, alias tag (`data-testid="fallback-alias-${i}"`), kind select (`data-testid="fallback-kind-${i}"`), model select (`data-testid="fallback-model-${i}"`), up/down buttons, and remove button.
  - "+ Add a fallback" button (`data-testid="fallback-add"`).
  - Dynamic explanatory text explaining top-to-bottom fallback order and role model replacement.
  - Changes save immediately via `setDefaults` command.

### 7. `src/renderer/ui/ModelListEditor.tsx` & `src/renderer/ui/Settings.tsx`
- Updated `useAliasOptions()` in `ModelListEditor.tsx` to generate alias dropdown items from `defaults.fallbacks` (`paid`, `paid-2`, `strata`, `lmstudio`, custom provider aliases).
- Updated `Settings.tsx` to include `fallbacks` and `fallbackShared` in `draft` state and `saveDefaults()`.

### 8. `tests/registry.test.ts` & `tests/dispatcher.test.ts`
- Added test suite `fallbacks as an open list (BTT-22 / SCP-19)` covering alias resolution, kind detection, and shared order substitution with concrete model replacement and client-first ordering.
- Added dispatcher tests for `setDefaults` updating `fallbacks` and `fallbackShared` and validating non-empty fallback lists.

## Verification
- `yarn typecheck`: Passed with 0 errors.
- `yarn lint`: Passed with 0 errors.
- `yarn test`: 24 test files passed, 336 tests passed (0 failures).
