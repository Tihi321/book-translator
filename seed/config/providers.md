---
kind: providers
providers:
  - id: deepseek
    kind: openai-compat
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    concurrency: 8
    models:
      - id: deepseek-v4-flash
        family: deepseek
        context: 1000000
        price_in: 0.14
        price_out: 0.28
        price_cached_in: 0.0028
        extra_body: null
      - id: deepseek-v4-pro
        family: deepseek
        context: 1000000
        price_in: 1.74
        price_out: 3.48
        price_cached_in: 0.0145
        extra_body: null
  - id: openai
    kind: openai-compat
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: gpt-5-mini
        family: gpt
        context: 400000
        price_in: 0.25
        price_out: 2
        price_cached_in: 0.025
      # to verify
      - id: gpt-5
        family: gpt
        context: 400000
        price_in: 1.25
        price_out: 10
        price_cached_in: 0.125
  - id: openrouter
    kind: openai-compat
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: google/gemini-2.5-flash
        family: gemini
        context: 1000000
        price_in: 0.30
        price_out: 2.50
  - id: anthropic
    kind: anthropic
    base_url: https://api.anthropic.com
    api_key_env: ANTHROPIC_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: claude-sonnet-4-5
        family: claude
        context: 200000
        max_output: 16000
        price_in: 3
        price_out: 15
        price_cached_in: 0.30
  - id: gemini
    kind: gemini
    base_url: https://generativelanguage.googleapis.com
    api_key_env: GEMINI_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: gemini-2.5-flash
        family: gemini
        context: 1000000
        price_in: 0.30
        price_out: 2.50
        price_cached_in: 0.03
  - id: lmstudio
    kind: openai-compat
    local: true
    base_url: http://localhost:1234/v1
    concurrency: 1
    discover: true
    models: []
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
  - id: ollama
    kind: openai-compat
    enabled: false
    local: true
    base_url: http://localhost:11434/v1
    concurrency: 1
    discover: true
    models: []
  # Any other OpenAI-compatible server (llama.cpp server, vLLM, text-generation-webui ...). Edit base_url, then enable it.
  - id: custom
    kind: openai-compat
    enabled: false
    local: true
    base_url: http://localhost:8080/v1
    concurrency: 1
    discover: true
    models: []
  - id: mock
    kind: mock
    concurrency: 4
    models:
      - id: mock-translator
        family: mock
      - id: mock-reviewer
        family: mock-other
---
# Providers

One entry per provider. The app reads this file when it starts and when you refresh the model list in the settings. API keys are never written here: `api_key_env` names an environment variable, and the app also looks in the Windows credential store under that name (`npm run key:set <NAME>`, or the settings screen).

Prices are examples. Verify them on each provider's pricing page. The DeepSeek numbers were checked 2026-10-08. The OpenAI, OpenRouter, Anthropic and Gemini entries are marked "to verify": model ids and prices there may be out of date. Cost estimates in the app come from these numbers.

## Fields of a provider

- `id`: the name used in model references. A model is written `provider/model`, for example `lmstudio/qwen2.5-14b-instruct`.
- `kind`: `openai-compat` (any OpenAI-style API), `anthropic`, `gemini` or `mock` (scripted, for tests).
- `enabled`: `false` switches the provider off. A provider whose key can't be found is skipped automatically.
- `local`: `true` for models on this machine. Local models cost nothing.
- `base_url`, `api_key_env`: where to call and which variable holds the key.
- `concurrency`: how many requests may run at once. LM Studio and Strata are 1 because all their requests share one GPU. This is also how many chapters are translated in parallel.
- `json_schema`: `false` stops the app from sending the JSON schema as `response_format`. Use it for servers that fail a bad JSON answer (HTTP 502) instead of constraining it. The app would retry that error and then fall back to the next model. With `false`, the prompt asks for JSON and the app's parse-and-repair step handles the answer. Default `true`.
- `rpm`: optional requests-per-minute limit.
- `discover`: ask the provider for its models (`GET /v1/models`) and add the ones not listed here. LM Studio, Ollama and a custom server are discovered. If the server is not running, discovery fails quietly and the list stays as written here.

## Fields of a model

- `id`, `family`, `context`, `max_output`.
- `price_in`, `price_out`, `price_cached_in`: USD per 1M tokens. Cached input falls back to `price_in` when missing.
- `embedding: true` marks an embedding model (never used for translation).
- `extra_body`: optional JSON fields merged into the request body, for example `{ reasoning_effort: none }` to switch thinking off on models that support it. Thinking models are slow and waste tokens on translation.

## Context size and local models

The app splits the book into chunks that fit the model's context window. For LM Studio it reads the window the model is loaded with. Otherwise it uses `context` from this file, and 8192 if that is missing. LM Studio loads models with a small window (often 4096 or 8192) unless you change it. Load the model you translate with 16384 tokens or more, for example `lms load <model> -c 16384 --parallel 1`, or set it in LM Studio's model settings. A larger window does not make chunks bigger than the chunk size you choose in the app (default 1500 tokens), because long chunks make models skip text.

## Strata

Strata is a local Qwen3.8-Flash-Next server on `http://127.0.0.1:8080/v1`. It needs no key. Set `STRATA_API_KEY` only if you put one in front of it.

- Start it with `D:\Strata\run-iq3_s.bat`. Check `curl http://127.0.0.1:8080/health`. It is ready when it shows `loaded: true`. Loading takes 1 to 3 minutes.
- One model runs per process, and all quants use port 8080. Strata ignores the `model` field, so the ids here are only names. That keeps `defaults.json` stable when you change quants.
- `context` must match Strata's `--max-context` (131072 now).
- The IQ3_S quant needs about 84 GB of memory. It can't run next to the big LM Studio models. Keep only small models loaded in LM Studio while Strata runs.
- Thinking is on by default in Strata and is slow. `qwen3.8-flash-next` sends `reasoning_effort: none`. `qwen3.8-flash-next-low` sends `low`, which gives steadier answers for checks.
- `json_schema: false`: when Strata can't produce valid JSON for a schema, it answers 502 `structured_output_failed`. The app would retry and then move to a paid model. Without the schema, the app's JSON repair step deals with a bad answer.
- The disabled `custom` entry also points at port 8080. Don't enable both.
