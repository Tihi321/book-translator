---
status: done
request: REQ-0008
repos: [book-translator]
branch: BTT-29_kindle-svg-cover
updated: 2026-11-11
---

# REQ-0008 / BTT-29 Kindle shows the Croatian EPUBs as fixed layout (SVG title cover)

Ticket number: the highest folder in `C:/projects/Personal/book-translator/.claude/tickets` is `BTT-28-post-run-fixes`, so this is **BTT-29**. Ticket folder in book-translator: `.claude/tickets/BTT-29-kindle-svg-cover/` (copy this plan there when implementing). Branch `BTT-29_kindle-svg-cover` from `master` (`e4926c8`, clean).

Input: `research.md` in this folder. Confirmed by the user: the hr Tide Table with only `translated-cover.svg` and `translated-cover.xhtml` (manifest items and first itemref) removed reflows on their Kindle. So the cause is the SVG cover, not the language or anything else.

## Decision

Book Translator's EPUB writer never emits an SVG as `cover-image` and never inserts an image-only XHTML page. `cover: 'title'` stays as an option, default stays `source`, but its meaning changes from "replace the cover by a generated SVG image" to "make the first page a reflowable text title page with the translated title":

| Source has | `cover: 'source'` (default) | `cover: 'title'` (new) |
|---|---|---|
| A raster cover image (`cover-image` or `<meta name="cover">`) and a page showing it | unchanged: keep the image, translate its alt text | the page that shows the cover image gets a text title body (`h1` title, `p` author); the `cover-image` property and `<meta name="cover">` are removed; the image file stays in the zip and manifest, unreferenced |
| A text cover or title page already (first linear spine item whose `<body>`, or a direct child of it, has `epub:type` with the token `cover` or `titlepage`), e.g. every Scriptorium book | unchanged | no-op: that page is already translated text |
| Neither | unchanged | add `translated-title.xhtml` (manifest id `translated-title-page`, first `itemref`): `h1` title, `p` author, no `img`, no `svg`, `epub:type="titlepage"` |

Why:
- The confirmed trigger is the SVG `cover-image` plus the image-only first page. Scriptorium's own writer (`scriptorium/src/engine/publish/epub.ts:122-127,214`) already does exactly the right thing (PNG `cover-image` only when a PNG exists, else a text title page), and its English EPUBs reflow.
- No rasteriser is a dependency (`package.json`: jszip, @xmldom/xmldom, pdfjs-dist, epubjs, no sharp/canvas/resvg). The engine runs headless in Node, so Electron's renderer can not be used either. A raster title cover would need a new native dependency; not planned (see Open questions).
- Keeping `cover: 'title'` (not removing or making it a no-op) keeps the three entry points and the REQ-0006 run instructions (`export_project {cover: "title"}`) valid, and still solves BTT-18 (the English title drawn on a raster source cover) for commercial EPUBs.
- Default stays `source`: for Scriptorium books `source` and `title` now give the same result, and for raster-cover books `source` keeps the real cover art.

Callers that pass `cover` (all keep their signature; only descriptions change): CLI `src/engine/cli.ts:193,197` (`--cover title`), `src/engine/index.ts:14` (usage text), dispatcher `src/engine/dispatcher.ts:732`, MCP `export_project` `src/engine/mcp/server.ts:271`, service `src/engine/service.ts:504,512,546`, types `src/shared/ir.ts:65-66`, `src/shared/protocol.ts:327-328`. The UI has no cover control. The three hr books were exported through MCP with `cover: "title"` (REQ-0006 `plan.md:97`, `run-log.md:51`).

## Scope

1. Fix the EPUB writer as in the Decision table, with the tests below.
2. Update the option's descriptions (MCP tool, CLI usage, README, ROADMAP, type comments).
3. Re-export the three affected hr books with the fixed build, keep the old files, verify each.

A scan of every `*/output/*.epub` under `C:/Users/Infplane/BookTranslator/projects/` found `translated-cover.svg` only in these three: `the-tide-table-hr-fc6ee3`, `what-fate-decides-luck-will-and-the-life-hr-54a317`, `the-one-way-street-why-time-only-runs-hr-30e47a`. The other hr books need nothing.

