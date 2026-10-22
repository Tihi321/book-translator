# Roadmap

What Book Translator still lacks on its own. Work that needs the other tools or a production run (the BTT-11 live check, translations for the hub) is planned in the creative hub (`C:\projects\Personal\creative-hub\ROADMAP.md`, tickets `HUB-NN` in its `.claude/tickets/`). Finished work is in `.claude/tickets/` (BTT-08 VN script adapter, BTT-09 client provider, BTT-10 client-only projects, BTT-11 the hub roadmap fixes). Fix items on a ticket branch (`BTT-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master 1895741)

- **Merged:** BTT-08 to BTT-11. BTT-11 closed every Book Translator item of the hub roadmap. 283 tests pass.
- **Verified live:** the Electron UI of BTT-11 (book folder picker, folder and book-folder drop, `localize-names` checkboxes, a mock run, `yarn build` and `yarn dist`, BTT-13); a VN book folder aligned in VN Studio 381/381 (mock model); a whole book translated into Croatian with Claude doing every model task (*The Clockless God*).
- **Hub tasks that use this repo:** HUB-02 (BTT-11 live check), HUB-05 (*The Hour That Happens Twice* in Croatian), HUB-09 (ACP proxy provider, on hold).

## Engine

- **Reload during a run.** A running project keeps its chunk plan after a providers reload, and a request already waiting for a slot holds the old provider until it wakes.
