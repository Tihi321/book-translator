# Changelog: BTT-08 visual-novel script adapter

## 2026-10-20: BTT-08, Scriptorium visual-novel book folders

Book Translator translates a Scriptorium visual-novel book folder as one project and exports a folder with the same layout and the same script lines, so VN Studio can add it as an edition (`vno_add_edition`). Not committed.

### Repo `book-translator`, branch `BTT-08_vn-script-adapter` (from `master` f30c4f1)

- `src/engine/formats/vn.ts` (new): the folder adapter (read, write, `isVnFolder`, `vnFiles`, `hashVnFolder`, `bibleNames`, `classifyScriptLine`, `yamlScalar`, `VN_BRIEF_NOTE`).
- `src/engine/formats/index.ts`: `formatOf` / `adapterFor` pick the folder adapter for a book folder and refuse other folders; new `hashSource`, `formatNote`, `briefWithNote`.
- `src/shared/ir.ts`: `DocFormat` gets `vn`; `meta.names`; `WriteOptions.onWarning`.
- `src/engine/service.ts`: `createProject` hashes folders and seeds the glossary with `meta.names`; `translationTask` sends the brief with the format note; `export` names a folder `<folder>.<lang>` and logs adapter warnings.
- `src/engine/pipeline/runner.ts`: every agent gets the brief with the format note.
- `src/engine/dispatcher.ts`: folders are read without the mtime cache.
- `src/engine/mcp/server.ts`: instructions and `analyze_file` / `create_project` / `export_project` descriptions mention book folders.
- `src/engine/index.ts`: usage line.
- `src/renderer/ui/ProjectView.tsx`: no Read original / Read translation for `vn` projects.
- `tests/vn.test.ts` (new, 8 tests), `tests/mcp.test.ts` (+1 test), `tests/fixtures/books/soother/` (copied from visual-novels-orchestrator).
- `README.md`: "Visual-novel book folders" section, formats, CLI, tests.

### Verification

- `yarn test`: 21 files, 232 tests pass. `yarn typecheck` and `yarn lint` exit 0.
- Mock run: `node out/engine/index.js translate <soother> --to hr --model mock/mock-translator --data <tmp> --out <tmp>/soother.hr` with `BOOK_TRANSLATOR_MOCK=1`: 12/12 chunks done, 444 blocks exported. A check with Scriptorium's SCENE/CAST/LINE regexes: all 7 chapters have the same line count and every line the same kind (974 lines, 403 translated).
- VN Studio's `alignEdition` (run offline from its repo with tsx) and the live `vno_add_edition` (hub, on a temporary project that was deleted afterwards): 381/381 beats matched, 0 missing, 0 extra, no warnings.
- Live hub engine restarted on the new build: `analyze_file` with the soother folder returns format `vn`, 444 blocks, 12 chunks.
- Not run: a translation with a real model (no Croatian quality check of the speaker-tag prompt); the Electron window (the New project screen still picks files only).