## Out of scope

- A raster (PNG/JPEG) generated title cover, and any new dependency.
- Scriptorium changes (it already writes Kindle-safe EPUBs; giving books a `coverPng` is a separate decision).
- Covers drawn with `<svg><image xlink:href>` (Calibre-style `titlepage.xhtml`): the current code does not detect them either; leave as is.
- The pre-existing epubcheck error OPF-096 (`nav` itemref `linear="no"` not reachable); it is in the English source too.
- Deleting the old copies from the user's Kindle library or Amazon cloud, and re-sending (the user does that).
- Kindle Previewer / Calibre conversion checks (not installed; the user's Kindle is the final check).

## Files and modules to touch (book-translator)

- `src/engine/formats/epub.ts`, `write()` from the `// the cover:` comment (~line 376) to the end of the `if (opts.cover === 'title')` block (~line 446): remove the SVG path (`newCover.svg`, `titleCoverSvg` call, the `image/svg+xml` manifest item, the `translated-cover.xhtml` page and its itemref); add the text title page logic. A small helper `titleBodyHtml(title, author)` returning `<div class="titlepage" style="text-align:center"><h1>…</h1><p class="author">…</p></div>` (escaped with `escapeXml`) is enough; reuse `xhtmlPage` for the new page and keep stripping its `<link>` (no stylesheet path is known in a foreign source).
- `src/engine/publish/cover.ts`: delete `titleCoverSvg` and `wrap` (no other caller; check with grep). Keep `coverAltText`.
- `tests/epub.test.ts`, `describe('epub cover')` (lines ~157-220): rewrite the two `cover title` tests, add the reproduction test (see below). No new test file.
- `src/engine/mcp/server.ts:271` (`cover` describe text), `src/engine/cli.ts:193`, `src/engine/index.ts:14`, `src/shared/ir.ts:65`, `src/shared/protocol.ts:327`: wording "replaces it by a plain text title page (translated title and author); never an image".
- `README.md:21,84`: same wording, plus one line: "EPUB covers are never SVG: Kindle's converter turns a book with an SVG cover into a fixed-layout book."
- `ROADMAP.md`: add a BTT-29 entry under BTT-18's area (done when merged).

## Tasks

### Task 1: writer fix (book-translator, branch BTT-29_kindle-svg-cover)

Input: `write(ir, translations, sourcePath, outPath, { targetLanguage, cover })`.

Output contract for any `cover` value, any source:
- The OPF has no manifest item with `media-type="image/svg+xml"` and `properties` containing `cover-image` unless the source already had exactly that (the writer never adds one).
- The writer adds no spine page whose body is only an image (`img` or `svg`).
- The zip gets no `translated-cover.svg` or `translated-cover.xhtml`.

`cover: 'title'`:
- Source cover image present: for each XHTML that has an `img` whose resolved `src` is a declared cover path (the existing `coverPaths` match), replace that document's `<body>` children with the title body (translated title from `newTitle`, falling back to the OPF `dc:title`; author from the first `dc:creator`). Keep the body's `epub:type`, set it to `cover` when absent. Remove `cover-image` from those manifest items' `properties` (existing loop) and remove every `<meta name="cover">` element. Image files stay.
- No cover image, but the first linear spine item is a text cover/title page (`epub:type` token `cover` or `titlepage` on `<body>` or one of its direct children): change nothing beyond the normal translation.
- Neither: add `translated-title.xhtml` next to the OPF, manifest item `id="translated-title-page"` `media-type="application/xhtml+xml"`, inserted as the first `itemref`. Page made by `xhtmlPage(title, titleBodyHtml(...), { lang, epubType: 'titlepage' })` with the `<link>` stripped.
- `cover: 'source'` / undefined: byte-for-byte the current behaviour (alt text translated, nothing added).

Verification: `fnm exec --using default yarn.cmd test`, `yarn.cmd typecheck`, `yarn.cmd lint` in `C:/projects/Personal/book-translator` (all from Bash via `fnm exec --using default ...`). Then the implement skill's review and commit flow (one commit `BTT-29: ...`, merge to master per the repo's usual `Merge BTT-29_...` pattern only when the user approves).

