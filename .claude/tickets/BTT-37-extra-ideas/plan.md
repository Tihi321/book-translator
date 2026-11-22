---
status: in-progress
request: creative-hub/REQ-0030
repos: [book-translator]
branch: BTT-37_extra-ideas
updated: 2026-11-22
---

# BTT-37 Three small leftovers of BTT-36: Strata script path, a misplaced doc comment, a test that compares a constant with itself

Part of creative-hub HUB-40 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-40-extra-ideas\plan.md`, ideas 6, 13, 14 of REQ-0030). Follow-up to BTT-36 (HUB-38). No behaviour change.

## Scope

1. Seed prose: the Strata scripts are in `D:\Strata\terminal`, not `D:\Strata` (checked on disk 2026-11-22: `D:\Strata\terminal\run-unsloth-ud-iq4_xs-parallel.bat`, `run-unsloth-ud-iq4_xs.bat`, `run-deepseek-v4.1-flash-ist-das-2.00bpw.bat`, `run-deepseek-v4.1-flash-ista-das-coder.bat`).
2. `src/shared/schemas.ts`: the doc comment of `defaultsSchema` back above `defaultsSchema`.
3. `tests/dispatcher.test.ts`: the re-seeded fallback list checked against the literal refs.
4. ROADMAP row.

## Out of scope

Anything else in the seed, the code, or the live data folder `C:\Users\Infplane\BookTranslator`.

## Files and modules to touch (verified on master, 2026-11-22)

- `seed/config/providers.md:269`: "chosen by the `run-*.bat` you start in `D:\Strata`:" becomes "chosen by the `run-*.bat` you start in `D:\Strata\terminal`:". Nothing else in the line changes.
- `src/shared/schemas.ts:129-135`. Today:
  ```ts
  /** config/defaults.json: default model per agent, default chunk size, languages for the pickers. */
  /** The local model: Strata behind the ACP proxy. */
  export const LOCAL_MODEL_REF = 'acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs'
  /** The fallback list a fresh or emptied config gets. */
  export const DEFAULT_FALLBACKS: readonly string[] = ['deepseek/deepseek-flash', LOCAL_MODEL_REF]

  export const defaultsSchema = z.looseObject({
  ```
  After: the first line (`/** config/defaults.json: ... */`) moves to the line directly above `export const defaultsSchema = z.looseObject({`. Nothing else changes.
- `tests/dispatcher.test.ts:961`: `expect(defaults.fallbacks).toEqual([...DEFAULT_FALLBACKS]) // an emptied fallback list is re-seeded with the local ACP model` becomes `expect(defaults.fallbacks).toEqual(['deepseek/deepseek-flash', 'acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs']) // an emptied fallback list is re-seeded with the local ACP model`. `DEFAULT_FALLBACKS` is then unused in that file (its only use): remove the import at line 8 (`import { DEFAULT_FALLBACKS } from '../src/shared/schemas'`), or lint fails.

## Tasks for workers

One task, all three edits plus the ROADMAP bullet. ROADMAP (`ROADMAP.md`, in the "Open" list directly above the BTT-36 bullet at line 7, same style):
`- **BTT-37 (branch `BTT-37_extra-ideas`; creative-hub HUB-40, REQ-0030): leftovers of BTT-36.** The seed names `D:\Strata\terminal` for the Strata scripts, the `defaultsSchema` doc comment sits on `defaultsSchema` again, and the re-seeded fallback test checks the literal refs. No behaviour change.`

## Acceptance criteria and the command that proves each

Commands (Bash): `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"; cd /c/projects/Personal/book-translator`, then `yarn test`, `yarn typecheck`, `yarn lint`, `yarn build:engine`.

| # | criterion | proof |
|---|---|---|
| A1 | The seed's Strata path exists on disk | `grep -n 'you start in' seed/config/providers.md` shows `D:\Strata\terminal`; `ls D:/Strata/terminal/run-*.bat` lists the four scripts |
| A2 | The doc comment is on `defaultsSchema` | `git diff src/shared/schemas.ts` moves exactly that line |
| A3 | The test fails if `DEFAULT_FALLBACKS` changes | `yarn test` passes; the assertion holds the two literal refs |
| A4 | Nothing else broke | `yarn test`, `yarn typecheck`, `yarn lint`, `yarn build:engine` pass |

## UNTESTED

Nothing beyond the commands above (no runtime change).
