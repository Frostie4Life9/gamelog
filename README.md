# gamelog
Game progress and rating tracker

## Goals content packs

Games with a deep checklist have a pack under `content/<slug>/`. The app loads a pack when you open the game, and your progress is stored as checked ids inside the game, so a big pack never bloats your synced library.

- `content/index.json` lists the packs. A game attaches to its pack by Steam id.
- `content/<slug>/manifest.json` lists the tabs. Each tab has an `id`, a `name`, a `file`, and a `tier`: `story`, `side`, `collect` or `extra`. The finish line decides which tiers count: Beat it = story, Main + side = story and side, 100% = everything. Add `"expected": N` to a tab once a survey has established its real total, and the app shows how much is researched.
- Each tab file is `{ "entries": [ ... ] }`. An entry has `id` (unique in the game, never reused, because progress is keyed by it) and `name`. Everything else is optional: `region`, `how`, `prereq`, `unlocks`, `mins` (estimated minutes), `missable`, `sources` (`[{ "t": "title", "u": "https://..." }]`) and `verified` (`sourced`, `user` or `unsourced`).
- Progress is weighted by `mins` only when every goal counted has one. Otherwise it counts goals.
- Before pushing a pack change, run `node tools/validate-content.mjs`.
