# BTT-13 changelog

## 2026-10-22: BTT-11's Electron UI checked live; `yarn build` and `yarn dist` pass, nothing needed fixing

Branch `BTT-13-14_roadmap` from origin/master 46c5768 (one branch for BTT-13 and BTT-14, one commit each). Plan: `plan.md` in this folder.

### Files

- `ROADMAP.md`: the "App" item is gone (all of it verified). The "Verified live" line names the BTT-13 UI check.
- No source file changed. The UI and both builds worked as BTT-11 left them.

### Verification

- `yarn typecheck`, `yarn lint`: clean. `yarn test`: 24 files, 283 tests.
- `yarn build`: passes, with only the usual chunk-size warning.
- `yarn dist`: `dist/Book-Translator-Setup-0.0.1.exe` (160.7 MB) and `dist/win-unpacked/`. It was not installed. The unpacked app was started once with a temp mock-only data folder. The window loaded and `listModels` answered.
- Live in the dev app, driven over CDP with mock models (scripts, fixtures and screenshots `1-new.png` to `13-dist-app.png` are in `.claude/temp/btt13/`):
  - **"Open a book folder"** picks one VN project, with the VN note and an estimate.
  - **A folder that is not a book folder** gets the toast "Not a visual-novel book folder: it needs book.md and a chapters folder".
  - **"Open a folder" on a folder of books** lists the book folder as one item next to the `.md`.
  - **Dropping a book folder** gives one VN project. Dropping a plain folder gives its files as a batch.
  - **`localize-names`** is off by default and sets `settings.localizeNames` only when ticked.
  - **`settings-localize-names`** shows the project's value, saves a change, and is disabled while the project runs.
  - **A mock run with names localized** finishes `done`, and Export writes the VN book folder.
- **Mock only:**
  - The test data folders list only `mock/...` models in `defaults.json` and turn every other provider off in `providers.md`.
  - The check script read the agent lists before each Start.
  - All 5 chunk files record `mock/mock-translator`, and no project log names another provider.
  - The fixture's `book.md` front matter names DeepSeek and OpenRouter models, but that text comes from the Scriptorium book the fixture was copied from.

### Findings, not changed

- Creating a project again for the same source and language merges its settings into the existing project. So an unticked `localize-names` does not clear the setting on that project. The Settings tab does.
- IPC error toasts start with Electron's "Error invoking remote method '…': Error: " prefix. This is true of every host call, not only the new picker.

### Commit status

Committed on `BTT-13-14_roadmap` (not pushed).
