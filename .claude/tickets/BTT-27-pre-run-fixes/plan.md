---
status: in-progress
request: REQ-0006
repos: [book-translator]
branch: BTT-27_pre-run-fixes
updated: 2026-11-09
---

# BTT-27 Pre-run fixes (from the REQ-0006 plan, task A1)

Input: BTT-26 `discoveries.md`, master `d4129fa`. User answered Q2 = yes: `dc:description` is translated; `dc:subject` stays as-is.

## Done when
- A refused proofreader leaves the chunk `flagged` with reason `proofreader <ref> refused: ...` (test).
- Estimate and prepareChunks on a client-only project resolve exactly the project's models (test).
- `engine status` lists flagged reasons.
- An alias `client/...` in providers.md is refused with a warning (test).
- The repair assertion in the pipeline test can fail.
- One allowed-client-reviewer test.
- README line fixed.
- An EPUB round trip translates `dc:description` (test).

## Files
`src/engine/pipeline/runner.ts`, `proofreader.ts`, `src/engine/service.ts`, `src/engine/cli.ts`, `src/engine/models/registry.ts`, `src/engine/formats/epub.ts`, `README.md`, `tests/{pipeline,clientOnly,registry,epub}.test.ts`.
