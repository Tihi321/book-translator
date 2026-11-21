---
status: done
request: creative-hub/REQ-0030
repos: [book-translator]
branch: BTT-36_acp-for-all
updated: 2026-11-21
---

# BTT-36 ACP for all: local models through the ACP proxy; Strata and LM Studio switched off

Part of creative-hub HUB-38 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-38-acp-for-all\plan.md`). The user's decision: every app reaches every LLM, local ones included, through the ACP proxy (provider `acp`, `http://127.0.0.1:8787/v1`), which serves `gufo/*`, `strata/*`, `llama/*`. The `strata` and `lmstudio` providers stay in the code, switched off in config ("disable, keep code").

Code and seed only. The user's data (`~\BookTranslator`: providers.md, defaults.json, 9 projects whose `settings.agentModels` name `strata/qwen3.8-flash-next`) is changed by the hub (HUB-38 L3) after approval. Do not edit `~\BookTranslator`.

## Contracts (copied from HUB-38; keep identical)

LOCAL = `acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs`. Defaults never name `gufo/*` or `llama/*`.

C1, the `acp` provider in `seed/config/providers.md` (today disabled in the seed, `:137`; becomes enabled), cloud rows unchanged, local rows appended:

```yaml
  - id: acp
    name: ACP proxy
    kind: openai-compat
    enabled: true
    local: true
    base_url: http://127.0.0.1:8787/v1
    concurrency: 4
    json_schema: false
    discover: true
    discover_skip: [ qwen-image, nomic-embed ]   # only if the providers schema has discover_skip; else drop the key
    models:
      # ... existing cloud rows unchanged ...
      # Local models through the proxy (HUB-38). One local model is loaded at a time across gufo, strata and llama;
      # a request for another one waits until the proxy has switched (minutes). LOCAL is the strata row.
      - id: strata/qwen3.8-flash-next-unsloth-ud-iq4_xs
        family: qwen
        context: 131072
        extra_body: { reasoning_effort: none }
      - id: gufo/Qwen3.8-27B
        family: qwen
        context: 32768
        extra_body: { reasoning_effort: none }
      - id: gufo/deepseek4
        family: deepseek
        context: 16384
        extra_body: { reasoning_effort: none }
      - id: gufo/flash-next-q4
        family: qwen
        context: 32768
        vision: true
        extra_body: { reasoning_effort: none }
      - id: llama/inkling-2-mini
        family: inkling
        context: 32768
        vision: true
      - id: llama/inkling-2-mini-dspark
        family: inkling
        context: 32768
        vision: true
```

If the model schema rejects `vision` or `extra_body`, drop that key and note it in the changelog.

## Scope

1. `seed/config/providers.md`: acp = C1; `strata` row `enabled: false` (kept); `lmstudio` row `enabled: false` (kept); `custom` unchanged. Prose: Strata runs under the proxy, the direct provider is a way back, one local model at a time, a switch takes minutes; README:70-style "start Strata yourself" text becomes "start the ACP proxy (`hub.ps1 start acp-proxy`)".
2. `seed/config/defaults.json`: every `strata/default` and `strata/default-low` in `agentModels` becomes LOCAL (glossary, translator, proofreader, qa keep their order); `groupDefaults` `strata` entry: read how `groupDefaults` and `groupOf` (`src/engine/models/registry.ts:145-156,751-756`) and `src/engine/config.ts:29` use the key. `acp` is `local: true`, so `groupOf('acp/...')` is `acp`: rename the key to `acp` with value LOCAL if the UI and `config.ts` accept any provider id as a group; if they hard-code `strata`, keep the key the code expects and say so in the changelog (the hub copies that decision into the live file). `fallbacks` (if present in the seed) and the code default `src/shared/schemas.ts:138` become `['deepseek/deepseek-flash', LOCAL]`.
3. Seed migrations (`src/engine/store/migrate.ts`): confirm none re-enables `strata`/`lmstudio` or rewrites agentModels back to `strata/default` in an existing folder (they record themselves as done). The 7461 to 8787 migration (`:328-348`) stays.
4. Docs: `README.md:3,47,61,67-73,95-97` (LM Studio and Strata notes): local models through the ACP proxy; Strata/LM Studio providers off and kept. UI strings in `src/renderer/ui/ModelsDialog.tsx`, `ModelSelect.tsx`, `Settings.tsx`, `NewProject.tsx` only where they would now mislead (for example a hint to start Strata).
5. `ROADMAP.md` row.

## Out of scope

Removing provider code/UI/tests; the user's data folder; embeddings (none used); vision (none used); tools.

## Files

`seed/config/providers.md`, `seed/config/defaults.json`, `src/shared/schemas.ts`, `src/engine/config.ts` (read), `src/engine/models/registry.ts` (read; change only if the group key needs it), `src/engine/store/migrate.ts` (read), `README.md`, the renderer files above (wording), `ROADMAP.md`. Tests: `tests/registry.test.ts`, `tests/router.test.ts`, `tests/dataFolder.test.ts` (update assertions that name the old seed defaults).

## Acceptance and tests

- A1 A fresh data folder from the seed has acp enabled at 8787 with the six local rows, `strata` and `lmstudio` disabled, and every agent list resolves to LOCAL or DeepSeek. Check: update the existing seed/data-folder test assertions (`tests/dataFolder.test.ts`) instead of adding a test.
- A2 `yarn test`, `yarn typecheck`, `yarn build:engine` pass (fnm default alias dir on PATH).
- Live (hub HUB-38 check C6; GPU: Strata through the proxy; the user's go-ahead): one throwaway project, one short paragraph, all agents LOCAL: the chunk finishes and the job log names `acp/strata/...`.

## ROADMAP row

`- **BTT-36 (branch \`BTT-36_acp-for-all\`; creative-hub HUB-38, REQ-0030): local models through the ACP proxy.** Seed acp on at 8787 with the gufo/strata/llama rows (Inkling listed, not default), agent defaults LOCAL = \`acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs\` or DeepSeek, \`strata\` and \`lmstudio\` providers off (code kept). Live check UNTESTED.`
