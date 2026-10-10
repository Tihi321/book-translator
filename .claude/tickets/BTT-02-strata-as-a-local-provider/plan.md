# BTT-02: Strata as a local provider

**Ticket folder:** `.claude/tickets/BTT-02-strata-as-a-local-provider/` (`changelog.md` goes here at the end). **Branch:** `BTT-02_strata-provider` (from `origin/master` f9ea1c6).

## Context

Scriptorium got Strata support in SCP-03 (commit `8f54f93`, merged as `662055f`). Strata is the user's local Qwen3.8-Flash-Next server at `http://127.0.0.1:8080/v1` (started by the user with `D:\Strata\run-iq3_s.bat`, 128K context, no key, thinking on by default). The user wants the same support in book-translator.

Facts carried over from SCP-03 (verified there, and Strata is running now: `/health` reports `loaded: true`, `max_context` 131072):
- Strata ignores the `model` field, so made-up model ids work and stay stable across quants.
- Thinking defaults to `high`. `extra_body: { reasoning_effort: none | low }` turns it down. Thinking text streams as `reasoning_content`, which `openaiCompat.ts` already ignores (it only reads `delta.content`).
- `response_format` is enforced by prompt-then-check. A bad answer returns **502 `structured_output_failed`**. In this repo the router (`src/engine/models/router.ts:157-163`) treats 5xx as retryable: it retries, then moves to the next model (paid DeepSeek). `chatJson`'s "retry without schema" path (`src/engine/pipeline/llm.ts:71-76`) only runs after the whole chain fails, so it would not save us. So Strata gets **no `response_format`**, and `chatJson`'s parse-and-repair path handles JSON (glossary and QA are the `chatJson` callers).

**User decision (2026-10-10):** Strata first in every agent's default list, DeepSeek after it (QA keeps Gemini last).

## Changes

### 1. `json_schema` provider field (port of SCP-03 §1, same code)
- `src/shared/schemas.ts:42` (`providerEntrySchema`): add `json_schema: z.boolean().default(true)` with the SCP-03 doc comment.
- `src/engine/models/registry.ts`: `jsonSchema: boolean` on `ProviderInfo` (with doc comment), set from `p.json_schema` in `load()` (~line 101), passed to `new OpenAiCompatClient({...})` in `setupClient()` (~line 157).
- `src/engine/models/openaiCompat.ts`: `jsonSchema?: boolean` on `OpenAiCompatOptions`; in `chat()` only set `response_format` when `req.schema && this.opts.jsonSchema !== false`.

### 2. Provider entry in `seed/config/providers.md`
After `lmstudio`:
```yaml
  - id: strata
    kind: openai-compat
    local: true
    base_url: http://127.0.0.1:8080/v1
    api_key_env: STRATA_API_KEY   # optional; only sent if set
    concurrency: 1
    discover: false               # Strata answers any model name; fixed ids keep defaults.json stable across quants
    json_schema: false
    models:
      - id: qwen3.8-flash-next
        family: qwen
        context: 131072
        extra_body: { reasoning_effort: none }
      - id: qwen3.8-flash-next-low
        family: qwen
        context: 131072
        extra_body: { reasoning_effort: low }
```
`api_key_env` on a `local` provider is safe: `setupClient` only marks a provider unavailable for a missing key when it is not local.

Body text:
- `json_schema` added to "Fields of a provider", with the reason.
- `concurrency` note mentions Strata (one request at a time, like LM Studio).
- New "## Strata" section: start with `D:\Strata\run-iq3_s.bat`, check `curl http://127.0.0.1:8080/health` for `loaded: true`; one model per process, all quants on port 8080; `context` must match `--max-context`; the model takes 1–3 minutes to load; IQ3_S needs ~84 GB so it can't run next to the big LM Studio models; why `json_schema: false`. Note that the disabled `custom` entry also points at port 8080, so don't enable both.

### 3. Defaults in `seed/config/defaults.json`
```json
"glossary":    ["strata/qwen3.8-flash-next", "deepseek/deepseek-v4-flash"],
"translator":  ["strata/qwen3.8-flash-next", "deepseek/deepseek-v4-flash"],
"proofreader": ["strata/qwen3.8-flash-next", "deepseek/deepseek-v4-flash"],
"qa":          ["strata/qwen3.8-flash-next-low", "deepseek/deepseek-v4-flash", "gemini/gemini-2.5-flash"]
```
Translator, glossary and proofreader run without thinking (fast, no wasted tokens); QA uses `low` for steadier verdicts, like Scriptorium's checks.

**Live data folder:** `initDataFolder` never overwrites. `%USERPROFILE%\BookTranslator` doesn't exist and `BOOK_TRANSLATOR_DATA` is unset (checked during planning); re-check at implementation and, if one exists, add the same entries to its `config/providers.md` and `config/defaults.json` and tell the user.

### 4. UI text
Book-translator has no provider label/colour maps (the model picker groups by `Local - <provider id>`), so only hint text changes:
- `src/renderer/ui/NewProject.tsx:186` and `:213`: "Start LM Studio" → "Start LM Studio or Strata".
- `src/renderer/ui/Settings.tsx:147`: mention Strata alongside LM Studio.

