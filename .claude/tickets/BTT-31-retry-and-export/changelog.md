# BTT-31 changelog

Bug 5 (commit "a segment mismatch moves the chunk to the next model before the split"):
- `pipeline/env.ts`: `CallRequest.skipModels`, `AgentEnv.models`.
- `models/router.ts`: `RoutedRequest.lead` / `skip`, applied in `chat` after `resolve` (a provider error on the led model still falls back as before).
- `pipeline/runner.ts`: `ownRefs`, `ownModels` (exact resolve, no shared fallback rows), `makeEnv` sets `models`, `makeCall` leads with the next own model when `skipModels` is set.
- `pipeline/translator.ts`: `ask` returns `{ parse, model }`; `attempt` rotates (`MISMATCHES_PER_MODEL = 2`) and splits only after every own model failed; the `retry-tags` call skips the failed models.
- Test: `tests/pipeline.test.ts` "moves to the next model after two mismatches, and splits only when every model failed" (shared fallback row `mock-fallback` is never asked).

Bug 6 (commit "export refuses with untranslated blocks unless allowPartial, and warns"):
- New `src/engine/untranslated.ts`: `untranslatedReport`, `formatRefusal`, `formatNothingTranslated`, `formatWarning`.
- `service.ts`: `ExportRefused`, guard before `mkdir` (every format, packs included), warning through `onWarning`, `translations(id, chunks?)`, `export` / `exportWithReport` take `allowPartial`.
- `shared/protocol.ts`: `EXPORT_REFUSED`, `export` command `allowPartial`, `warnings?` doc. `dispatcher.ts` passes it. MCP `export_project`: `allowPartial`, description, INSTRUCTIONS.
- CLI: `engine export --allow-partial`; the end of `engine translate` passes `allowPartial: true`. Usage strings and README updated.
- UI (`ProjectView.tsx`): `exportFor(action, allowPartial)`, refusal row with "Export anyway" / "Cancel", warnings as toasts.
- Tests: `pipeline.test.ts` (failed-chunk test, pause then partial export), `vnPack.test.ts` (pack-changed export passes `allowPartial`), new `mcp.test.ts` case.

Checks: `yarn test` 392 passed, typecheck (node and web) and lint clean.
UNTESTED: CLI `--allow-partial` and the `translate` ending, the UI refusal row and toasts, a run on a real book (the app was in use).
