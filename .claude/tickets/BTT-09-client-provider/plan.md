# BTT-09: Client provider (Claude Code answers the app's model calls)

Ticket folder: `.claude/tickets/BTT-09-client-provider/`
Branch: `BTT-09_client-provider` (created from `master` at 4364b0d)

## Context

`get_translation_task` / `submit_translation` cover only the translator's first pass. The glossary builder, proofreader, QA review/recheck and QA fix always needed a real model, and README:105 wrongly said they could run later. BTT-09 adds a provider kind `client`: its `chat()` parks the request in an in-memory queue on the engine until an MCP client submits the answer. Shared contract with Scriptorium SCP-08 and VN Studio VNO-05; plan: `creative-hub/.claude/tickets/external-llm-jobs/plan.md` (BTT-09 section). `queue/client.ts` follows SCP-08's `client.ts` (book/agent replaced by project, no images).

## Progress checklist
- [x] 1. `src/engine/models/client.ts` (`ClientTaskQueue`, `ClientProvider`, `checkAgainstSchema`, `clientTaskResult`); kind `client` in `shared/schemas.ts` (+ model `vision`); wired in `registry.setupClient` (forced `local: true`, no key); `RequestMeta.job`, set in `ProjectRunner.makeCall` as `<project>--<unit>--<task>`.
- [x] 2. `EngineService` owns one queue (`clientQueue`) and hands it to the registry (`setClientQueue`); the registry makes its own when built without a service (CLI, tests).
- [x] 3. MCP tools `list_client_tasks`, `get_client_task`, `submit_client_task`, `release_client_task` (+ `Command` union, reply map, `dispatcher.handle`).
- [x] 4. `wait_for_progress` returns at once when a task of the project waits, always with `clientTasks`; `get_project` has `clientTasks`.
- [x] 5. CLI `translate` refuses (exit 2) when an agent model is on a `client` provider.
- [x] 6. `agentModels` over MCP: `update_project_settings` with `client/claude-code` works (tested).
- [x] 7. Manual path (`prepare_chunks` ... `translate_book_yourself`) untouched.
- [x] 8. Docs: README (providers, MCP, line-105 fix, entry to add by hand to existing data folders, per-project use), `seed/config/providers.md` (disabled `client` entry + docs), INSTRUCTIONS, prompt `translate_with_full_pipeline`.
- [x] 9. Tests: `tests/client.test.ts` (queue, router/registry, abort, whole project with all agents on client incl. glossary/proofread/QA, MCP round trip, wait_for_progress, CLI refusal); `tests/mcp.test.ts` tool and prompt lists.
- [x] 10. Checks: `yarn test` 22 files / 240 tests passed (baseline 21 / 232); `yarn typecheck` and `yarn lint` exit 0 with no output.
- [ ] 11. Live: orchestrator, not done here.

## Decisions

- No ajv: a built-in light schema check (type, enum, const, required, properties, items, anyOf/oneOf, minItems, minLength), as in SCP-08.
- The registry is built before the service in `serve.ts`/`cli.ts`, so the queue is created by the service and pushed into the registry (`setClientQueue`), which also updates providers already built.
- Job id is `<project>--<unit>--<task>` (`run`/`call` when unit/task is missing).
- `wait_for_progress` polls the queue every 500 ms while waiting, since a new task emits no event.
- A per-project pin is just `agentModels` in that project's settings; documented in the README.
- Tests use temp data folders only; the running engine and `out/` were not touched.
