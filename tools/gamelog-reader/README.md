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

## Credits
Faction quest lists and their quest keys: [gaming.tools](https://crimsondesert.gaming.tools/faction-quests),
cross-checked against the save editor's quest table.

Crimson Desert save format: [NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS](https://github.com/NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS)
(MPL-2.0) and its contributors. This reader is an independent, read-only reimplementation.
