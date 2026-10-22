/* =========================================================
   Game Log — sync + Steam art endpoint
   Cloudflare Worker + KV. Same setup pattern as protocol-sync.

   SETUP (dashboard)
   1. Workers & Pages > Create > Start with Hello World
      -> name it "gamelog-sync" -> Deploy
   2. Edit code -> delete everything -> paste this file -> Deploy
   3. Settings > Bindings > Add > KV namespace
        Variable name: STATE
        KV namespace:  gamelog   (already created)
   4. Settings > Variables and Secrets > Add
        Type: Secret   Name: SECRET     Value: a long random string you invent
        Type: Secret   Name: STEAM_KEY  Value: your Steam Web API key
                                        (steamcommunity.com/dev/apikey)
        Type: Text     Name: STEAM_ID   Value: your SteamID64 (7656119...)
                                        or your custom profile name
   5. Deploy again, then paste the Worker URL and the secret into
      Game Log's Sync panel.
   6. Steam > Profile > Edit Profile > Privacy Settings:
        Game details = Public  (the Web API can't read playtime otherwise)

   Opening the URL in a browser should return {"error":"unauthorized"}.

   ROUTES (all need the x-sync-key header)
   GET  /                 -> the saved library JSON (or null)
   PUT  /                 -> save library. Refused with 409 if the stored
                             copy is newer, so a stale device can't
                             overwrite fresher data. The previous copy is
                             kept under "state-prev" as a safety net.
   GET  /steam/search?q=  -> up to 6 Steam matches with cover art URLs
   GET  /steam/library?limit=10
                          -> your most recently played Steam games
                             (demos and playtests left out), newest
                             first, with playtime and cover art
   GET  /steam/achievements?appid=
                          -> every achievement for one game: name,
                             description, icon, hidden flag, whether
                             you've unlocked it (and when), and the
                             share of all players who have it
   GET  /steam/news?appid=&count=15
                          -> recent patch notes and announcements for one
                             game, newest first: title, link, date, a
                             cleaned-up excerpt, and whether it looks like
                             patch notes or general news
   ========================================================= */

const KEYNAME = 'state';
const PREV = 'state-prev';
const MAX_BYTES = 1024 * 1024;
const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-sync-key',
  'Access-Control-Max-Age': '86400'
};

function reply(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS)
  });
}

function keyMatches(given, want) {
  let ok = given.length === want.length;
  for (let i = 0; i < Math.max(given.length, want.length); i++) {
    if (given.charCodeAt(i) !== want.charCodeAt(i)) ok = false;
  }
  return ok;
}

/* Steam's newer art lives at hashed paths, so the filename has to be
   looked up rather than guessed. GetItems returns it; appdetails is the
   fallback for the landscape header. */