**Task 1 results (DONE, committed 9bc4e7b; Scope items 1 and 2):**
- Reproduction test run first against the unchanged writer: `tests/epub.test.ts` > `epub cover` > `cover title on a book that has a text cover page adds no image cover (Kindle reflow)` failed with `AssertionError: expected '<?xml ...' not to match /image\/svg\+xml"[^>]*cover-image|cover-image[^>]*image\/svg\+xml/` (OPF contained `translated-cover` `image/svg+xml` `cover-image` and `translated-cover-page` first in the spine). After the fix: 13/13 in the file pass.
- Full suite 387 passed (25 files); `yarn.cmd typecheck` and `yarn.cmd lint` clean (lint first flagged an unused `relativeTo`, removed).
- Tests: +1 (reproduction), the two SVG `cover title` tests rewritten (A2, A3), default-cover test untouched. The translation map key `m.1` needed no change.
- Deviations: none from the Decision table. The title body is applied after the page's own translation pass so block ids stay those of the source. `titleCoverSvg`/`wrap` deleted (grep: only epub.ts used them); the `escapeXml` import in cover.ts went with them.

### Task 2: re-export the three hr books (data only, after Task 1 is merged or at least built from the branch)

Projects (data folder `C:/Users/Infplane/BookTranslator`):

| Project id | Output file |
|---|---|
| `the-tide-table-hr-fc6ee3` | `output/the-tide-table.hr.epub` |
| `what-fate-decides-luck-will-and-the-life-hr-54a317` | `output/what-fate-decides-luck-will-and-the-life.hr.epub` |
| `the-one-way-street-why-time-only-runs-hr-30e47a` | `output/the-one-way-street-why-time-only-runs.hr.epub` |