### 5. Tests
- `tests/registry.test.ts`, seed-config test (line 16 list): add `'strata'`; assert `providers.get('strata')` matches `{ available: true, local: true, jsonSchema: false }`, `contextLength('strata/qwen3.8-flash-next')` is 131072, and the model's `extraBody` is `{ reasoning_effort: 'none' }`. Check that the "ECONNREFUSED discovery" test (line 54) is unaffected (Strata has `discover: false`).
- Fake-server client test (wherever `OpenAiCompatClient` is tested against a fake server; likely `tests/llm.test.ts` or `tests/router.test.ts`, find with grep): port the SCP-03 test — default sends `response_format`, `jsonSchema: false` omits it, `reasoning_content` deltas are not emitted as text. Reuse that file's existing fake-server helpers.
- A seed-defaults assertion (e.g. in `tests/dispatcher.test.ts` near the `getDefaults` test at line 150, or registry test): `agentModels.translator[0]` is `strata/qwen3.8-flash-next`. Check that `tests/dispatcher.test.ts:154` and other tests using the defaults still pass.

### 6. Docs
- `README.md`: intro line lists Strata among local servers; new "## Strata notes" section next to "LM Studio notes" (how to start, health check, defaults use it first and fall back to DeepSeek, keep only small models in LM Studio while Strata runs); update the CLI example if useful.
- Ticket folder `plan.md` + `changelog.md` (format as in SCP-03's changelog).

## Verification
1. `npm run typecheck`, `npm run lint`, `npm test`: all clean.
2. Live (Strata is running now): with a throwaway data folder under `.claude/temp/bt-data`:
   - `npm run engine -- models --data .claude/temp/bt-data`: lists `strata/qwen3.8-flash-next` and `-low` as available, local, 131k context.
   - Translate a short TXT/MD file (a few paragraphs, written to `.claude/temp/`) with the seed defaults: `npm run engine -- translate <file> --to hr --data .claude/temp/bt-data --out .claude/temp/out.md`. Glossary and QA exercise the no-`response_format` JSON path. Check the output, that `status <projectId>` shows 0 USD spend (no fallback to DeepSeek) and no QA/glossary JSON errors.
3. Not covered live: stopping Strata to watch fallback to DeepSeek (the router fallback already has unit tests in `tests/router.test.ts`).

## Implementation status

- [x] 1. `json_schema` provider field: `src/shared/schemas.ts`, `src/engine/models/registry.ts` (`ProviderInfo.jsonSchema`, passed to the client), `src/engine/models/openaiCompat.ts` (`jsonSchema` option).
- [x] 2. `strata` entry, `json_schema` field doc, concurrency note and "## Strata" section in `seed/config/providers.md`.
- [x] 3. Defaults in `seed/config/defaults.json` (Strata first, DeepSeek next, QA keeps Gemini last). `%USERPROFILE%\BookTranslator` does not exist and `BOOK_TRANSLATOR_DATA` is unset, so no live data folder to update.
- [x] 4. UI hint text in `NewProject.tsx` (two places) and `Settings.tsx`.
- [x] 5. Tests: `tests/registry.test.ts` (strata provider, context, extraBody), new `tests/openaiCompat.test.ts` (fetchImpl SSE stub: response_format by default, omitted with `jsonSchema: false`, `reasoning_content` not emitted), `tests/dispatcher.test.ts` (`translator[0]` is Strata).
- [x] 6. `README.md` (intro, "Strata notes", CLI example). `changelog.md` is written by the orchestrator.

### Deviations
- The client test is in a new file `tests/openaiCompat.test.ts` (no existing test built `OpenAiCompatClient` directly).
- `json_schema` doc text in providers.md and the README CLI example were added beyond the minimum; no scope change.

### Verification
- `npm run typecheck`: clean. `npm run lint`: clean. `npm test`: 17 files, 119 tests passed (after fixing one strict-null TS error in the new dispatcher assertion).
- Live (Strata `/health` loaded: true, DEEPSEEK_API_KEY unset): `models --data .claude/temp/bt-data` lists `strata/qwen3.8-flash-next` and `-low` as available, local, ctx 131072, free.
- `translate .claude/temp/sample.md --to hr` finished: status done (1 chunk done, 0 flagged, 0 failed), spend $0.0000, 4225/2662 tokens. Glossary built 4 terms in 1 pass; translator, proofreader and QA ran. No JSON or repair errors in the log. The chunk's model is `strata/qwen3.8-flash-next`; DeepSeek was unavailable (no key) and not used. `status sample-hr-b3686c` shows 0 USD.
- Not run live: stopping Strata to watch the DeepSeek fallback (covered by `tests/router.test.ts`).
- Orchestrator review: the hint text in `NewProject.tsx` and `Settings.tsx` was reworded so the "load with 32k context" advice applies only to LM Studio, and the README CLI line no longer points at a temp data folder. After that, typecheck, lint and `npm test` (119 tests) were rerun and all clean.
