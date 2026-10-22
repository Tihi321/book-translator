# BTT-13: Check the BTT-11 Electron UI live, and build the installer

Ticket folder: `.claude/tickets/BTT-13-ui-check-book-folder/`. Branch: `BTT-13-14_roadmap` (one branch for the ROADMAP.md items BTT-13 and BTT-14, one commit per ticket), cut from `origin/master` @ 46c5768.

Source: `ROADMAP.md` > "App": "The Electron UI of BTT-11 was only type-checked: the "Open a book folder" picker, folder drop of a book folder, and the `localize-names` / `settings-localize-names` checkboxes. `yarn build` / `yarn dist` were not run."

## Goal

Every UI piece BTT-11 added is seen working in the real Electron app, and the production build and the Windows installer build. What breaks is fixed in this ticket.

## Rules

- **Mock models only** (memory: a dev check once fell back to DeepSeek with the user's real key). The dev harness sets `BOOK_TRANSLATOR_MOCK=1` and uses its own data folder under `.claude/temp/`. Before any run is started, every agent list is `mock/mock-translator` / `mock/mock-reviewer`. Best: write a `config/defaults.json` into the test data folder whose agent lists name only mock models, so a run cannot reach a paid model even by mistake. Check the project's `settings.agentModels` before pressing Start.
- Native dialogs are not driven: the main process already reads `BOOK_TRANSLATOR_PICK_BOOK_FOLDER` / `BOOK_TRANSLATOR_PICK_FOLDER` / `BOOK_TRANSLATOR_PICK_FILE` (`src/main/index.ts:139-185`).
- Drive the app over CDP (`--remote-debugging-port=9333`) with the helpers in `.claude/temp/cdp.mjs`; folder drop with `Input.dispatchDragEvent`, as BTT-05 did (`.claude/temp/dnd/flow.mjs`). Screenshots go to `.claude/temp/btt13/`.

## Checklist

- [x] 1. `yarn typecheck`, `yarn lint`, `yarn test` green on the branch (baseline 24 files, 283 tests).
  _Done: `yarn typecheck` and `yarn lint` exit 0; `yarn test` 24 files, 283 tests passed._ _(unchanged baseline, no code changed)_
- [x] 2. `yarn build` (engine + electron-vite). Fix what fails.
  _Done: `yarn build` exit 0 (engine + electron-vite main/preload/renderer); only the usual chunk-size warning. Nothing to fix._
- [x] 3. Fixtures in `.claude/temp/btt13/`: a VN book folder (`book.md` + `chapters/01.md`, with two speaking characters, e.g. from `tests/fixtures` or the `tests/vn.test.ts` fixture text), a plain folder with two `.md` files, and a folder of books holding the VN book folder plus one `.md`.
  _Done: `.claude/temp/btt13/setup.mjs` builds `fixtures/`: `vnbook` (book.md, bible, ch-01, ch-02 from tests/fixtures/books/soother; Petra, Pip, Mango... speak), `vnbook2` (same, ch-01 only; needed because the same source + language is one project, see 5e), `plain` (one.md, two.md), `books` (vnbook + note.md)._
- [x] 4. Dev harness `.claude/temp/btt13/dev.ps1` (like `.claude/temp/dev-dnd.ps1`): mock env, `BOOK_TRANSLATOR_PICK_BOOK_FOLDER` = the VN book folder, `BOOK_TRANSLATOR_PICK_FOLDER` = the folder of books, a fresh data folder with the mock-only `defaults.json`.
  _Done: `dev.ps1 -Pick -Data -Delay` (+ `restart.ps1`, which kills the previous run by PID, runs setup.mjs, starts dev). `setup.mjs <name>` writes a data folder whose `config/defaults.json` lists only `mock/mock-translator`, `mock/mock-reviewer` for glossary/translator/proofreader/qa (groupDefaults empty) and a `providers.md` with every provider except `mock` set `enabled: false` (client too)._
- [x] 5. Live checks (CDP script `.claude/temp/btt13/flow.mjs`):
  - [x] a. New translation > "Open a book folder" (`choose-book-folder`): one VN project is picked (format VN, the VN note shows), with an estimate.
    _Done: PASS. Picked `fixtures/vnbook`: format VN, title "The Soother That Fell...", 102 blocks in 3 sections, VN note shown, estimate 3 chunks, free. `2-5a-book-folder.png`._
  - [x] b. The picker on a folder that is not a book folder (env var pointed at the plain folder): a clear error toast ("Not a visual-novel book folder ..."), nothing picked.
    _Done: PASS (own session, `flow5b.mjs`, `PICK_BOOK_FOLDER` = plain folder, data5b). Toast "Not a visual-novel book folder: it needs book.md and a chapters folder"; no batch/estimate shown. The toast text carries Electron's "Error invoking remote method 'host:pickBookFolder': Error: " prefix, as every IPC error does (store `attempt`); left as is. `12-5b-error.png`._
  - [x] c. "Open a folder" on the folder of books: the VN book folder is one item next to the `.md`, not `book.md` + `chapters/` files.
    _Done: PASS. List is `["note.md","vnbook"]`, no book.md/chapters entries. `3-5c-folder-of-books.png`._
  - [x] d. Drop the VN book folder on the drop zone: one VN project, same as (a). Drop the plain folder: the batch list of its two files.
    _Done: PASS. Real `Input.dispatchDragEvent` drop of vnbook: one VN project, same stats as (a); drop of `plain`: batch `["one.md","two.md"]`. `4-5d-drop-vn.png`, `5-5d-drop-plain.png`._
  - [x] e. `localize-names` checkbox on New translation: off by default; ticked, the created project has `settings.localizeNames: true` (read through `engine:request` `getProject`); unticked, the key is absent.
    _Done: PASS. Unchecked by default; ticked, project A `getProject` settings.localizeNames === true; project B (vnbook2, unticked) settings keys have no `localizeNames`. Before each Start the script read the agent lists on the page (mock only) and afterwards `settings.agentModels` (all `mock/...`). `6-5e-before-start.png`, `7-5e-project-A.png`. Finding (not a bug fix, by design in `service.createProject`): creating the same source + language again merges settings, so unticking the box on a re-open does not clear `localizeNames` of the existing project; use the Settings tab for that._
  - [x] f. Project > Settings tab: `settings-localize-names` shows the project's value, changing it is saved (`getProject` again), and it is disabled while the project runs (`locked`).
    _Done: PASS. A while running (status `glossary`): checkbox checked and `disabled`. B after done: unchecked and enabled; ticked + Save settings, `getProject` shows `localizeNames: true`. `8-5f-locked.png`, `10-5f-changed.png`, `11-5f-saved.png`._
  - [x] g. One mock run of the VN project with names localized: it finishes `done`, and the export opens (the mock translator does not localize names; this only checks the path runs end to end with the setting on).
    _Done: PASS. A (localize on) finished `done`; Export button wrote `data/projects/vnbook-hr-4d0c90/output/vnbook.hr` (book.md, bible, chapters) and the "Exported to ..." toast showed. B (off) also `done`. A's detail names only `mock/mock-translator` / `mock/mock-reviewer`. `9-5g-done-export.png`. (VN projects have no in-app reader; "Export" is the open path.)_
- [x] 6. `yarn dist` (NSIS installer into `dist/`). Fix what fails. Do not install it over the user's installed app; start the unpacked `dist/win-unpacked/Book Translator.exe` once with `--data` pointing at a temp folder and check the window opens and the engine answers (`listModels` over CDP), then close it.
  _Done: `yarn dist` exit 0: `dist/Book-Translator-Setup-0.0.1.exe` (160.7 MB), blockmap, `latest.yml`, `win-unpacked/`. Not installed. Started `dist/win-unpacked/Book Translator.exe --remote-debugging-port=9333 --data .claude/temp/btt13/datapkg` with BOOK_TRANSLATOR_MOCK=1 and the mock-only data folder: window "Book Translator" loaded from `resources/app/out/renderer/index.html`, `listModels` answered 12 models (mock/mock-translator, mock/mock-reviewer; 0 available non-mock), UI shows "mock models on" and an empty list. `13-dist-app.png`. Killed by PID (taskkill /T); no electron processes left._
- [x] 7. Docs: `ROADMAP.md` drops the "App" item (or keeps what was not verified, with the reason); `changelog.md` in this folder lists what ran, what was fixed and the screenshots.
  _Done: the "App" item is removed (all of it was verified) and the "Verified live" line names BTT-13; `changelog.md` written by the orchestrator. The orchestrator checked the chunk files: all 5 chunks record `mock/mock-translator`, and the project logs name no other provider._

## Verification

- `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build`, `yarn dist` pass.
- Steps 5a-5g pass in the dev app, with screenshots; no request went to a non-mock provider (the project logs name only `mock/...` models).
- Step 6: the packaged app starts and its engine answers.
