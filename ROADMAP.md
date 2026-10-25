# Roadmap

What Book Translator still lacks on its own. Work that needs the other tools or a production run (the BTT-11 live check, translations for the hub) is planned in the creative hub (`C:\projects\Personal\creative-hub\ROADMAP.md`, tickets `HUB-NN` in its `.claude/tickets/`). Finished work is in `.claude/tickets/` (BTT-08 VN script adapter, BTT-09 client provider, BTT-10 client-only projects, BTT-11 the hub roadmap fixes, BTT-13/14 UI check and providers reload, BTT-15 to BTT-20 the hub findings). Fix items on a ticket branch (`BTT-NN_<what>`) cut from `master`.

## Where it stands (2026-10-25)

- **Merged 2026-10-25 (PR #16):** BTT-23 translates only a VN pack's text catalog (`format: vnp`), validates the key set/pack hash and exports a bundle with a byte-identical template; legacy folder translation stays with a marker-byte safety check. 360 tests, typecheck and lint green; live `analyze_file`/task proof on the real pack. Plan/changelog in `.claude/tickets/BTT-23-vn-pack/`.
- **Merged:** BTT-08 to BTT-14. BTT-11 closed every Book Translator item of the hub roadmap; BTT-13 (the BTT-11 UI checked live, build and installer) and BTT-14 (a providers reload reaches a running project) are in master with PR #11, and PR #12 added this roadmap's findings.
- **Branch `BTT-15-20_fixes`:** BTT-15 to BTT-20, one commit each, 313 tests pass (not merged yet). Nothing of Book Translator's own is open after it.
- **Verified live:** the Electron UI of BTT-11 (book folder picker, folder and book-folder drop, `localize-names` checkboxes, a mock run, `yarn build` and `yarn dist`, BTT-13); a VN book folder aligned in VN Studio 381/381 (mock model); a whole book translated into Croatian with Claude doing every model task (*The Clockless God*). Not yet run with a real model or in the UI: the BTT-15 to BTT-20 fixes (tests only).
- **Hub tasks that use this repo:** HUB-02 (BTT-11 live check), HUB-05 (*The Hour That Happens Twice* in Croatian), HUB-09 (ACP proxy provider, on hold).

## Done (custom providers, the ACP proxy and named MCP clients, 2026-10-24; plan in `.claude/tickets/BTT-21-custom-providers/plan.md`, branch `BTT-21_custom-providers`)

Ported from Scriptorium's SCP-44; VN Studio's VNO-39 is the same change.

- **BTT-21: add your own OpenAI-compatible provider in the Models dialog.** "+ Add provider" (Name, Base URL, API key, Free, Send JSON schema, Parallel, Enabled, Test), Edit and Remove for the ones added that way. Saved to `config/providers.md` as `custom: true` with a `name` (comments kept), the key in the credential store as `CUSTOM_<ID>_API_KEY`; Remove also clears its key, models.md and defaults.json refs. Commands `saveCustomProvider`, `removeCustomProvider`, `testCustomProvider`.
- **Open model groups.** `groupDefaults` and `modelOrder` in `defaults.json` take any group name: `paid` for the paid seed providers, else the provider id, so each custom provider is its own group and row in "Default models for a new translation" (labelled with its name; API, Strata and LM Studio keep theirs). Old values work unchanged.
- **Seed `acp` provider** (the ACP proxy, `http://127.0.0.1:7461/v1`, off, text only, `PROXY_IGNORE_SAMPLING=1`) replaces the disabled `custom` placeholder; existing data folders get it once. Antigravity terms risk: creative-hub ROADMAP "Antigravity models and the ACP proxy".
- **Named MCP clients.** Client tasks carry the client (`claude-code`, `antigravity`); `get_client_task` / `release_client_task` take an optional `client` (missing = `claude-code`). Seed model `client/antigravity`, added once to existing data folders. README: "Antigravity CLI as a client".

## Done (found by the creative hub's HUB-02 and HUB-05 runs, 2026-10-22; plan in `.claude/tickets/BTT-15-20-hub-fixes/plan.md`)

Seen on the master build (2a21970) while Claude translated *The Clockless God* VN script and *The Hour That Happens Twice* into Croatian through the client provider. Each item was its own commit on `BTT-15-20_fixes`.

- **BTT-15: QA flagged kept lines in VN folders as "untranslated".** Only the words outside inline tags count now, and glossary keep rows (source equals target) do not count. A line the brief says to keep, with 3 or more words and no keep row, is still flagged (the brief is free text and is not parsed).
- **BTT-16: the glossary pass overwrote the brief.** The pass now merges: the user's brief text stays, only the fields and characters it lacks are added.
- **BTT-17: glossary matching was a substring match.** Whole word or phrase, Unicode-aware. QA accepts an inflected target by stem (word minus its last 1 to 2 letters).
- **BTT-18: an EPUB export kept the English cover.** The cover's alt text is translated; `cover: title` (MCP, CLI `--cover title`) replaces the image by a generated SVG title page. Default unchanged. No UI control yet.
- **BTT-19: a stale `engine.lock` blocked the start when its pid was reused.** The lock holds the pid, start time and name; a live pid with another start time, or (older locks) a name that is not Book Translator, Node or Electron, is taken over.
- **BTT-20: client task loop ergonomics.** `wait_for_progress` has a `role` filter (the 60 s cap stays: the MCP client's default request timeout is 60 s); the lease is 10 minutes (`leaseMinutes` up to 60), renewed by a refused answer, and `release_client_task` frees every leased task of a project or role (the endpoint has no sessions, so a dead client cannot be noticed); the `fixMinorIssues` setting (default off, a checkbox in the settings tab) sends minor QA issues to the fixer, and minors are listed in `wait_for_progress` and `engine status`.
