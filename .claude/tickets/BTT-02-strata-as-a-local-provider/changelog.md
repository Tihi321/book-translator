# BTT-02 changelog

## 2026-10-10: Strata as a local provider

Strata is now a provider. It is a local Qwen3.8-Flash-Next server with an OpenAI-compatible API at `127.0.0.1:8080/v1`, ported from Scriptorium SCP-03. Every agent defaults to Strata first, then DeepSeek.

### Repository `book-translator`, branch `BTT-02_strata-provider` (from `origin/master` f9ea1c6)

- `src/shared/schemas.ts`: new provider field `json_schema` (boolean, default `true`).
- `src/engine/models/registry.ts`: `ProviderInfo.jsonSchema` is read from the config and passed to `OpenAiCompatClient`.
- `src/engine/models/openaiCompat.ts`: new `jsonSchema` option. When it is `false`, `chat()` doesn't send `response_format`. Strata answers a failed structured output with a 502, which the router would retry and then pass to paid DeepSeek. With the option off, `chatJson`'s parse-and-repair step handles the JSON instead.
- `seed/config/providers.md`:
  - `strata` entry after `lmstudio`: local, concurrency 1, `discover: false`, `json_schema: false`, optional `STRATA_API_KEY`.
  - Two model ids, both with 131072 context: `qwen3.8-flash-next` (`reasoning_effort: none`) and `qwen3.8-flash-next-low` (`low`).
  - Docs for the `json_schema` field, a concurrency note, and a "Strata" section on starting it, memory, context, thinking, why `json_schema` is off, and the port 8080 clash with `custom`.
- `seed/config/defaults.json`: glossary, translator and proofreader start with `strata/qwen3.8-flash-next`, then DeepSeek. QA starts with `strata/qwen3.8-flash-next-low`, then DeepSeek, then Gemini.
- `src/renderer/ui/NewProject.tsx`, `src/renderer/ui/Settings.tsx`: the hint text mentions Strata.
- `README.md`: Strata in the intro, a "Strata notes" section, and a line on the default models under the CLI example.
- Tests:
  - `tests/registry.test.ts`: the seed has an available, local `strata` provider with `jsonSchema: false`, context 131072, and `extraBody` on both models.
  - `tests/dispatcher.test.ts`: the default translator starts with Strata.
  - `tests/openaiCompat.test.ts` (new): `response_format` is sent by default and left out with `jsonSchema: false`, and `reasoning_content` isn't emitted as text.

### Deviations

- The client test is in a new file, because no existing test built `OpenAiCompatClient` directly.
- Book-translator has no provider label or colour maps (Scriptorium has them), so only the hint text changed in the UI.
- No live data folder exists (`%USERPROFILE%\BookTranslator` is missing and `BOOK_TRANSLATOR_DATA` is unset), so only `seed/` changed. An existing data folder would need the entries added by hand.

### Verification

- **Passed:**
  - `npm run typecheck`: clean.
  - `npm run lint`: clean.
  - `npm test`: 17 files, 119 tests passed.
- **Live check** (Strata IQ3_S running, DEEPSEEK_API_KEY unset):
  - `models` lists both Strata models as available, local, 131k context, free.
  - `translate` of a short English Markdown sample to Croatian finished: 1 chunk done, 0 flagged, 0 failed, 0 USD (4225 tokens in, 2662 out).
  - Glossary (4 terms), translator, proofreader and QA all ran on Strata, with no JSON or repair errors.
  - Output quality was good, apart from one wrong month form.
- **Not run:**
  - Stopping Strata to watch fallback to DeepSeek. The router fallback is covered by `tests/router.test.ts`.
  - A full book run.
  - The Electron UI was not launched.

### Commit status

Uncommitted.
