# Changelog

## 2026-11-22 BTT-37: three leftovers of BTT-36

Branch `BTT-37_extra-ideas` (book-translator), from master.

- `seed/config/providers.md`: Strata scripts dir is `D:\Strata\terminal`.
- `src/shared/schemas.ts`: the `defaultsSchema` doc comment moved back above `defaultsSchema`.
- `tests/dispatcher.test.ts`: re-seeded fallback test compares with the two literal refs; unused `DEFAULT_FALLBACKS` import removed.
- `ROADMAP.md`: BTT-37 bullet above BTT-36.

Deviations: none. Verification: `yarn test` (27 files, 399 tests), `yarn typecheck`, `yarn lint`, `yarn build:engine` all pass; `ls D:/Strata/terminal/run-*.bat` lists the four scripts. Not run: nothing (no runtime change).
Commit: committed on the branch, not merged, not pushed.
