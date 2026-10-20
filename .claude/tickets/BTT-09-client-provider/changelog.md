# BTT-09 changelog

## 2026-10-20: client provider (Claude Code does every agent's work)

Branch `BTT-09_client-provider`, from origin/master 4364b0d. Uncommitted.

**What changed**
- **New provider kind `client`** (`src/engine/models/client.ts`, new). It follows the same contract as Scriptorium SCP-08, with `project` in place of book and agent.
  - A model request waits in the service's `ClientTaskQueue` until an MCP client answers it.
  - On submit, the answer is checked against the request's schema (glossary, QA).
  - Leases last 30 minutes. Pause or cancel drops the task. It costs nothing and has no timeout.
- **Wiring:**
  - `shared/schemas.ts`, `models/types.ts`.
  - `models/registry.ts`: `setClientQueue`, because the registry is built before the service.
  - `service.ts` owns the queue.
  - `pipeline/runner.ts` sets the job id to `<project>--<unit>--<task>`.
- **MCP** (`mcp/server.ts`, `dispatcher.ts`, `shared/protocol.ts`):
  - New tools: `list_client_tasks`, `get_client_task` (with output hints for seg text, JSON and plain text), `submit_client_task`, `release_client_task`.
  - `wait_for_progress` returns at once when a task of the project is waiting. It polls every 500 ms.
  - `get_project` gains `clientTasks`.
  - New prompt `translate_with_full_pipeline`, and a third mode in INSTRUCTIONS.
- **CLI:** `translate` exits 2 when an agent's model is a client model, because nothing would answer it.
- **Docs:**
  - README: the client provider section, with the YAML to add by hand to existing data folders and the per-project `agentModels`.
  - README: the wrong claim that QA and the proofreader "can still run later" after manual translation is fixed.
  - `seed/config/providers.md`: a disabled `client` entry.
- **Tests:**
  - `tests/client.test.ts` (new): queue, registry/router, abort, a whole project with every agent on client, an MCP round trip, the CLI refusal, and schema defaults.
  - `tests/mcp.test.ts`: the tool and prompt lists.

**Deviations**
- The registry gets the queue after it is built (`setClientQueue`).
- `wait_for_progress` polls the queue, because a new task emits no event.
- A missing unit or task in the job id defaults to `run` or `call`.

**Verification** (Node 24, fnm)
- `yarn test`: 22 files, 241 passed.
- `yarn typecheck`: ok.
- `yarn lint`: ok.
- Not run: a live run against the hub's Book Translator. That needs `hub.ps1 build book-translator`, a restart, and a Claude session that has `BOOK_TRANSLATOR_MCP_TOKEN`, since this session got a 401.

**Follow-ups**
- Live run: a small text with every agent on `client/claude-code`. Then commit and PR.
- Add the `client` provider to `~/BookTranslator/config/providers.md`.
