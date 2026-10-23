// Checks every content pack before it is pushed: node tools/validate-content.mjs
// Catches the mistakes that would make the app silently drop or mis-count goals.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'content');
const TIERS = ['story', 'side', 'collect', 'extra'];
const VERIFIED = ['sourced', 'user', 'unsourced'];
let problems = 0;
const bad = (msg) => { problems++; console.log('  PROBLEM: ' + msg); };

const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
for (const game of index.games) {
  console.log(game.slug);
  const dir = join(root, game.slug), manPath = join(dir, 'manifest.json');
  if (!existsSync(manPath)) { bad('manifest.json is missing'); continue; }
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  const ids = new Set(), tabIds = new Set();
  for (const t of man.tabs) {
    if (!/^[a-z0-9-]+$/.test(t.id)) bad(`tab id "${t.id}" must be lowercase letters, numbers and dashes`);
    if (tabIds.has(t.id)) bad(`duplicate tab id "${t.id}"`);
    tabIds.add(t.id);
    if (!TIERS.includes(t.tier)) bad(`tab "${t.id}" has tier "${t.tier}", expected one of ${TIERS.join(', ')}`);
    const file = join(dir, t.file);
    if (!existsSync(file)) { bad(`tab "${t.id}" points at missing file ${t.file}`); continue; }
    const entries = JSON.parse(readFileSync(file, 'utf8')).entries || [];
    let timed = 0, sourced = 0;
    for (const e of entries) {
      if (!e.id || !e.name) { bad(`${t.file}: an entry has no id or name`); continue; }
      if (ids.has(e.id)) bad(`${t.file}: id "${e.id}" is used twice in this game (progress is keyed by id)`);
      ids.add(e.id);
      if (e.verified && !VERIFIED.includes(e.verified)) bad(`${t.file}: "${e.id}" has verified "${e.verified}"`);
      if (e.verified === 'sourced' && !(e.sources && e.sources.length)) bad(`${t.file}: "${e.id}" says sourced but lists no sources`);
      for (const s of e.sources || []) if (!/^https:\/\//.test(s.u || '')) bad(`${t.file}: "${e.id}" has a source that is not an https link`);
      if (e.mins > 0) timed++;
      if (e.sources && e.sources.length) sourced++;
    }
    const note = t.expected ? ` of ${t.expected} expected` : '';
    console.log(`  ${t.name}: ${entries.length}${note}, ${timed} timed, ${sourced} with sources`);
    if (t.expected && entries.length > t.expected) bad(`${t.file}: has more entries than the expected total (${t.expected}); update "expected"`);
  }
}
console.log(problems ? `${problems} problem(s)` : 'All content packs look good');
process.exit(problems ? 1 : 0);
