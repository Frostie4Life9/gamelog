# gamelog
Game progress and rating tracker

## Goals content packs

Games with a deep checklist have a pack under `content/<slug>/`. The app loads a pack when you open the game, and your progress is stored as checked ids inside the game, so a big pack never bloats your synced library.

- `content/index.json` lists the packs. A game attaches to its pack by Steam id (`steamId`), by IGDB id (`igdbId`), or, for console games, by `platform` plus `title` (an `aliases` list also counts). The platform is part of the match, so the N64 version of a game never picks up a remake's pack.
- `content/<slug>/manifest.json` lists the tabs. Each tab has an `id`, a `name`, a `file`, and a `tier`: `story`, `side`, `collect` or `extra`. The finish line decides which tiers count: Beat it = story, Main + side = story and side, 100% = everything. Add `"expected": N` to a tab once a survey has established its real total, and the app shows how much is researched.
- Each tab file is `{ "entries": [ ... ] }`. An entry has `id` (unique in the game, never reused, because progress is keyed by it) and `name`. Everything else is optional: `region`, `how`, `prereq`, `unlocks`, `mins` (estimated minutes), `missable`, `sources` (`[{ "t": "title", "u": "https://..." }]`) and `verified` (`sourced`, `user` or `unsourced`).
- `save` (Crimson Desert) tells the PC save reader how to tick the entry: `{"mission": key}`, `{"knowledge": key}`, or `{"quests": [keys]}` for a quest line that ticks once every quest is finished. Run `node tools/build-cd-goals.mjs` after changing one.
- Progress is weighted by `mins` only when every goal counted has one. Otherwise it counts goals.
- Before pushing a pack change, run `node tools/validate-content.mjs`.
- Console games have no save reader, so their packs are ticked by hand. Mark entries `"verified": "unsourced"` until a source backs them, and say in the manifest `note` what the list is based on.

## Console games

The Library's Add console game button searches IGDB through the Worker (`/igdb/search`) and adds the game on the platform you tap. Its About tab comes from `/igdb/game`, cached on the Worker for a week and on the device. The Worker needs `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` as secrets (a free Confidential app at dev.twitch.tv/console).
