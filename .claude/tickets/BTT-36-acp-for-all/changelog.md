# Changelog BTT-36

## 2026-11-21 BTT-36: local models through the ACP proxy (seed and docs)

Branch `BTT-36_acp-for-all` (from master), uncommitted.

- `seed/config/providers.md`: `acp` enabled, concurrency 4, `discover_skip: [qwen-image, nomic-embed]`, six local rows (strata LOCAL, gufo x3, llama x2; `vision` and `extra_body` are accepted by the schema); `strata` and `lmstudio` `enabled: false` (kept); prose for the proxy, the way back, one model at a time.
- `seed/config/defaults.json`: every `strata/default*` is LOCAL = `acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs`; `fallbacks` = deepseek, LOCAL; `groupDefaults` key `strata` renamed `acp` (value LOCAL).
- `src/shared/schemas.ts`: code default of `fallbacks` = deepseek, LOCAL.
- `README.md`, `src/renderer/ui/NewProject.tsx`, `Settings.tsx`: wording (start the ACP proxy, not Strata). `ROADMAP.md`: BTT-36 row.
- Tests: `tests/helpers.ts` (`seededRegistry` switches strata/lmstudio back on unless `seedOnly`), seed assertions updated in `dataFolder`, `registry` (A1 test replaces the old acp-seed test), `dispatcher`.

Decision: `groupDefaults` accepts any provider id as key (free `z.record`, `registry.groupOf` returns the provider id for a local provider), so the key is `acp`.
Migrations: `migrateStrataLoaded` and `migrateAcpPort` do not touch `enabled` and never write `strata/default`; no change.

Verification: `yarn test` 399 passed; `yarn typecheck` clean; `yarn build:engine` ok. Not run: the app, the live check C6.

Polish 1: `src/shared/schemas.ts` exports `LOCAL_MODEL_REF` and `DEFAULT_FALLBACKS` (`deepseek/deepseek-flash`, LOCAL); the schema default, `dispatcher.ts` `seedFallbacks` and the two `registry.ts` last-resort fallbacks use it instead of the literal `strata/default`. `tests/dispatcher.test.ts`: the removeCustomProvider test now also asserts an emptied fallback list is re-seeded with `DEFAULT_FALLBACKS`. `README.md` line 72: direct-Strata bat path corrected to `D:\Strata	erminalun-unsloth-ud-iq4_xs-parallel.bat`. Migration paths untouched.
