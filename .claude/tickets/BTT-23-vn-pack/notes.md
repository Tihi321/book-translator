# BTT-23 notes

## Read first (done)

- `~/.claude/agents/implementer.md` — role and rules.
- Hub `plan.md` and `contract.md` for HUB-16 / BTT-23 (contract is authoritative; updated revision read after the lead's message: optional `expressions`, `sourceHash` without `book.md`, optional `line.aliasKey`). No contract change requested.
- Ticket scope message from the lead (`task-2`).

## Repo state

- `C:\projects\Personal\book-translator`, branch `BTT-23_vn-pack`, clean at start (`3eab9dc`, merge of BTT-21). No branch/commit/PR operations made.
- Ticket folder `.claude/tickets/BTT-23-vn-pack/` created with `plan.md` and this file (the Lead writes the changelog).

## Design decisions

- The adapter re-reads `vn/pack.json` + the source catalog on write (`srcPath` is the pack folder), so no mutable module state is needed and `source.json` stays self-contained.
- `DocumentIR.meta.sourceHash` carries the pack's `packHash`; the writer refuses when it differs from the pack on disk ("pack changed, start a new project"). The contract's `book.sourceHash` (authored files) is not computed or compared here — Book Translator never reads the authored files, and the lead's clarification says not to hash the whole folder.
- Project id: `hashSource` = SHA-256 over `vn/pack.json` then the source catalog (`rel + "\0" + bytes + "\0"`, same shape as `hashVnFolder`), so the id changes with the pack and never with other editions or the authored files.
- Bundle layout: `<out>/<slug>.<lang>/{edition.json, vn/pack.json, vn/text/<lang>.json, catalog.json}`; `catalog.json` is the bare catalog for `vno_add_edition`. `export_project` returns `path/catalog/lang/keys/warnings` (the old `export` result keeps `path`/`rel`).
- Catalog values of line beats strip the `<1>…</1>` context (and a leading `Name (expression):` when the tags were lost) on write; the rest of the value is the catalog text. A missing translation keeps the source value with a warning (partial export).
- Deterministic QA runs in `deterministicChecks` when the project format is `vnp` (empty/multi-line/structural label/beat id/placeholder tags) and the same checks are hard errors at export. Name blocks (`char.*`) are left out of the "untranslated" check (names are kept by default; glossary keep rows cover names in the text too). The QA model stays optional.
- Legacy puzzle lines: `CLUE`/`EVIDENCE` keep their label + ids and translate prose; `PUZZLE` and `END TESTIMONY` (Croatian `ZAGONETKA`, `KRAJ SVJEDOČENJA`) are kept whole; `TESTIMONY` treats the witness as a name (`SVJEDOČENJE` too) and `localizeNames` writes the localized witness. The legacy render guard now compares the kept prefix **and** suffix bytes after re-classifying the rendered line.
- `line.aliasKey` (contract update) is read on line beats: the tag uses `characterNames[aliasKey]`, catalog keys are unchanged, and an alias that the pack does not define is rejected.
- Canonical fixtures (`soother`, `choice`, `mystery-puzzle`) were copied from `creative-hub/.claude/temp/hub16-fixtures/` to `tests/fixtures/vn-pack/` (with a provenance `README.md`); the hand-written `lighthouse` fixture was removed. Tests derive expectations from the pack + catalog rather than hardcoding one fixture's prose.

## Deviations / additions

- Added optional `DocumentIR.meta.sourceHash` (shared IR) to detect a pack change at export.
- Added optional `AgentEnv.format` and an optional `format` argument to `deterministicChecks` (vnp-only QA rules).
- Extended the `export` protocol result with optional `catalog`, `lang`, `keys`, `warnings`; `EngineService.exportWithReport` added while `export` keeps its string result.
- UI touched minimally (format checks for the note, the `localizeNames` checkbox and the reader buttons) beyond the docs scope, so a pack project is not shown as a plain document.
- MCP: no new tools; the server instructions and the existing `analyze_file` / `create_project` / `export_project` / `localizeNames` descriptions mention packs.
- `Puzzles`/`Characters` IR sections are emitted only when they have blocks (a pack without puzzles has no empty section).
- The bundle's bare catalog is `catalog.json` inside the bundle folder (the contract only requires the `vn/text/<lang>.json` inside the bundle; a catalog file alone is a valid `vno_add_edition` source).

## Cross-repo checks

- The three Scriptorium-generated packs in `C:\projects\Personal\scriptorium\tests\fixtures\vn-pack\` were read and exported ad hoc before the hub copy; each kept `vn/pack.json` byte-identical (same result as the copied canonical fixtures now in the tests).
- The canonical fixtures' `packHash` validates with this repo's canonical-JSON helper (same algorithm as SCP-45).

## Verification

- `yarn test` — 25 files, 360 tests passed (includes 27 in `tests/vnPack.test.ts`; `tests/vn.test.ts` unchanged).
- `yarn typecheck` — exit 0 (`tsconfig.node.json` + `tsconfig.web.json`).
- `yarn lint` — exit 0.
- Fixture paths: `tests/fixtures/vn-pack/{soother,choice,mystery-puzzle}/` plus `tests/fixtures/vn-pack/README.md` (provenance), and the existing `tests/fixtures/books/soother` for the v1 regression.
- Temporary files only under `.claude/temp/` (fixture generator, smoke/scan scripts, outputs).
