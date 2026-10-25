# BTT-23 — Book Translator v2 adapter for language-independent VN packs

Branch `BTT-23_vn-pack` (from `master`). Hub plan: `C:\projects\Personal\creative-hub\.claude\tickets\HUB-16-vn-pack\plan.md`; authoritative contract: `...\HUB-16-vn-pack\contract.md` (read the updated revision: optional `expressions`, `sourceHash` without `book.md`, optional `line.aliasKey`).

## Scope checklist

- [x] `src/engine/formats/vnPack.ts` (new): format `vnp`, canonical JSON `packHash`, detection by `vn/pack.json` + `vn/text/<sourceLang>.json`, validation, IR, bundle export, deterministic QA helpers, v2 brief note.
- [x] `DocFormat` gets `vnp` (`src/shared/ir.ts`); detection runs **before** the legacy `isVnFolder` path in `src/engine/formats/index.ts`; `hashSource` covers `vn/pack.json` + the source catalog only; `formatNote` returns the v2 note.
- [x] IR sections `Book`, `Characters`, `Chapters` (one per chapter), `Puzzles`; block IDs are the catalog paths exactly (`title`, `blurb`, `chapter.<n>.title`, `choice.<n>.<i>`, `ending.<n>`, `scene.<ch.s>`, `char.<key>`/`char.<key>#<n>`, `beat.<beatId>`, `puzzle.<key>.name.<id>`, `puzzle.<key>.text.<id>`).
- [x] Line-beat blocks carry `<1>Name (expression):</1>` (name from `characterNames[aliasKey ?? speakerKey]`); the tag is dropped on write; keys/structure never enter a value.
- [x] Engine-side v2 note in the brief (no new prompt files), plain and `localizeNames` variants.
- [x] Deterministic QA: exact key parity (hard error), non-empty/single-line, no structural label at start, no beat/scene id, no placeholder tags, inline tags, untranslated/ratio (glossary keep rows); pack hash unchanged; QA model stays optional.
- [x] Export: `<out>/<slug>.<lang>/edition.json` + byte-identical `vn/pack.json` + `vn/text/<lang>.json` + bare `catalog.json`; deterministic; metadata preserved; report `path`/`catalog`/`lang`/`keys`/`warnings`.
- [x] `localizeNames` for v2: the glossary gives forms for the catalog's names; keep rows by default; no tag/bible rewriting; v1 unchanged.
- [x] Legacy safety in `formats/vn.ts`: re-classification compares kept prefix **and** suffix marker bytes; `CLUE`/`EVIDENCE` translate prose with ids kept, `PUZZLE`/`END TESTIMONY` kept whole, `TESTIMONY` witness handled as a name and localized with `localizeNames`; correct v1 output unchanged (tests/vn.test.ts untouched and green).
- [x] Docs: README "Visual-novel book folders" + v2 section, MCP server instructions + tool descriptions, CLI usage/export output. Small UI notes/conditions for the new format.
- [x] Tests: `tests/vnPack.test.ts` on the canonical fixtures (detection/hash/project id, IR + speaker tags + no structure, export bundle byte-identity/key parity/determinism, rejections, mock pipeline, MCP analyze/create/export, aliasKey, v1 puzzle-line + marker-byte safety).
- [x] Canonical fixtures from `creative-hub/.claude/temp/hub16-fixtures/{soother,choice,mystery-puzzle}` copied under `tests/fixtures/vn-pack/`; the hand-written minimal fixture was removed once they existed.

## Acceptance

- `yarn test`, `yarn typecheck`, `yarn lint` pass.
- Existing `tests/vn.test.ts` cases pass unchanged (v1 regression).
- Template `vn/pack.json` is byte-identical after a full translation/export; catalog key set equals the source key set (all three canonical fixtures and the mock pipeline).
- Key-set violations, empty/multi-line values, structural labels and ids are hard errors.
- No UI strings, keys or asset IDs enter catalog values.

## Deviations

Recorded in `notes.md` ("Design decisions" + "Deviations").