async function steamArt(ids) {
  const out = {};
  try {
    const input = { ids: ids.map(appid => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true, include_basic_info: true } };
    const r = await fetch('https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=' + encodeURIComponent(JSON.stringify(input)));
    const j = await r.json();
    for (const it of (j.response && j.response.store_items) || []) {
      const a = it.assets;
      if (!a || !a.asset_url_format) { out[it.appid] = { type: it.type, name: it.name, cover: '', hero: '' }; continue; }
      const u = f => f ? ASSET_BASE + a.asset_url_format.replace('${FILENAME}', f) : '';
      out[it.appid] = {
        type: it.type, name: it.name,
        cover: u(a.library_capsule_2x || a.library_capsule),
        hero: u(a.library_hero_2x || a.library_hero),
        header: u(a.header)
      };
    }
  } catch (e) { /* fall through to appdetails */ }
  await Promise.all(ids.filter(id => !out[id] || !out[id].cover).map(async id => {
    try {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`);
      const j = await r.json();
      const d = j[id] && j[id].success && j[id].data;
      if (d && d.header_image) out[id] = Object.assign({ cover: '', hero: '' }, out[id], { header: d.header_image });
    } catch (e) {}
  }));
  return out;
}


/* ---------- Steam library ---------- */
const DEMO_TYPE = 1; // EStoreAppType: 0 game, 1 demo, 4 DLC, 6 tool ...
const DEMO_NAME = /\b(demo|playtest|prologue demo|benchmark)\b/i;

async function steamId64(env) {
  const raw = String(env.STEAM_ID || '').trim()
    .replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '').replace(/\/+$/, '');
  if (/^\d{17}$/.test(raw)) return raw;
  const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${env.STEAM_KEY}&vanityurl=${encodeURIComponent(raw)}`);
  const j = await r.json();
  if (j.response && j.response.success === 1) return j.response.steamid;
  throw new Error(`couldn't find a Steam profile called "${raw}". Set STEAM_ID to your SteamID64 or custom profile name`);
}

async function steamLibrary(env, limit) {
  if (!env.STEAM_KEY) return reply({ error: 'server not configured: missing STEAM_KEY' }, 500);
  if (!env.STEAM_ID) return reply({ error: 'server not configured: missing STEAM_ID' }, 500);
  let sid;
  try { sid = await steamId64(env); } catch (e) { return reply({ error: e.message }, 400); }

  const r = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${env.STEAM_KEY}&steamid=${sid}&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`);
  if (r.status === 401 || r.status === 403) return reply({ error: 'Steam rejected the API key. Check STEAM_KEY' }, 502);
  if (!r.ok) return reply({ error: `Steam returned ${r.status}` }, 502);
  const j = await r.json();
  const owned = (j.response && j.response.games) || null;
  if (!owned) return reply({ error: 'Steam returned no games. Set Steam > Privacy Settings > Game details to Public' }, 403);

  // Take extra candidates so demos can be dropped and still leave `limit` games
  const recent = owned.filter(g => g.rtime_last_played > 0)
    .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
    .filter(g => !DEMO_NAME.test(g.name || ''))
    .slice(0, limit * 3);
  const art = await steamArt(recent.map(g => g.appid));
  const out = recent
    .filter(g => !(art[g.appid] && art[g.appid].type === DEMO_TYPE))
    .slice(0, limit)
    .map(g => {
      const a = art[g.appid] || {};
      return {
        id: g.appid, name: g.name,
        minutes: g.playtime_forever || 0,
        recentMinutes: g.playtime_2weeks || 0,
        lastPlayed: g.rtime_last_played,
        cover: a.cover || '', hero: a.hero || '', header: a.header || ''
      };
    });
  return reply(out);
}

/* ---------- Steam achievements ---------- */
async function getJSON(u) {
  const r = await fetch(u);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, j };
}

async function steamAchievements(env, appid) {
  if (!env.STEAM_KEY || !env.STEAM_ID) return reply({ error: 'server not configured: missing STEAM_KEY or STEAM_ID' }, 500);
  if (!/^\d+$/.test(appid)) return reply({ error: 'appid must be a number' }, 400);
  let sid;
  try { sid = await steamId64(env); } catch (e) { return reply({ error: e.message }, 400); }
  const K = env.STEAM_KEY;
  const [schema, mine, global] = await Promise.all([
    getJSON(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${K}&appid=${appid}&l=english`),
    getJSON(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${K}&steamid=${sid}&appid=${appid}`),
    getJSON(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`)
  ]);
  const defs = (schema.j && schema.j.game && schema.j.game.availableGameStats && schema.j.game.availableGameStats.achievements) || [];
  if (!defs.length) return reply({ appid: +appid, total: 0, unlocked: 0, items: [] });

  const ps = mine.j && mine.j.playerstats;
  if (!ps || ps.success === false) {
    const msg = (ps && ps.error) || '';
    if (mine.status === 403 || /private/i.test(msg)) return reply({ error: 'Steam says your game details are private. Set Privacy Settings > Game details to Public' }, 403);
    // Owned games with stats but no player record yet: treat as nothing unlocked
  }
  const got = {};
  for (const a of (ps && ps.achievements) || []) got[a.apiname] = a;
  const pct = {};
  for (const a of (global.j && global.j.achievementpercentages && global.j.achievementpercentages.achievements) || []) pct[a.name] = Math.round(parseFloat(a.percent) * 10) / 10;

  const items = defs.map(d => {
    const m = got[d.name];
    return {
      id: d.name, name: d.displayName || d.name, desc: d.description || '',
      icon: d.icon || '', hidden: d.hidden === 1,
      done: !!(m && m.achieved), time: (m && m.unlocktime) || 0,
      pct: pct[d.name] !== undefined ? pct[d.name] : null
    };
  });
  return reply({ appid: +appid, total: items.length, unlocked: items.filter(i => i.done).length, items });
}

/* ---------- Steam news / patch notes ---------- */
const BB_TAGS = 'h[1-6]|b|i|u|s|strike|url|list|olist|quote|code|spoiler|noparse|hr|table|tr|td|th|p|center|\\*';
const BB_OPEN_CLOSE = new RegExp('\\[\\/?(?:' + BB_TAGS + ')(?:=[^\\]]*)?\\]', 'gi');
const PATCH_TITLE = /\b(patch|hotfix|hot fix|update|changelog|change log|release notes|bug ?fix(?:es)?|v?\d+\.\d+(?:\.\d+)?)\b/i;

