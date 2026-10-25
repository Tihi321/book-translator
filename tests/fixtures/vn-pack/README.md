# Visual-novel pack fixtures (HUB-16)

`soother`, `choice` and `mystery-puzzle` are the canonical cross-repo fixtures of HUB-16, copied from
`creative-hub/.claude/temp/hub16-fixtures/` (the hub ticket `HUB-16-vn-pack`; Scriptorium SCP-45 writes them). Each is a Scriptorium book folder
plus the v2 pack (`vn/pack.json` and the source catalog `vn/text/en.json`), so the tests also prove that a folder with a pack is translated as a
pack and not by its authored chapters. Do not edit them by hand; a fixture change belongs in the hub ticket and a fresh copy here. Tests that need
a broken pack or catalog copy one of these into a temporary folder first.
