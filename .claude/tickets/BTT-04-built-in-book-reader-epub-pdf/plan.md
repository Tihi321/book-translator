# BTT-04: Built-in book reader (EPUB, PDF, TXT, Markdown)

> Ticket folder: `.claude/tickets/BTT-04-built-in-book-reader-epub-pdf/`

**Branch:** `BTT-04_built-in-reader` (from `origin/master` @ f11428b)

## Context
Book Translator (Electron + React 19 + zustand, sandboxed renderer, Node engine in a utilityProcess) has no way to read a book inside the app. Today you export and then open the file in another program. This change adds a small reader that renders each format the way it really looks. You can open it two ways:
1. a new **Reader** view in the top bar, for any local `.epub`, `.pdf`, `.txt` or `.md` file;
2. a **Read** action in a project, for its original file or its current translation (export runs first, as the Export button already does).

Decisions already made with the user: open both standalone files and project books; use native rendering, not reflowed IR text.

## Approach

### 1. File access (main + preload + protocol types)
The renderer cannot read files today. Add two host IPC calls, built like the existing `host:*` handlers in `src/main/index.ts`:
- `host:pickBook` opens a native dialog filtered to `epub, pdf, txt, md, markdown`. It adds the chosen absolute path to a main-process `granted: Set<string>` and returns the path, or null if cancelled. It honours `BOOK_TRANSLATOR_PICK_FILE` for scripted checks, like `host:pickFile`.
- `host:readBook(target)` takes `{ path: string } | { projectId: string }` and returns `{ name, ext, bytes: Uint8Array }`.
  - `{ path }` is allowed only if the path is in `granted` or inside the data folder (reuse `insideData(p, true)`). Exported translations live in `projects/<id>/output/`, so they pass.
  - `{ projectId }` resolves `project.sourcePath` by asking the engine: `engine.request({ type: 'getProject', projectId })`.
  - Files over 300 MB and other extensions are rejected.
- Add `pickBook()` and `readBook()` to `BookTranslatorApi` in `src/shared/protocol.ts`, plus a `BookFile` type, and wire them in `src/preload/index.ts`.

**Why bytes over IPC rather than a `book://` protocol:** epub.js and pdf.js both take an ArrayBuffer, and Markdown and TXT are just text. Sending bytes over IPC means no privileged scheme and less CSP work, and it keeps the existing path guard as the single security check. Native rendering is still the result.

### 2. Dependencies (renderer only)
- `epubjs` (0.3.x) renders EPUB pages, keeping their own CSS and images.
- `marked` plus `dompurify` render Markdown; DOMPurify sanitizes it because Markdown can contain raw HTML.
- `pdfjs-dist` is already installed. Use it in the renderer with the worker imported as `pdfjs-dist/build/pdf.worker.min.mjs?url`, and pass `isEvalSupported: false`.

