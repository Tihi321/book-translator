# BTT-25 Strata docs: drop the removed IQ3_S launchers

Branch: `BTT-25_strata-iq3s-removal` (from `master`). Docs only; no code change (the app discovers the served model).

## Scope

The IQ3_S, IQ2_XS and coder IQ1_M models and their launchers were removed from `D:\Strata`. The launchers that remain: `run-unsloth-ud-iq4_xs-parallel.bat` (Qwen3.8-Flash-Next IQ4_XS, four at once, hub variant `iq4_xs-parallel`), `run-unsloth-ud-iq4_xs.bat` (one at a time), `run-deepseek-v4.1-flash-ist-das-2.00bpw.bat` and `run-deepseek-v4.1-flash-ista-das-coder.bat`.

## Files

- `seed/config/providers.md`: Strata launcher list, the `matches ...` comment on the `qwen3.8-flash-next` profile, "131072 for all four now" where it said six.
- Repo-specific: README.md (book-translator), CLAUDE.md and a dated line in docs/design.md (scriptorium).
- `ROADMAP.md`: one row.
- Left alone: tests (`qwen3.8-flash-next-iq3_s` is a sample id), earlier tickets, old design.md entries.

## Done

- [x] Docs edited
- [x] `git grep -n -i -E 'run-iq3_s|IQ3_S'` shows only tests, ticket history and the design.md log
