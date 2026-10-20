# BTT-08: Visual-novel script adapter (Scriptorium book folders)

Ticket folder: `.claude/tickets/BTT-08-vn-script-adapter/`
Branch: `BTT-08_vn-script-adapter` (created from `master` at f30c4f1)

## Context

The creative hub (`C:\projects\Personal\creative-hub`) chains Scriptorium (writes a visual-novel book), Book Translator and VN Studio. VN Studio adds a translated edition with `vno_add_edition`, pairing it with the original beat by beat, so the translation must keep every script line in order with its markers. The Markdown/TXT adapter (`src/engine/formats/text.ts`) merges single-newline lines into paragraphs, sends YAML frontmatter for translation and translates `SCENE:`, `ON SCREEN:` and `NAME (expr):`, which breaks VN Studio's parser. The hub skill told Claude to translate VN editions by hand.

Format: Scriptorium `docs/visual-novel.md` (grammar and regexes). Example book: `visual-novels-orchestrator/tests/fixtures/books/soother/`.

## Progress checklist
- [x] 1. Script-aware adapter `src/engine/formats/vn.ts`: one block per text span (line), frontmatter values `title`, `blurb`, `summary`, `chapters[].title/summary/ending`, `chapters[].choices[].text` translated in place (other keys kept byte for byte), `SCENE:` / `ON SCREEN:` / speaker tags / `Narration:` / `---` / stage directions kept, spoken lines sent as `<1>NAME (expr):</1> text`.
- [x] 2. Folder input: a folder with `book.md` + `chapters/` is format `vn`, one project; export writes `<folder>.<lang>` with the same layout. Bible and cover brief copied (decision below).
- [x] 3. Engine: `hashSource` (folder hash), glossary seeded with the bible character names (kept), the script rules appended to the brief for every agent, export warnings to the log, dispatcher reads folders uncached; MCP descriptions and CLI usage mention folders; the UI hides the reader buttons for `vn`.
- [x] 4. Tests: `tests/vn.test.ts` (adapter on the soother fixture, safety cases, YAML quoting, engine end to end with mock models), `tests/mcp.test.ts` (translator flow with a folder).
- [x] 5. README section "Visual-novel book folders".
- [x] Verification (see changelog).

## Decisions

- **Bible and cover brief are not translated** (copied). They are the art reference: VN Studio reuses the original's pictures for an edition and prompts image models in English. VN Studio takes the edition's character display names from the edition's bible, so names stay the same as the speaker tags.
- **Character names are not translated.** Speaker tags and `ON SCREEN:` names must match the bible. The project's glossary starts with `Name -> Name` for each bible character; the glossary builder keeps existing entries.
- **`ON SCREEN:` lines stay whole** (names and looks are sprite directions, not shown to the player). `SCENE:` text is translated (VN Studio shows the place name from it).
- **`ending` is translated** (VN Studio shows it), as is `blurb`. The body of `book.md` (editor notes) is kept.
- **A translated line that would change kind** (narration that looks like `NAME: ...`, a heading) or comes back empty keeps the source text, with a warning in the project log.
