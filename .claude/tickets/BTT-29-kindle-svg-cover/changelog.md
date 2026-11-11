# BTT-29 changelog

## 2026-11-11 BTT-29 (REQ-0008): EPUB `cover: title` writes a text title page, never an SVG cover; three hr books re-exported

### book-translator, branch `BTT-29_kindle-svg-cover` (from master `e4926c8`)

- `src/engine/formats/epub.ts`: `write()` no longer adds `translated-cover.svg`, an `image/svg+xml` `cover-image` item or an image-only `translated-cover.xhtml`. With `cover: 'title'`: a page showing the declared raster cover gets a text body (`h1` title, `p.author`; `epub:type="cover"` set, namespaced, only when the body has none), `cover-image` is dropped from the cover items and every `<meta name="cover">` is removed (image files stay); if the first linear spine page is already a text cover or title page (`epub:type` token `cover`/`titlepage` on `<body>` or a direct child), nothing is added; otherwise `translated-title.xhtml` (id `translated-title-page`, text only, `epub:type="titlepage"`) becomes the first itemref. `cover: 'source'`/undefined unchanged. Helpers `titleBodyHtml`, `setTitleBody`, `isTextCoverPage`; unused `relativeTo` removed.
- `src/engine/publish/cover.ts`: `titleCoverSvg` and `wrap` deleted (no other caller); `coverAltText` kept.
- `tests/epub.test.ts`: reproduction test added; the two SVG `cover title` tests rewritten (text title page on a raster-cover source; text title page first for a source without a cover). Default-cover test untouched.
- `src/engine/mcp/server.ts`, `src/engine/cli.ts`, `src/engine/index.ts`, `src/shared/ir.ts`, `src/shared/protocol.ts`, `README.md`: the option is described as "a plain text title page, never an image"; README adds that EPUB covers are never SVG because Kindle turns such a book into fixed layout.
- `ROADMAP.md`: BTT-29 entry (done when merged); BTT-18 notes the SVG lasted until BTT-29.

### Data (`C:/Users/Infplane/BookTranslator/projects`)

- Re-exported `the-tide-table-hr-fc6ee3`, `what-fate-decides-luck-will-and-the-life-hr-54a317`, `the-one-way-street-why-time-only-runs-hr-30e47a` (CLI, default cover). Old files kept as `output/<slug>.hr.pre-req0008.epub`. One line appended to each `log.md`.

### Deviations

- Orchestrator review correction: the rewritten cover body's `epub:type` is set with `setAttributeNS` (OPS namespace) so the serializer declares `xmlns:epub` when the source page lacks it; a plain `setAttribute` produced an undeclared prefix (checked with xmldom).
- The title body replaces the page after its own translation pass (order not specified by the plan).
- `log.md` lines were appended because the engine's `exported N block(s)` event does not reach `log.md` on the CLI route.

### Verification

- Reproduction test failed on the unchanged writer (`AssertionError ... not to match /image\/svg\+xml"[^>]*cover-image|.../`; OPF had `translated-cover` and `translated-cover-page` first), passes after.
- `yarn.cmd test`: 25 files, 387 tests passed. `yarn.cmd typecheck`: exit 0. `yarn.cmd lint`: exit 0. Control-character check on the diff: 0.
- Per book: source sha256 equals `project.json` `sourceHash`; epubcheck 5.2.1 0 fatal / 1 error (OPF-096 nav, pre-existing) / 0 warnings; `verify_reexport.py` PASS 11/11; all zip entries except the OPF byte-equal to the backup.
- Not run: Kindle reflow (A7, user check after Send to Kindle); Kindle Previewer / Calibre (not installed).

### Follow-ups

- Raster title cover (new native dependency or Scriptorium `coverPng`): not planned.

### Commit status

Committed on `BTT-29_kindle-svg-cover` (`9bc4e7b` plus the ticket-files commit). Not merged, not pushed.
