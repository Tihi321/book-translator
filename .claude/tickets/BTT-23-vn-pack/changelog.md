# BTT-23 changelog — VN pack adapter

## 2026-10-25 — Book Translator translates only the VN text catalog

Branch `BTT-23_vn-pack` (from `master`), uncommitted. Cross-repo plan/contract: `C:\projects\Personal\creative-hub\.claude\tickets\HUB-16-vn-pack\`.

### What changed

- **New `src/engine/formats/vnPack.ts`** (format `vnp`): detects a folder with `vn/pack.json` + `vn/text/<sourceLang>.json` before the legacy `vn`; validates format/version/lang/`packHash` (canonical JSON), catalog key sets, aliases, values; builds the IR from catalog values only, one block per catalog path (`title`, `chapter.N.title`, `choice.N.I`, `ending.N`, `scene.chNN.sNN`, `char.key`/`char.key#N`, `beat.<beatId>`, `puzzle.<key>.name.<id>`/`.text.<id>`); spoken lines carry `<1>Name (expression):</1>` context, dropped on write; engine-side v2 note; deterministic QA (key parity, one line, non-empty, no structural label/IDs, inline tags, pack hash); export writes `edition.json`, a byte-identical `vn/pack.json`, `vn/text/<lang>.json` and `catalog.json`.
- **`src/engine/formats/index.ts`**: `vnp` registration/detection; `hashSource` covers pack + source catalog only; `formatNote` returns the v2 brief.
- **`src/shared/ir.ts`**: `DocFormat` gains `vnp`; `meta.sourceHash` carries the pack hash.
- **Service/CLI/MCP**: export report adds `{path, catalog, lang, keys, warnings}`; project/preview format, instructions and README updated; `vno`-facing docs mention catalogs, not folder alignment.
- **Legacy safety** in `src/engine/formats/vn.ts`: kept prefix/suffix marker bytes must be identical after translation; CLUE/EVIDENCE prose translated with IDs kept; PUZZLE/END TESTIMONY kept; TESTIMONY witness localised.
- **`src/engine/pipeline/{env,runner,qa,names}.ts`**: format is passed to deterministic checks; catalog `char.*` values are exempt from the untranslated heuristic; keep rows/names behave as before.
- **Renderer**: minimal format conditions so a `vnp` project is treated like a folder project (no reader/cover expectations).
- **Docs** README “Visual-novel book folders” (v2), MCP instructions, CLI usage.
- **Tests** `tests/vnPack.test.ts` (27) with canonical fixtures `tests/fixtures/vn-pack/{soother,choice,mystery-puzzle}`; v1 `tests/vn.test.ts` unchanged and green.

### Verification

- `vitest run` → 25 files / 360 tests passed.
- `tsc --noEmit` node + web; `eslint .` — clean.
- Live: `analyze_file` on `~/Scriptorium/books/the-soother-that-fell-into-dragon-land` → `format: vnp`, 425 blocks, 14 chunks, estimate; `create_project` + `prepare_chunks` + `get_translation_task` shows only catalog values (`title`, `blurb`) with the v2 note.

### Deviations

- A v2 project cannot be upgraded in place (the source hash includes the template); a changed pack starts a new project. This is intentional.
- The live full translation was not run (LM Studio/Strata down); the tests cover the full mock pipeline, and the live task view proves the segment shape.
- The legacy `vn` adapter now checks marker bytes; v1 outputs that were already correct are unchanged.

### Follow-ups

- A full live Croatian translation of a real pack through the adapter (client or a local model).
- Commit/PR after the user’s play.
