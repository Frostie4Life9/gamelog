// Rebuilds tools/gamelog-reader/cd_goals.json from the 'save' fields in
// content/crimson-desert/*.json: node tools/build-cd-goals.mjs
// Run it after changing any save field, then commit both.
//   save.mission   -> ticked when that mission is completed
//   save.knowledge -> ticked when that knowledge entry is learned
//   save.quests    -> a quest line: ticked when every listed quest is completed;
//                     the reader also reports how many are done
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'content', 'crimson-desert');
const man = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const out = {
  game: 'crimson-desert',
  note: "Built from content/crimson-desert/*.json 'save' fields by tools/build-cd-goals.mjs. Regenerate when those change.",
  mission: {}, knowledge: {}, questGroups: {}
};
let problems = 0;
for (const t of man.tabs) {
  for (const e of JSON.parse(readFileSync(join(dir, t.file), 'utf8')).entries || []) {
    const s = e.save; if (!s) continue;
    if (s.mission != null) out.mission[String(s.mission)] = [t.id, e.id];
    if (s.knowledge != null) out.knowledge[String(s.knowledge)] = [t.id, e.id];
    if (s.quests) {
      if (!Array.isArray(s.quests) || !s.quests.length || !s.quests.every(Number.isInteger)) { problems++; console.log(`PROBLEM: ${e.id} save.quests must be a list of quest keys`); continue; }
      out.questGroups[e.id] = [t.id, s.quests];
    }
  }
}
writeFileSync(join(root, 'tools', 'gamelog-reader', 'cd_goals.json'), JSON.stringify(out, null, 0).replace(/\],"/g, '],\n"').replace(/\{"/g, '{\n"') + '\n');
console.log(`missions ${Object.keys(out.mission).length}, knowledge ${Object.keys(out.knowledge).length}, quest lines ${Object.keys(out.questGroups).length}`);
process.exit(problems ? 1 : 0);
