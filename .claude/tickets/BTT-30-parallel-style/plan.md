---
status: done
branch: BTT-30_parallel-style
---

# BTT-30 Style drift between chunks translated in parallel

Found by the hub's The Rooster Croatian run: four clients translated ranges of one client-only project; chunks 1-17 got „…” dialogue, 18-34 en-dash dialogue, every check passed.

## Plan

1. `ProjectSettings.typography { dialogue: dash | quotes | guillemets, quotes?, notes? }` (settable with `create_project` / `update_project_settings`, merged field by field). `src/engine/pipeline/typography.ts` holds the per-language default table (hr, sr, bs, pl, ru, es: dash; en, de, cs: quotes; others none), `effectiveTypography` (own setting over the default) and the rule text. `briefWithNote` appends the rule to the brief, so translator, proofreader, QA and fix prompts all carry it. The glossary stage writes the default into the settings when `dialogue` is empty.
2. `typographyCheck(chunks, settings)`: per done/flagged chunk, count paragraphs that start with a dash or an opening quotation mark / guillemet; fewer than 2 = no style; the commonest style needs twice the next one, else `mixed`. Flags more than one style across the project, or a style other than the brief's. Shown in `ProjectDetail.typography` (`get_project`), `wait_for_progress` (only when inconsistent) and `engine status`. Never changes a chunk's state.
3. `translationTask`: previous chunk translated -> "Previous passage" plus the rule; previous chunk of the same section not translated -> "Previous passage: None: chunk N is not translated yet ..." plus the rule.

## Tests
`glossary.test.ts` (style detection, defaults, rule), `dispatcher.test.ts` (task note, rule in system prompt, drift flagged, no chunk failed), `pipeline.test.ts` (glossary stage writes the default).