Steps per project:
1. Source check: compute sha256 of the project's `sourcePath` (from `project.json`) and compare with `project.json` `sourceHash`. The export reads the source EPUB again, so if Scriptorium republished it, block ids may not match and text would fall back to English. On a mismatch, stop for that book and report (do not export).
2. Copy `output/<slug>.hr.epub` to `output/<slug>.hr.pre-req0008.epub` (same folder). Do not overwrite an existing `.pre-req0008` copy.
3. Export with the fixed build, default cover (no `--cover`): `fnm exec --using default yarn.cmd engine export <projectId> --data C:/Users/Infplane/BookTranslator` from `C:/projects/Personal/book-translator`. It writes to the default `output/<slug>.hr.epub`. Alternative if the app or a headless engine already holds the folder: `export_project { projectId }` over its MCP server (`yarn headless --data C:/Users/Infplane/BookTranslator`; port and token from the data folder settings, README "MCP"), then `shutdown`. Before the CLI route, check that `C:/Users/Infplane/BookTranslator/engine.lock` does not exist (no app or headless engine on the folder; it is absent now); use one route, not both.
4. Verify:
   - epubcheck: `java -jar C:/projects/Personal/scriptorium/.claude/temp/req0008/tools/epubcheck-5.2.1/epubcheck.jar <file>`; pass = no errors other than the one `OPF-096` for the nav itemref, no fatal.
   - Script (Python `py -I`, script kept in `C:/projects/Personal/scriptorium/.claude/temp/req0008/`): unzip, parse the OPF, assert: no manifest item with `image/svg+xml` and `cover-image`; no zip entry `translated-cover.svg` / `translated-cover.xhtml`; first spine itemref is `cover` (the source's text cover page); the manifest ids and the spine order equal those of the English source at `sourcePath`; `dc:language` is `hr`; the cover page's `h1` text equals the `.pre-req0008` file's title text (translation kept).
   - Text check: the chapter XHTML files equal those in the `.pre-req0008` copy (byte compare after unzip). Only the OPF and the two removed files should differ. Any other difference means the translations moved; stop and report.
5. Append a line to the project's `log.md` only if the engine does not do it already (it logs `exported N block(s)`).

Output: three fixed EPUBs at the original paths, three `.pre-req0008.epub` backups, a short results table (file, epubcheck result, script result) in this ticket's `handoff.md`. The user then deletes the old copies on Kindle and sends the new files.

**Task 2 results (DONE 2026-11-11):** all three source hashes matched; backups made; exported via CLI from the branch build (default cover); epubcheck 0 fatal / only OPF-096 for each; `verify_reexport.py` PASS 11/11 for each; every zip entry except the OPF byte-equal to the backup, only `translated-cover.svg`/`.xhtml` removed. Table in `C:/projects/Personal/scriptorium/.claude/tickets/REQ-0008-kindle-fixed-layout/handoff.md`. A7 (Kindle reflow) UNTESTED.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | `cover: 'title'` on a Scriptorium-shaped source (text `cover.xhtml` with `body epub:type="cover"` first in the spine, no cover image) adds no SVG, no `cover-image`, no spine item | reproduction test (below), fails on `master` |
| A2 | `cover: 'title'` on a source with a raster cover: the cover page shows the translated title as text, no `img`; no `cover-image` left; no `image/svg+xml` item | rewritten test `cover title: a text title page replaces the source cover image` (was the SVG assertion at `tests/epub.test.ts:197`) |
| A3 | `cover: 'title'` on a source with no cover at all: first spine item is `translated-title.xhtml` with an `h1` title and no `img`/`svg`; the book still reads back (`adapter.read(out)` has sections) | rewritten test at `tests/epub.test.ts:209` |
| A4 | Default export unchanged | existing test `translates the alt text of the cover and keeps the source image by default` (kept as is) |
| A5 | The three hr EPUBs have no SVG cover, the same spine as their English source, unchanged chapter files, and epubcheck shows only OPF-096 | Task 2 step 4 script and epubcheck output, recorded in `handoff.md` |
| A6 | Old files kept | the three `*.hr.pre-req0008.epub` exist next to the new ones |
| A7 | Reflows on the user's Kindle | user check after Send to Kindle (UNTESTED until they report) |

Suite, typecheck and lint pass. Net test count: +1 (the reproduction test); the two SVG tests are rewritten, not duplicated.

## Reproduction test

In `tests/epub.test.ts`, `describe('epub cover')`:

```ts
it('cover title on a book that has a text cover page adds no image cover (Kindle reflow)', async () => {
  const { src, out } = await setup()
  const zip = await JSZip.loadAsync(await fs.readFile(src))
  const opf = (await zip.file('OEBPS/content.opf')!.async('string'))
    .replace('</manifest>', '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/></manifest>')
    .replace('<spine toc="ncx">', '<spine toc="ncx"><itemref idref="cover"/>')
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/cover.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>The Test Book</title></head><body epub:type="cover"><div class="titlepage"><h1>The Test Book</h1></div></body></html>')
  await fs.writeFile(src, await zip.generateAsync({ type: 'uint8array' }))
  const adapter = adapterFor(src)
  const ir = await adapter.read(src)
  await adapter.write(ir, new Map([['m.1', 'Probna knjiga']]), src, out, { targetLanguage: 'hr', cover: 'title' })
  const res = await JSZip.loadAsync(await fs.readFile(out))
  const resOpf = await res.file('OEBPS/content.opf')!.async('string')
  expect(resOpf).not.toMatch(/image\/svg\+xml"[^>]*cover-image|cover-image[^>]*image\/svg\+xml/)
  expect(resOpf).toContain('<spine toc="ncx"><itemref idref="cover"/>')
  expect(Object.keys(res.files).filter((n) => /translated-/.test(n))).toEqual([])
})
```

On `master` this fails: the OPF gets `translated-cover` `image/svg+xml` `cover-image` and `<itemref idref="translated-cover-page"/>` first (exactly the hr books' shape). The block id `m.1` and the ids of the cover page's own heading may shift because a new XHTML is read; the implementer adjusts the translation map key if needed (assert on structure, not text).

## Open questions for the user

1. A raster title cover (a real cover thumbnail in the Kindle library instead of the first text page) would need a new native dependency (e.g. `@resvg/resvg-js`, free, ~5 MB prebuilt binary) or Scriptorium producing `coverPng` for each book. Not planned here. Want either later?
2. Task 2 overwrites `output/*.hr.epub` in place (backups kept as `*.hr.pre-req0008.epub`). The Kindle copies you already sent stay bad until you delete them from the Kindle library and send the new files; Amazon may keep the old one if title and author match. OK?
