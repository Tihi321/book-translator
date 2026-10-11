# Changelog: BTT-04 built-in book reader

## 2026-10-11: BTT-04 reader for EPUB, PDF, TXT and Markdown (uncommitted)

The app now has a reader. Open it from the new top-bar **Reader** button, or from a project with **Read original** or **Read translation**.

### Repo: book-translator, branch `BTT-04_built-in-reader` (from `origin/master` @ f11428b)

**Main process and IPC**
- `src/main/index.ts`
  - New `host:pickBook` opens a native dialog filtered to books. The picked path is remembered so the reader may open it.
  - New `host:readBook` returns `{ name, ext, bytes }`. It only accepts a picked path, a path inside the data folder, or a project's source (looked up through the engine's `getProject`).
  - `readBook` rejects other extensions, non-files, and files over 300 MB.
  - The main window now blocks navigation (`will-navigate`) and new windows.
- `src/shared/protocol.ts`: new `BookTarget` and `BookFile` types, and `pickBook`/`readBook` on `BookTranslatorApi`.
- `src/preload/index.ts`: exposes the two calls.
- `tests/store.test.ts`: the fake API implements the new methods.

**Renderer**
- `src/renderer/index.html`: the CSP now allows blob: styles, fonts, frames and workers (needed by epub.js and the pdf.js worker). `script-src` stays `'self'`.
- New files in `src/renderer/ui/reader/`:
  - `Reader.tsx`: toolbar with Open file, Back to project, A−/A+ and light/sepia/dark.
  - `EpubViewer.tsx`: epubjs in paginated mode, prev/next buttons and ←/→ keys, a contents dropdown, theme and font size.
  - `PdfViewer.tsx`: pdf.js canvas pages rendered lazily with an IntersectionObserver, zoom and fit width, page jump.
  - `TextViewer.tsx`: TXT in pre-wrap; Markdown via `marked` and `DOMPurify`, with link clicks contained.
  - `position.ts`: the reading position per book, plus font and theme preferences, in localStorage (wrapped in try/catch).
- `src/renderer/store/store.ts`: new `reader` view and `ReaderSource` type.
- `src/renderer/App.tsx`: Reader button in the top bar; the reader remounts when its source changes.
- `src/renderer/ui/ProjectView.tsx`: Read original and Read translation buttons, hidden for DOCX projects. Read translation runs export first.
- `src/renderer/styles.css`: reader styles.
- `package.json` and `yarn.lock`: added `epubjs`, `marked`, `dompurify`.

### Deviations from the plan
- The path source is `{ path, projectId? }` so that Back to project works after Read translation.
- No `isEvalSupported: false`: pdfjs-dist 5.x removed that option and `tsc` rejects it.
- Font size and theme are remembered across sessions. The plan did not ask for this.
- Added: link containment in Markdown and the main-window navigation guard, found in review.

### Verification
- `yarn typecheck`: pass.
- `yarn lint`: pass.
- `yarn test`: 17 files, 120 tests pass.
- `yarn build`: pass. The renderer chunk is about 1.1 MB, which triggers a size warning only.
- **Not run (needs a GUI):**
  - checking each format by hand in `yarn dev`;
  - the project Read buttons;
  - resuming the reading position;
  - the CSP console check with an image-heavy EPUB;
  - the DevTools check that `readBook({ path: 'C:/Windows/win.ini' })` is rejected.

### Known limitations and follow-ups
- PDF placeholders, page tracking and page jump assume every page is the size of page 1, so PDFs with mixed page sizes may drift.
- The EPUB theme colours are set with `themes.override`. Books with strong styles of their own may ignore them.
- Relative images in Markdown are not resolved, and external links do nothing.
- DOCX is not supported in the reader.
- The epub/pdf viewers could be code-split with dynamic import to shrink the main chunk.

### Commit status
Uncommitted on `BTT-04_built-in-reader`.