function cleanBB(s) {
  return String(s || '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, '')
    .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\*\]/g, '\n• ')
    .replace(/\[\/(?:h[1-6]|p|list|olist|quote|code|tr)\]/gi, '\n')
    .replace(/\[br\]/gi, '\n')
    .replace(BB_OPEN_CLOSE, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function excerpt(text, max) {
  if (text.length <= max) return { text, more: false };
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return { text: cut.slice(0, at > max * 0.6 ? at : max).trim() + '…', more: true };
}

async function steamNews(appid, count) {
  if (!/^\d+$/.test(appid)) return reply({ error: 'appid must be a number' }, 400);
  const r = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${count}&maxlength=0&format=json`);
  if (!r.ok) return reply({ error: `Steam returned ${r.status}` }, 502);
  const j = await r.json();
  const raw = (j.appnews && j.appnews.newsitems) || [];
  const items = raw.map(n => {
    const body = cleanBB(n.contents);
    const ex = excerpt(body, 520);
    const tags = Array.isArray(n.tags) ? n.tags : [];
    // Steam only tags some posts, so fall back to the title. That fallback is a guess.
    const patch = tags.includes('patchnotes') || PATCH_TITLE.test(n.title || '');
    return {
      id: String(n.gid), title: n.title || 'Untitled', url: n.url || '',
      label: n.feedlabel || '', date: n.date || 0,
      kind: patch ? 'patch' : 'news',
      excerpt: ex.text, more: ex.more
    };
  }).sort((a, b) => b.date - a.date);
  return reply({ appid: +appid, items });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.STATE) return reply({ error: 'server not configured: missing STATE binding' }, 500);
    if (!env.SECRET) return reply({ error: 'server not configured: missing SECRET' }, 500);

    const url = new URL(request.url);
    const given = (request.headers.get('x-sync-key') || url.searchParams.get('k') || '').trim();
    if (!keyMatches(given, String(env.SECRET).trim())) return reply({ error: 'unauthorized' }, 401);

    if (url.pathname === '/steam/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return reply([]);
      const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`);
      const j = await r.json();
      const items = (j.items || []).slice(0, 6);
      const art = await steamArt(items.map(i => i.id));
      return reply(items.map(i => Object.assign({ id: i.id, name: i.name, thumb: i.tiny_image }, art[i.id] || {})));
    }

    if (url.pathname === '/steam/library') {
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit'), 10) || 10));
      try { return await steamLibrary(env, limit); }
      catch (e) { return reply({ error: 'Steam request failed: ' + e.message }, 502); }
    }

    if (url.pathname === '/steam/achievements') {
      try { return await steamAchievements(env, (url.searchParams.get('appid') || '').trim()); }
      catch (e) { return reply({ error: 'Steam request failed: ' + e.message }, 502); }
    }

    if (url.pathname === '/steam/news') {
      const count = Math.max(1, Math.min(30, parseInt(url.searchParams.get('count'), 10) || 15));
      try { return await steamNews((url.searchParams.get('appid') || '').trim(), count); }
      catch (e) { return reply({ error: 'Steam request failed: ' + e.message }, 502); }
    }

    if (url.pathname !== '/') return reply({ error: 'not found' }, 404);

    if (request.method === 'GET') {
      const stored = await env.STATE.get(KEYNAME);
      return new Response(stored || 'null', { headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS) });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return reply({ error: 'payload too large' }, 413);
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { return reply({ error: 'body is not valid JSON' }, 400); }
      if (!parsed || !Array.isArray(parsed.games)) return reply({ error: 'not a Game Log library' }, 400);

      const stored = await env.STATE.get(KEYNAME);
      if (stored) {
        let cur = null; try { cur = JSON.parse(stored); } catch (e) {}
        const force = url.searchParams.get('force') === '1';
        if (!force && cur && (cur.mtime || 0) > (parsed.mtime || 0)) {
          return new Response(stored, { status: 409, headers: Object.assign({ 'content-type': 'application/json' }, CORS) });
        }
        await env.STATE.put(PREV, stored);
      }
      await env.STATE.put(KEYNAME, body);
      return reply({ ok: true, bytes: body.length, mtime: parsed.mtime || null });
    }

    return reply({ error: 'method not allowed' }, 405);
  }
};
