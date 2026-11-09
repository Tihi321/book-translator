# BTT-27 changelog

## 2026-11-09 BTT-27: pre-run fixes

Branch `BTT-27_pre-run-fixes` (from `master` d4129fa), repo book-translator. Request REQ-0006 task A1.

### Changes
- `src/engine/pipeline/runner.ts`, `proofreader.ts`: a proofreader refused by the client-only guard keeps the translator's text and flags the chunk (`proofreader <ref> refused: ...`) instead of failing it; a refused QA joins its reason to an existing one. `prepareChunks` resolves the translator with `exact` for client-only projects.
- `src/engine/service.ts`: the estimate resolves each agent's model with `exact` for client-only projects (no shared fallback rows).
- `src/engine/cli.ts`: `engine status` prints `chunk N flagged: <reason>`.
- `src/engine/models/registry.ts`: an alias that starts with `client/` (or any alias of a non-client provider named `client`) is skipped with a warning (`registry.warnings`, also `console.warn`).
- `src/engine/formats/epub.ts`: `dc:description` is block `m.2` (para, next to the title in section `s0`) and is written back on export; `dc:subject` is untouched.
- `README.md`: refused proofreader, `engine status`, reserved alias.
- Tests: `clientOnly` x3 (refused proofreader, allowed `client/antigravity` reviewer, estimate exact), `registry` x1, `epub` x1, `pipeline` repair assertion now counts review calls (a non-JSON reply gets exactly one repair round, others none).

### Verification
`yarn vitest run`: 25 files, 373 tests pass. `yarn typecheck` and `yarn lint`: clean. The estimate test fails with the service.ts change reverted.

### Polish round 1: `client` id hole in the $0 guard
- `src/engine/models/registry.ts`: `load` skips (warning in `registry.warnings` and `console.warn`) a provider with id `client` whose kind is not `client`, and any `client` provider after the first real one. So a hand-edited `id: client, kind: openai-compat` can no longer make `client/<model>` pass `isClientRef`. The old `p.id === 'client' && p.kind !== 'client'` alias condition was dead after this and is removed.
- `src/engine/serve.ts`: `registry.warnings` are logged to the engine log at start, next to the data-folder warnings.
- `README.md`: the guard line mentions the skipped provider.
- Test: `registry.test.ts` x1 (fake `client` before the real one and a duplicate after it: both skipped with a warning, `client/x` does not resolve, `client/claude-code` stays kind client). It fails with the registry change reverted.
- `yarn vitest run`: 25 files, 374 tests pass; `yarn typecheck`, `yarn lint` clean.
