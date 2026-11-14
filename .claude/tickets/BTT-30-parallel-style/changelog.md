# BTT-30 changelog

- New `src/engine/pipeline/typography.ts`: defaults table, `effectiveTypography`, `typographyRule`, `dialogueStyleOf`, `typographyCheck`.
- `src/shared/project.ts`: `Typography`, `DialogueStyle`, `TypographyCheck`, `ProjectSettings.typography`. `protocol.ts`: `ProjectDetail.typography`.
- `store.mergeSettings` merges `typography` field by field; MCP `create_project` / `update_project_settings` take `typography`.
- `briefWithNote` takes the typography rule (runner and `translationTask` pass it); the glossary stage writes the language default when empty.
- `translatorUserContent` takes `{ rule, previousMissing }`; `translationTask` says when the previous chunk is not translated yet.
- Check shown in `get_project`, `wait_for_progress`, `engine status`.
- Checked read-only against `the-rooster-hr-1c4fee`: 27 chunks detected as dash, consistent; with chunks 1-17 rewritten to „…” in memory it reports the mix.
- Not done: a field in the project settings tab (UI).
