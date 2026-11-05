# Game Log save reader

A small background program for your PC. It watches game saves, reads them
(never writes), and sends Game Log a short report through the gamelog-sync
Worker. Game Log ticks the matching goals and shows what the save says.

## Setup
1. Redeploy the Worker with the current `worker/gamelog-sync.js` (it adds `/progress/<game>`).
2. Put this folder somewhere permanent on your PC and run `setup.bat`.
   It installs Python if needed, the two libraries it uses (`lz4`, `cryptography`),
   asks for your Worker URL and sync secret, does a first read, and adds itself to Startup.

To stop it: delete "Game Log reader" from `shell:startup` and end `pythonw.exe` in Task Manager.
Log file: `gamelog-reader.log` next to the script.

## Games
| Game | What it reads | Goals it ticks |
|---|---|---|
| Crimson Desert | Quest, mission and knowledge states | Main Story (39 main quests, next quest, chapters left); Challenges (156); Collectibles: Abyss, Secret Places, Ancient Ruins, Sanctums, Spires, Constellations, Mazes, Legendary Animals, New Power bosses; Power: Kliff's Observe skills. Side Quests: 63 factions (241 faction quests); each shows quests done and ticks when all are finished. |

`cd_goals.json` maps save keys to goals. It's built from the `save` field on entries in
`content/crimson-desert/*.json` by `node tools/build-cd-goals.mjs`, so keep it next to the script
and rebuild it whenever a `save` field changes.

Each game is one reader function in `gamelog_reader.py` that returns the same
report shape. If a patch breaks a reader, only that game stops updating (the log
says why) and you tick goals by hand as before.

## Screenshots (THE FINALS)
Some games keep your progress on the game company's servers, so there is no save to read.
For those, the reader watches your Steam screenshot folder instead. In game, press **F12** on the
battle pass, Ranked or Contracts screen. Within about 20 seconds the new picture is sent to the Worker,
a vision model reads it, and Game Log shows it under **From your screenshots** on the game's Save point page.

- It only reads *new* screenshots. Older ones already in the folder are left alone the first time it runs.
- Nothing is ticked for you. It's a read-out with its age and how sure the model was; check it if it says low confidence.
- It can also be done by hand: **Read a screenshot** on that page, or `python gamelog_reader.py --shot FILE`.
- Needs a Worker secret `ANTHROPIC_KEY` (an Anthropic API key). Every read is one API call, so the Worker stops at 60 a day.
- Steam must save screenshots as JPEG (Steam > Settings > In Game > Screenshots), since the Worker takes images up to about 5 MB.
- The watched folder is `Steam\userdata\<id>\760\remote\2073850\screenshots`. If yours lives elsewhere, add
  `"shotsDirs": {"the-finals": "D:\\path\\to\\screenshots"}` to `gamelog-reader.json`.
- Redeploy the Worker with the current `worker/gamelog-sync.js` and replace `gamelog_reader.py` in your reader folder.
  No new libraries: it uses only what Python already includes. Log lines say what was read or why a file was skipped.

## Credits
Faction quest lists and their quest keys: [gaming.tools](https://crimsondesert.gaming.tools/faction-quests),
cross-checked against the save editor's quest table.

Crimson Desert save format: [NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS](https://github.com/NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS)
(MPL-2.0) and its contributors. This reader is an independent, read-only reimplementation.
