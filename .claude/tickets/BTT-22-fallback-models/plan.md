# BTT-22: Fallback models as an open list (migrated from Scriptorium SCP-19)

Ticket folder: `.claude/tickets/BTT-22-fallback-models/`
Branch: `BTT-22_fallback-models` cut from `master`

## Background & Goal
In Scriptorium commit `f1f42f6` (ticket SCP-19 T1), the fixed 3-group defaults (`paid`, `strata`, `lmstudio`) and fixed `model_order` were replaced with an open, arbitrary-length fallback list.
Each row in the list has:
- A derived kind (API, Strata, LM Studio, client, or custom provider id)
- Its selected model
- An alias name (`paid`, `paid-2`, `strata`, `lmstudio`, `client`, etc.)
- Add, remove, up, and down controls
- A shared flag ("One fallback order for every role" / "One fallback order for every agent") that sorts every list with concrete models taking the place of untaken rows of that kind, with client models placed first.

We migrated this change into Book Translator:
- Schema, protocol, and defaults storage (`fallbacks`, `fallbackShared` in `defaults.json`).
- Registry: `kindOfRef`, `kindOf`, `aliasMap`, `resolve`, `orderRefs`, `fallbackRefs`.
- Protocol: `ModelSummary.kind`, `DefaultsPatch.fallbacks`, `DefaultsPatch.fallbackShared`.
- Engine / Dispatcher: `modelsInfo` populating `kind`, `setDefaults` saving `fallbacks`/`fallbackShared`, `cleanDefaults` stripping removed custom provider refs.
- UI: `ModelsDialog.tsx` getting the exact Fallback models section as in Scriptorium (matching the user's screenshot), and `Settings.tsx` / `ModelListEditor.tsx` / `ModelSelect.tsx` aligning with the new alias and fallback structure.
- Tests: Registry, dispatcher, and router tests covering open fallback lists, alias resolution, shared order substitution, and saving.

## Plan & Checklist

- [x] **1. Schemas & Protocol (`src/shared/schemas.ts`, `src/shared/protocol.ts`)**
  - Update `defaultsSchema` in `src/shared/schemas.ts`:
    - Add `fallbacks: z.array(z.string().min(1)).min(1).default(['deepseek/deepseek-flash', 'strata/qwen3.8-flash-next'])`.
    - Add `fallbackShared: z.boolean().default(false)`.
    - Keep `groupDefaults`, `modelOrder`, `fallback_shared` optional for backward-compatibility.
  - Update `src/shared/protocol.ts`:
    - Add `kind: string` to `ModelSummary`.
    - Add `fallbacks?: string[]`, `fallbackShared?: boolean` to `DefaultsPatch`.

- [x] **2. Model Registry & Config (`src/engine/models/registry.ts`, `src/engine/config.ts`)**
  - In `registry.ts`:
    - Update `ModelDefaults` interface: `{ fallbacks: string[]; shared: boolean; aliases?: Record<string, string>; lmLoad: ... }`.
    - Update `modelDefaultsOf(d: DefaultsConfig)` to extract `fallbacks` and `fallbackShared`, with backward-compat fallback derivation if `fallbacks` is missing.
    - Implement `kindOfRef(ref: string): string` (maps client/local/custom to provider id, remote API to `'paid'`).
    - Implement `kindOf(ref: string): string`.
    - Implement `aliasMap(): Map<string, string>` (kind name for 1st row of that kind, `<kind>-<n>` for n-th).
    - Update `resolve(ref: string): string` to use `aliasMap()`.
    - Implement `fallbackRefs(): string[]`.
    - Update `orderRefs(list: readonly string[]): string[]` to implement the open list substitution algorithm when `shared` is true, and return `[...list]` when false (supporting legacy `order` sort as fallback).

- [x] **3. Dispatcher & Defaults (`src/engine/dispatcher.ts`, `seed/config/defaults.json`)**
  - In `dispatcher.ts`:
    - In `modelsInfo()`: assign `kind: this.registry.kindOf(m.ref)` on each `ModelSummary`.
    - In `setDefaults()`: handle `patch.fallbacks` and `patch.fallbackShared`.
    - In `cleanDefaults()`: remove `${id}/` from `fallbacks` without leaving it empty.
  - In `seed/config/defaults.json`:
    - Add `"fallbacks": ["deepseek/deepseek-flash", "strata/qwen3.8-flash-next"]`, `"fallbackShared": false`.

- [x] **4. Renderer UI (`src/renderer/ui/ModelsDialog.tsx`, `Settings.tsx`, `ModelListEditor.tsx`, `ModelSelect.tsx`)**
  - In `ModelsDialog.tsx`:
    - Add the Fallback models section at the top of the dialog, matching Scriptorium and the user's screenshot.
    - Title: "Fallback models: each row is a kind (API, Strata, LM Studio ...) and its model. roles.md names a kind for its first row (paid, strata, lmstudio ...) and kind-2, kind-3 for the next ones."
    - Checkbox: "One fallback order for every role" (`data-testid="order-shared"`).
    - Rows (`data-testid="fallback-row-${i}"`) with row number, alias, kind select, model select, up/down/remove buttons.
    - "Add a fallback" button (`data-testid="fallback-add"`).
    - Explanation text based on `shared`.
    - Save on each row change / add / remove / reorder immediately via `setDefaults`.
  - In `ModelListEditor.tsx`:
    - Update `useAliasOptions()`: generate alias options from `defaults.fallbacks` using `kind` and `<kind>-<n>` names.
  - In `Settings.tsx`:
    - Update the "Default models for a new translation" section to use `fallbacks` and `fallbackShared`, keeping it in sync.

- [x] **5. Verification & Tests (`tests/registry.test.ts`, `tests/dispatcher.test.ts`)**
  - Add tests for `kindOf`, `resolve` (`paid`, `paid-2`, `strata`, `lmstudio`, `client`).
  - Add tests for `orderRefs` with `shared: true` (concrete model replaces row of its kind, client model first).
  - Add tests for `setDefaults` with `fallbacks` and `fallbackShared`.
  - Add tests for `cleanDefaults` removing custom provider from `fallbacks`.
  - Run `yarn typecheck`, `yarn lint`, and `yarn test` to ensure 100% pass rate.
