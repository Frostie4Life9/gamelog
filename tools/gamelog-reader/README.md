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
battle pass, Ranked or Contracts screen. Within about 20 seconds the new picture is read **on your PC**
with free OCR, and Game Log shows what it found under **From your screenshots** on the game's Save point page.

- Free and private: the OCR (RapidOCR, installed by `setup.bat`, about 100 MB) runs on your PC. Only the numbers it found
  are sent to the Worker, never the picture. No API key, no account, no cost.
- OCR copies the text on screen, so it can't invent a number. If it can't read something, that field stays empty.
- Each read shows how old it is and how sure it was. **What it read** lists the raw text it saw, so a wrong number is easy to trace.
- Nothing is ticked for you. It's a read-out.
- It only reads *new* screenshots. Older ones already in the folder are left alone the first time it runs.
- Try one by hand: `python gamelog_reader.py --shot C:\path\to\screenshot.jpg` prints what it read and sends nothing.
  Add `--send` to also send it to Game Log.
- If a screen reads wrong, run `--shot` on it and send the output; the matching rules are in `shot_ocr.py` and are easy to adjust.
- The watched folder is `Steam\userdata\<id>\760\remote\2073850\screenshots`. If yours lives elsewhere, add
  `"shotsDirs": {"the-finals": "D:\\path\\to\\screenshots"}` to `gamelog-reader.json`.
- Redeploy the Worker with the current `worker/gamelog-sync.js`, copy the whole reader folder (it now has `shot_ocr.py`),
  and run `setup.bat` once. If the OCR install fails, save reading keeps working and the log says screenshots are waiting.

## Credits
Faction quest lists and their quest keys: [gaming.tools](https://crimsondesert.gaming.tools/faction-quests),
cross-checked against the save editor's quest table.

Crimson Desert save format: [NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS](https://github.com/NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS)
(MPL-2.0) and its contributors. This reader is an independent, read-only reimplementation.