### 3. CSP (`src/renderer/index.html`)
epub.js renders inside an iframe and loads EPUB resources from blob URLs. Extend the CSP to:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; frame-src 'self' blob:; worker-src 'self' blob:`
`script-src` stays strict, so EPUB scripts never run (epub.js `allowScriptedContent: false`).

### 4. Reader UI (`src/renderer/ui/reader/`)
- **`Reader.tsx`** is the shell. It has a toolbar (Open file, the file name, Back to project when opened from a project, font size − / +, light/sepia/dark theme) and picks a viewer from `ext`.
- **`EpubViewer.tsx`:** `ePub(bytes.buffer)` with `rendition = book.renderTo(el, { flow: 'paginated', width: '100%', height: '100%', allowScriptedContent: false })`.
  - Prev/next buttons and ←/→ keys.
  - A table-of-contents dropdown built from `book.navigation.toc`.
  - Font size and theme are applied with `rendition.themes`.
  - Calls `book.destroy()` on unmount.
- **`PdfViewer.tsx`:** `getDocument({ data, isEvalSupported: false })` and a vertical list of page canvases.
  - Pages render lazily with an IntersectionObserver.
  - Zoom − / + / fit-width.
  - A page indicator and a jump-to-page input.
  - Calls `doc.destroy()` on unmount.
- **`TextViewer.tsx`:**
  - TXT is decoded with `TextDecoder` and shown with `white-space: pre-wrap`.
  - Markdown goes through `DOMPurify.sanitize(marked.parse(text))` and is inserted with `dangerouslySetInnerHTML`.
  - Both use a centred serif reading column of about 70ch. Relative images in Markdown are not resolved.
- **Remembered position:** keep the last place per file in `localStorage` (EPUB CFI, PDF page, text scroll ratio), keyed by path or projectId+side. Wrap all reads and writes in try/catch.
- **Styles:** add reader classes to `src/renderer/styles.css` using the existing CSS variables, so the app chrome stays dark. Light, sepia and dark themes apply only to the page surface.

### 5. Navigation
- In `src/renderer/store/store.ts`, extend `View` with `{ name: 'reader'; source?: { path: string } | { projectId: string; side: 'source' | 'translation' } }`.
- In `src/renderer/App.tsx`, add a top-bar **Reader** button and `{view.name === 'reader' && <Reader source={view.source} />}`.
  - With no source, the reader shows an empty state with an Open file button that calls `pickBook`.
- In `src/renderer/ui/ProjectView.tsx`, add **Read original** and **Read translation** buttons to the header row.
  - Read translation calls `export` (like `doExport`), then opens the reader with `{ path: res.path }`. A PDF project's translation is exported as EPUB, which the reader handles.
  - Hide both buttons for DOCX projects (`p.format === 'docx'`), because DOCX is out of scope.
  - Back returns to `{ name: 'project', id }`.

## Critical files
- `src/main/index.ts`: `host:pickBook` and `host:readBook`, the `granted` set, reusing `insideData()` and `engineInfo()`.
- `src/preload/index.ts` and `src/shared/protocol.ts`: the new API methods and `BookFile`.
- `src/renderer/index.html`: the CSP.
- `src/renderer/store/store.ts` and `src/renderer/App.tsx`: the view and the top-bar button.
- `src/renderer/ui/ProjectView.tsx`: the Read buttons.
- New files: `src/renderer/ui/reader/{Reader,EpubViewer,PdfViewer,TextViewer}.tsx` and a small `position.ts` for localStorage.
- `src/renderer/styles.css`: the reader styles.
- `package.json`: `epubjs`, `marked`, `dompurify` (and `@types/dompurify` if needed).

## Verification
1. `yarn typecheck`, `yarn lint`, `yarn test`. The existing engine tests must stay green; nothing changes in the engine.
2. `yarn dev`, then the top-bar Reader → Open file with one sample of each format:
   - **EPUB:** pages flip with the buttons and ←/→, the TOC jumps, images and styles show, and font size and theme change the page.
   - **PDF:** pages render lazily, zoom and page jump work, and a large PDF stays responsive.
   - **MD:** headings, lists, code and links render, and a `<script>` in the Markdown does not run.
   - **TXT:** line breaks are kept and UTF-8 text decodes correctly.
3. In a project:
   - Read original opens the source.
   - Read translation exports and opens the translated file. A PDF project opens as EPUB.
   - Back returns to the project.
   - The buttons are hidden for a DOCX project.
4. Close and reopen the same book: it resumes where you left off.
5. DevTools console: no CSP violations while reading an EPUB with images and fonts.
6. Security check: calling `window.bt.readBook({ path: 'C:/Windows/win.ini' })` from DevTools is rejected.

## Implementation status

- [x] `host:pickBook` / `host:readBook` in `src/main/index.ts` (granted set, insideData, 300 MB and extension limits, projectId via getProject)
- [x] `pickBook` / `readBook`, `BookTarget`, `BookFile` in `src/shared/protocol.ts`; wired in `src/preload/index.ts`; fake API in `tests/store.test.ts` updated
- [x] CSP in `src/renderer/index.html` as specified
- [x] Deps added: `epubjs`, `marked`, `dompurify` (no @types needed)
- [x] `src/renderer/ui/reader/{Reader,EpubViewer,PdfViewer,TextViewer}.tsx`, `position.ts`; reader styles in `styles.css`
- [x] `View` extended (`reader`), top-bar Reader button and keyed `<Reader>` in `App.tsx`
- [x] Read original / Read translation in `ProjectView.tsx`, hidden for docx
- [ ] Manual GUI checks (verification items 2-6) not run: no GUI available

Verification run: `yarn typecheck` pass, `yarn lint` pass, `yarn test` pass (17 files, 120 tests), `yarn build` pass (pdf worker emitted as asset; renderer chunk 1.1 MB warning only).

Deviations:
- Path variant of the reader source is `{ path: string; projectId?: string }` so Back returns to the project after Read translation. The type is `ReaderSource` in `store.ts`.
- `isEvalSupported: false` dropped from `getDocument`: pdfjs-dist 5.x no longer has that option (typecheck rejects it) and does not use eval.
- Picking a different file inside the reader hides Back to project.

### Orchestrator review fixes
- [x] Markdown links no longer navigate the app window. `TextViewer` intercepts anchor clicks, and in-page `#anchors` still scroll.
- [x] Main window guard: `will-navigate` is prevented and `setWindowOpenHandler` denies new windows.
- [x] Re-ran typecheck, lint, test (120/120) and build: all pass.
