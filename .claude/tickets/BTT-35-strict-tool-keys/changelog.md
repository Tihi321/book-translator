# BTT-35 changelog

Branch `BTT-35_strict-tool-keys`, cut from master, not merged.

- `src/engine/mcp/server.ts`: the shared `tool(...)` helper registers `z.looseObject(shape)` (the SDK strips unknown keys from a plain shape) and refuses any key outside the shape with an `isError` result: `<tool>: unknown argument "<key>"; valid: <keys>`. Tools without arguments still accept an empty or missing object.
- `tests/mcp.test.ts`: the existing "failing tool ... checks the arguments" test also calls `wait_for_progress` with `timeoutMs` and checks the message. On master's src it fails (the key was stripped).
- README MCP section: one sentence. ROADMAP.md: BTT-35 row.
- Callers checked, none sent a key a tool lacks: the two prompts in server.ts, README examples, tests/client.test.ts, tests/mcp.test.ts, tests/vnPack.test.ts.
