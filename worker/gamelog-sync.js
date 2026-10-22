/* =========================================================
   Game Log — sync + Steam data endpoint
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
   5. Settings > Trigger Events > Add > Cron Triggers
        Schedule: 0,30 * * * *     (every 30 minutes, on :00 and :30)
      This is the background refresher. Without it, Steam data still
      loads, but only when you open a game.
   5b. Add a SECOND Cron Trigger for play-time tracking:
        Schedule: * * * * *        (every minute)
      Each tick asks Steam whether you're in a game and logs when a game
      opens and closes. It costs one Steam call a minute and only writes
      to KV when a session starts or ends. Without it, Game Log still
      works but can't time your sessions.
   6. Deploy again, then paste the Worker URL and the secret into
      Game Log's Sync panel.
   7. Steam > Profile > Edit Profile > Privacy Settings:
        Game details = Public  (the Web API can't read playtime otherwise)

   Optional: Type: Text  Name: STEAM_BUDGET  Value: 40
      How many Steam calls one background run may make. The free plan
      allows 50 per run, so 40 leaves headroom. On the paid plan you can
      raise it (e.g. 150) and the first fill finishes much faster.
      Going much higher risks Steam rate-limiting the store API.

   Opening the URL in a browser should return {"error":"unauthorized"}.

   HOW STEAM DATA STAYS CURRENT
   Every game's store page, achievements and news are saved in KV under
   one key per game ("g:<appid>"). Requests are answered from that copy
   while it's fresh and only go to Steam when it's stale. The cron run
   refreshes your owned-games list, then works through whatever is
   missing or stale (never-loaded games first, then most recently
   played), stopping when it hits its call budget. It picks up where it
   left off next run. A small index ("idx") holds per-game timestamps and
   summaries so the app can show achievement progress and "New since you
   left" for the whole library with one request.

   ROUTES (all need the x-sync-key header)
   GET  /                 -> the saved library JSON (or null)
   PUT  /                 -> save library. Refused with 409 if the stored
                             copy is newer, so a stale device can't
                             overwrite fresher data. The previous copy is
                             kept under "state-prev" as a safety net.
   GET  /steam/search?q=  -> up to 6 Steam matches with cover art URLs
   GET  /steam/library?limit=10   most recently played games
   GET  /steam/library?all=1      every owned game (demos left out)
   GET  /steam/achievements?appid=[&fresh=1]
   GET  /steam/news?appid=&count=15[&fresh=1]
   GET  /steam/store?appid=[&fresh=1]
                          -> served from the cache when fresh;
                             fresh=1 skips the cache
   GET  /steam/play       -> { now, sessions } what you're playing right
                             now (or null) and your recent sessions, each
                             { a: appid, n: name, s: start ms, e: end ms }
   GET  /steam/summary    -> per-game achievement counts and recent news
                             dates for the whole library, plus how much of
                             the library is loaded and when the background
                             refresher last ran
   POST /steam/refresh    -> run one background batch now (at most once
                             a minute)
   ========================================================= */

const KEYNAME = 'state';
const PREV = 'state-prev';
const MAX_BYTES = 1024 * 1024;
const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LIB_MAX_AGE = 10 * MIN;            // owned-games list
const KINDS = ['store', 'ach', 'news'];
const COST = { store: 4, ach: 3, news: 1 }; // worst-case Steam calls per refresh
const DEMAND_TTL = { store: 3 * DAY, ach: 30 * MIN, news: HOUR }; // when you open a game
const RETRY_AFTER_ERROR = 2 * HOUR;
const DEFAULT_BUDGET = 40;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-sync-key',
  'Access-Control-Max-Age': '86400'
};

function reply(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS)
  });
}

class StErr extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

function keyMatches(given, want) {
  let ok = given.length === want.length;
  for (let i = 0; i < Math.max(given.length, want.length); i++) {
    if (given.charCodeAt(i) !== want.charCodeAt(i)) ok = false;
  }
  return ok;
}

/* ---------- Counted fetch ----------
   Every Steam call goes through net.get so a background run can stop
   before Cloudflare's per-run subrequest limit. */
function makeNet(budget) {
  const net = {
    used: 0, budget: budget || Infinity,
    left() { return net.budget - net.used; },
    async get(u) {
      net.used++;
      const r = await fetch(u);
      if (r.status === 429) throw new StErr('Steam is rate-limiting requests right now', 429);
      let j = null; try { j = await r.json(); } catch (e) {}
      return { status: r.status, ok: r.ok, j };
    }
  };
  return net;
}

async function kvJSON(env, key) {
  const s = await env.STATE.get(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
const kvPut = (env, key, val) => env.STATE.put(key, JSON.stringify(val));

/* ---------- Art ----------
   Steam's newer art lives at hashed paths, so the filename has to be
   looked up rather than guessed. GetItems returns it in batches. */
async function steamArt(net, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (net.left() < 1) break;
    try {
      const input = { ids: chunk.map(appid => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true, include_basic_info: true } };
      const { j } = await net.get('https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=' + encodeURIComponent(JSON.stringify(input)));
      for (const id of chunk) out[id] = { cover: '', hero: '', header: '' }; // asked, even if Steam has nothing
      for (const it of (j && j.response && j.response.store_items) || []) {
        const a = it.assets;
        const u = f => f && a && a.asset_url_format ? ASSET_BASE + a.asset_url_format.replace('${FILENAME}', f) : '';
        out[it.appid] = {
          type: it.type, name: it.name,
          cover: u(a && (a.library_capsule_2x || a.library_capsule)),
          hero: u(a && (a.library_hero_2x || a.library_hero)),
          header: u(a && a.header)
        };
      }
    } catch (e) { if (e.status === 429) throw e; }
  }
  return out;
}

// appdetails fallback for a landscape header when GetItems had no art
async function headerFallback(net, ids, max) {
  const out = {};
  for (const id of ids.slice(0, max)) {
    if (net.left() < 1) break;
    try {
      const { j } = await net.get(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`);
      const d = j && j[id] && j[id].success && j[id].data;
      out[id] = (d && d.header_image) || '';
    } catch (e) { if (e.status === 429) throw e; out[id] = ''; }
  }
  return out;
}

/* ---------- Steam library ---------- */
const DEMO_TYPE = 1; // EStoreAppType: 0 game, 1 demo, 4 DLC, 6 tool ...
const DEMO_NAME = /\b(demo|playtest|prologue demo|benchmark)\b/i;
const isDemo = g => g.type === DEMO_TYPE || DEMO_NAME.test(g.name || '');

function needSteam(env) {
  if (!env.STEAM_KEY) throw new StErr('server not configured: missing STEAM_KEY', 500);
  if (!env.STEAM_ID) throw new StErr('server not configured: missing STEAM_ID', 500);
}

async function steamId64(env, net) {
  const raw = String(env.STEAM_ID || '').trim()
    .replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '').replace(/\/+$/, '');
  if (/^\d{17}$/.test(raw)) return raw;
  const saved = await kvJSON(env, 'sid');
  if (saved && saved.raw === raw && saved.id) return saved.id;
  const { j } = await net.get(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${env.STEAM_KEY}&vanityurl=${encodeURIComponent(raw)}`);
  if (j && j.response && j.response.success === 1) { await kvPut(env, 'sid', { raw, id: j.response.steamid }); return j.response.steamid; }
  throw new StErr(`couldn't find a Steam profile called "${raw}". Set STEAM_ID to your SteamID64 or custom profile name`, 400);
}

/* Owned games, cached as "lib". Art is looked up once per new game and
   carried forward, so a refresh normally costs one Steam call. */
async function getLib(env, net, maxAge) {
  const lib = await kvJSON(env, 'lib');
  if (lib && Date.now() - lib.t < maxAge) return lib;
  needSteam(env);
  const sid = await steamId64(env, net);
  const r = await net.get(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${env.STEAM_KEY}&steamid=${sid}&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`);
  if (r.status === 401 || r.status === 403) throw new StErr('Steam rejected the API key. Check STEAM_KEY', 502);
  if (!r.ok) throw new StErr(`Steam returned ${r.status}`, 502);
  const owned = (r.j && r.j.response && r.j.response.games) || null;
  if (!owned) throw new StErr('Steam returned no games. Set Steam > Privacy Settings > Game details to Public', 403);

  const prev = {};
  for (const g of (lib && lib.games) || []) prev[g.id] = g;
  const newIds = owned.map(g => g.appid).filter(id => !prev[id] || !prev[id].artDone);
  const art = newIds.length ? await steamArt(net, newIds) : {};
  const noArt = newIds.filter(id => !(art[id] && (art[id].cover || art[id].header)));
  const hdr = noArt.length ? await headerFallback(net, noArt, 8) : {};

  const games = owned.map(o => {
    const p = prev[o.appid] || {};
    const a = art[o.appid];
    const g = {
      id: o.appid, name: o.name,
      minutes: o.playtime_forever || 0,
      recentMinutes: o.playtime_2weeks || 0,
      lastPlayed: o.rtime_last_played || 0,
      type: a && a.type !== undefined ? a.type : p.type,
      cover: (a && a.cover) || p.cover || '',
      hero: (a && a.hero) || p.hero || '',
      header: (a && a.header) || hdr[o.appid] || p.header || '',
      artDone: !!(p.artDone || (a && (a.cover || a.header)) || o.appid in hdr)
    };
    return g;
  });
  const next = { t: Date.now(), games };
  // Only write when something changed, to save KV writes
  const sig = x => (x.games || []).map(g => [g.id, g.minutes, g.lastPlayed, g.artDone ? 1 : 0].join(':')).join('|');
  if (!lib || sig(lib) !== sig(next) || Date.now() - lib.t > 6 * HOUR) await kvPut(env, 'lib', next);
  return next;
}

const libOut = g => ({ id: g.id, name: g.name, minutes: g.minutes, recentMinutes: g.recentMinutes, lastPlayed: g.lastPlayed, cover: g.cover, hero: g.hero, header: g.header });

async function steamLibrary(env, opts) {
  const net = makeNet();
  const lib = await getLib(env, net, LIB_MAX_AGE);
  let games = lib.games.filter(g => !isDemo(g));
  if (opts.all) {
    games.sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));
  } else {
    games = games.filter(g => g.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, opts.limit);
  }
  return games.map(libOut);
}

/* ---------- Achievements ---------- */
async function achData(env, net, appid) {
  needSteam(env);
  const sid = await steamId64(env, net);
  const K = env.STEAM_KEY;
  const schema = await net.get(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${K}&appid=${appid}&l=english`);
  const defs = (schema.j && schema.j.game && schema.j.game.availableGameStats && schema.j.game.availableGameStats.achievements) || [];
  if (!defs.length) return { appid: +appid, total: 0, unlocked: 0, items: [] };
  const [mine, global] = await Promise.all([
    net.get(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${K}&steamid=${sid}&appid=${appid}`),
    net.get(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`)
  ]);

  const ps = mine.j && mine.j.playerstats;
  if (!ps || ps.success === false) {
    const msg = (ps && ps.error) || '';
    if (mine.status === 403 || /private/i.test(msg)) throw new StErr('Steam says your game details are private. Set Privacy Settings > Game details to Public', 403);
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
  return { appid: +appid, total: items.length, unlocked: items.filter(i => i.done).length, items };
}

/* ---------- News / patch notes ---------- */
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

const OFFICIAL_FEED = 'steam_community_announcements';
const NEWS_KEEP = 30;

async function newsData(net, appid) {
  const r = await net.get(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${NEWS_KEEP}&maxlength=0&feeds=${OFFICIAL_FEED}&format=json`);
  if (!r.ok) throw new StErr(`Steam returned ${r.status}`, 502);
  // Steam also mixes in third-party sites that mention the game, so keep only the developer's own posts
  const raw = ((r.j && r.j.appnews && r.j.appnews.newsitems) || []).filter(n => n.feedname === OFFICIAL_FEED);
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
  return { appid: +appid, items };
}

/* ---------- Store page ---------- */
function htmlText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|ul|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&reg;/g, '®').replace(/&trade;/g, '™').replace(/&copy;/g, '©')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// "<li><strong>OS:</strong> Windows 11</li>" -> [{k:'OS', v:'Windows 11'}]
function reqList(html) {
  if (!html) return [];
  return String(html).split(/<li[^>]*>/i).slice(1).map(part => {
    const t = htmlText(part).replace(/\n+/g, ' ').trim();
    const i = t.indexOf(':');
    return i > 0 && i < 40 ? { k: t.slice(0, i).trim(), v: t.slice(i + 1).trim() } : { k: '', v: t };
  }).filter(r => r.v);
}

function trailerSrc(m) {
  const pick = o => o && (o.max || o['480'] || '');
  return { mp4: pick(m.mp4), webm: pick(m.webm), hls: m.hls_h264 || '' };
}

async function storeData(net, appid) {
  const [det, rev] = await Promise.all([
    net.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=US`),
    net.get(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0&filter=summary`)
  ]);
  if (!det.ok) throw new StErr(`Steam returned ${det.status}`, 502);
  const d = det.j && det.j[appid] && det.j[appid].success && det.j[appid].data;
  if (!d) throw new StErr('Steam has no store page for this game (it may be delisted or region-locked)', 404);

  const qs = rev.j && rev.j.query_summary;
  const reviews = qs && qs.total_reviews ? {
    label: qs.review_score_desc || '', total: qs.total_reviews,
    pct: Math.round(qs.total_positive / qs.total_reviews * 100)
  } : null;

  const p = d.price_overview;
  const price = d.is_free ? { free: true } : p ? {
    final: p.final_formatted || '', initial: p.initial_formatted || '', discount: p.discount_percent || 0
  } : null;

  // DLC names, release dates and prices (first 30)
  const dlcIds = (d.dlc || []).slice(0, 30);
  let dlc = [];
  if (dlcIds.length) {
    const input = { ids: dlcIds.map(id => ({ appid: id })), context: { language: 'english', country_code: 'US' }, data_request: { include_basic_info: true, include_release: true } };
    const [items, prices] = await Promise.all([
      net.get('https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=' + encodeURIComponent(JSON.stringify(input))),
      net.get(`https://store.steampowered.com/api/appdetails?appids=${dlcIds.join(',')}&filters=price_overview&cc=US`)
    ]);
    const byId = {};
    for (const it of (items.j && items.j.response && items.j.response.store_items) || []) byId[it.appid || it.id] = it;
    dlc = dlcIds.map(id => {
      const it = byId[id] || {};
      const r = it.release || {};
      const pp = prices.j && prices.j[id] && prices.j[id].success && prices.j[id].data;
      const po = pp && !Array.isArray(pp) && pp.price_overview;
      return {
        id, name: it.name || '',
        date: r.steam_release_date || r.original_release_date || 0,
        soon: !!r.is_coming_soon, soonText: r.coming_soon_display || '',
        price: po ? po.final_formatted : ''
      };
    }).filter(x => x.name).sort((a, b) => (b.date || 9e9) - (a.date || 9e9));
  }

  const about = htmlText(d.about_the_game || d.detailed_description);
  return {
    appid: +appid, name: d.name || '', type: d.type || '',
    short: htmlText(d.short_description),
    about: about.length > 6000 ? about.slice(0, 6000).replace(/\s+\S*$/, '') + '…' : about,
    developers: d.developers || [], publishers: d.publishers || [],
    release: d.release_date ? { date: d.release_date.date || '', soon: !!d.release_date.coming_soon } : null,
    genres: (d.genres || []).map(g => g.description),
    features: (d.categories || []).map(c => c.description),
    controller: d.controller_support || '',
    platforms: Object.keys(d.platforms || {}).filter(k => d.platforms[k]),
    metacritic: d.metacritic ? { score: d.metacritic.score, url: d.metacritic.url || '' } : null,
    reviews, price,
    achievements: (d.achievements && d.achievements.total) || 0,
    website: d.website || '',
    languages: htmlText(d.supported_languages).replace(/\*/g, '').replace(/\n+/g, ' ').replace(/languages with full audio support/i, '').trim(),
    audioLangs: (String(d.supported_languages || '').match(/[^,<>]+?<strong>\*<\/strong>/g) || []).map(s => htmlText(s).replace(/\*/g, '').trim()),
    ageNote: d.content_descriptors && d.content_descriptors.notes ? htmlText(d.content_descriptors.notes) : '',
    reqMin: reqList(d.pc_requirements && d.pc_requirements.minimum),
    reqRec: reqList(d.pc_requirements && d.pc_requirements.recommended),
    header: d.header_image || '',
    shots: (d.screenshots || []).slice(0, 12).map(s => ({ thumb: s.path_thumbnail, full: s.path_full })),
    trailers: (d.movies || []).slice(0, 4).map(m => Object.assign({ name: m.name || 'Trailer', thumb: m.thumbnail || '' }, trailerSrc(m))),
    dlc, dlcTotal: (d.dlc || []).length
  };
}

const FETCHERS = {
  store: (env, net, id) => storeData(net, id),
  ach: (env, net, id) => achData(env, net, id),
  news: (env, net, id) => newsData(net, id)
};

/* ---------- Cache ----------
   g:<appid>  = { store:{t,d,e}, ach:{t,d,e}, news:{t,d,e} }
   idx        = { <appid>: { store:t, ach:t, news:t, at, ad, al, nd, se } }
                timestamps of the last attempt plus a small summary */
function summarize(entry, kind, rec) {
  if (kind === 'ach' && rec.d) {
    const last = rec.d.items.filter(i => i.done && i.time).sort((a, b) => b.time - a.time)[0];
    entry.at = rec.d.total; entry.ad = rec.d.unlocked;
    entry.al = last ? { name: last.name, time: last.time } : null;
  }
  if (kind === 'news' && rec.d) entry.nd = rec.d.items.slice(0, 8).map(i => i.date);
  if (kind === 'store') entry.se = rec.e && !rec.d ? 1 : 0;
}

// Background TTLs: busier games refresh more often
function bgTTL(kind, g, entry) {
  const age = g.lastPlayed ? Date.now() - g.lastPlayed * 1000 : Infinity;
  if (kind === 'store') return 7 * DAY;
  if (kind === 'ach') {
    if (entry.at === 0) return 14 * DAY;           // no achievements
    if (age < 14 * DAY) return 6 * HOUR;
    return g.lastPlayed ? 3 * DAY : 14 * DAY;       // achievements only change when you play
  }
  if (age < 90 * DAY) return 6 * HOUR;               // news
  return g.lastPlayed ? DAY : 3 * DAY;
}

async function refreshKind(env, net, appid, kind, rec) {
  try {
    rec[kind] = { t: Date.now(), d: await FETCHERS[kind](env, net, appid) };
  } catch (e) {
    if (e.status === 429 || e.status === 500) throw e;
    // keep the last good copy; try again in a couple of hours (store 404s wait the full week)
    const prev = rec[kind] || {};
    rec[kind] = { t: Date.now(), d: prev.d || null, e: e.message, retry: e.status === 404 ? 0 : RETRY_AFTER_ERROR };
  }
  return rec[kind];
}

// Serve one kind for one game, from the cache when it's fresh
async function cached(env, appid, kind, fresh) {
  if (!/^\d+$/.test(appid)) throw new StErr('appid must be a number', 400);
  const key = 'g:' + appid;
  const rec = (await kvJSON(env, key)) || {};
  const c = rec[kind];
  if (!fresh && c && c.d && Date.now() - c.t < DEMAND_TTL[kind]) return c.d;
  const net = makeNet();
  const r = await refreshKind(env, net, appid, kind, rec);
  if (!r.d) throw new StErr(r.e || 'Steam request failed', /no store page/.test(r.e || '') ? 404 : 502);
  await kvPut(env, key, rec);
  const idx = (await kvJSON(env, 'idx')) || {};
  const entry = idx[appid] = idx[appid] || {};
  entry[kind] = r.t; summarize(entry, kind, r);
  await kvPut(env, 'idx', idx);
  return r.d;
}

/* ---------- Background batch ---------- */
async function runBatch(env, why) {
  const meta = (await kvJSON(env, 'meta')) || {};
  const now = Date.now();
  if (meta.pauseUntil && meta.pauseUntil > now) return { skipped: 'Steam asked us to slow down. Resuming soon' };
  const net = makeNet(parseInt(env.STEAM_BUDGET, 10) || DEFAULT_BUDGET);
  let done = 0, stopped = '';
  const idx = (await kvJSON(env, 'idx')) || {};
  let lib;
  try {
    lib = await getLib(env, net, 25 * MIN);
    const games = lib.games.filter(g => !isDemo(g));
    const queue = [];
    for (const g of games) {
      const entry = idx[g.id] || {};
      const due = KINDS.filter(k => {
        if (!entry[k]) return true;
        const retry = entry[k + 'Retry'];
        return now - entry[k] > (retry || bgTTL(k, g, entry));
      });
      if (due.length) queue.push({ g, due, missing: due.some(k => !entry[k]) });
    }
    // never-loaded games first, then most recently played
    queue.sort((a, b) => (b.missing - a.missing) || (b.g.lastPlayed - a.g.lastPlayed));

    outer:
    for (const job of queue) {
      if (net.left() < 1) break;
      const key = 'g:' + job.g.id;
      const rec = (await kvJSON(env, key)) || {};
      const entry = idx[job.g.id] = idx[job.g.id] || {};
      let changed = false;
      for (const kind of job.due) {
        if (net.left() < COST[kind]) { if (changed) await kvPut(env, key, rec); break outer; }
        const r = await refreshKind(env, net, job.g.id, kind, rec);
        entry[kind] = r.t;
        if (r.retry) entry[kind + 'Retry'] = r.retry; else delete entry[kind + 'Retry'];
        summarize(entry, kind, r);
        changed = true; done++;
      }
      if (changed) await kvPut(env, key, rec);
    }
    meta.left = queue.reduce((n, j) => n + j.due.length, 0) - done;
  } catch (e) {
    stopped = e.message;
    if (e.status === 429) meta.pauseUntil = now + 15 * MIN;
  }
  if (done) await kvPut(env, 'idx', idx);
  meta.lastRun = now; meta.lastWhy = why; meta.lastDone = done; meta.lastCalls = net.used; meta.lastErr = stopped;
  if (why === 'cron') meta.lastCron = now;
  // Idle runs only check in every few hours, to save KV writes
  if (done || stopped || why !== 'cron' || !meta.lastSaved || now - meta.lastSaved > 3 * HOUR) {
    meta.lastSaved = now;
    await kvPut(env, 'meta', meta);
  }
  return { done, calls: net.used, left: meta.left, error: stopped };
}

async function summary(env) {
  const [idx, meta, lib] = await Promise.all([kvJSON(env, 'idx'), kvJSON(env, 'meta'), kvJSON(env, 'lib')]);
  const games = ((lib && lib.games) || []).filter(g => !isDemo(g));
  const I = idx || {};
  const out = {};
  let ready = 0;
  for (const g of games) {
    const e = I[g.id];
    if (!e) continue;
    if (KINDS.every(k => e[k])) ready++;
    out[g.id] = { ach: e.at === undefined ? null : { total: e.at, done: e.ad, last: e.al || null }, news: e.nd || [], noStore: !!e.se };
  }
  const M = meta || {};
  return {
    owned: games.length, ready, left: M.left === undefined ? null : M.left,
    lastRun: M.lastRun || 0, lastCron: M.lastCron || 0, lastErr: M.lastErr || '',
    paused: M.pauseUntil && M.pauseUntil > Date.now() ? M.pauseUntil : 0,
    games: out
  };
}


/* ---------- Play sessions ----------
   A once-a-minute cron asks Steam whether you're in a game. State lives in
   KV under "play" (the open session) and "sessions" (finished ones). KV is
   only written when a session opens or closes, so a day of playing costs a
   handful of writes. Steam can briefly report "not in a game" while a game
   is still running, so a session only closes after two quiet ticks in a
   row; its end time is the first quiet tick, so it's accurate to ~1 min.
   Works for anything Steam launches, including non-Steam shortcuts added
   to Steam. Games started outside Steam aren't visible to it. Steam also
   hides in-game status when your profile is Invisible/Offline or Game
   details isn't Public. */
const SESS_KEEP = 300;
const MIN_SESSION = MIN;                 // shorter blips are ignored

async function closeSession(env, play, end) {
  if (end - play.s < MIN_SESSION) return;
  const list = (await kvJSON(env, 'sessions')) || [];
  list.push({ a: play.a, n: play.n, s: play.s, e: end });
  await kvPut(env, 'sessions', list.slice(-SESS_KEEP));
}

async function checkPlaying(env) {
  needSteam(env);
  const now = Date.now();
  const net = makeNet();
  const sid = await steamId64(env, net);
  const r = await net.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_KEY}&steamids=${sid}`);
  if (!r.ok) throw new StErr(`Steam returned ${r.status}`, 502);
  const me = r.j && r.j.response && r.j.response.players && r.j.response.players[0];
  if (!me) return { error: 'Steam returned no profile' };
  const cur = await kvJSON(env, 'play');
  const appid = me.gameid ? parseInt(me.gameid, 10) : 0;

  if (appid) {
    const name = me.gameextrainfo || '';
    if (cur && cur.a === appid) {
      if (cur.miss) { delete cur.miss; await kvPut(env, 'play', cur); }   // false alarm, still playing
      return { playing: cur };
    }
    if (cur) await closeSession(env, cur, cur.miss || now);              // switched games
    const open = { a: appid, n: name, s: now };
    await kvPut(env, 'play', open);
    return { playing: open };
  }
  if (!cur) return { playing: null };
  if (!cur.miss) { cur.miss = now; await kvPut(env, 'play', cur); return { playing: cur }; }
  await closeSession(env, cur, cur.miss);
  await env.STATE.delete('play');
  return { playing: null };
}

async function playData(env) {
  const [cur, sessions] = await Promise.all([kvJSON(env, 'play'), kvJSON(env, 'sessions')]);
  return {
    now: cur ? { a: cur.a, n: cur.n, s: cur.s } : null,
    sessions: (sessions || []).slice(-100),
    t: Date.now()
  };
}

/* ---------- Router ---------- */
async function steamRoute(request, env, url) {
  const p = url.pathname, q = k => (url.searchParams.get(k) || '').trim();
  const fresh = q('fresh') === '1';

  if (p === '/steam/search') {
    const term = q('q');
    if (!term) return [];
    const net = makeNet();
    const { j } = await net.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`);
    const items = ((j && j.items) || []).slice(0, 6);
    const art = await steamArt(net, items.map(i => i.id));
    return items.map(i => Object.assign({ id: i.id, name: i.name, thumb: i.tiny_image }, art[i.id] || {}));
  }
  if (p === '/steam/library') {
    const limit = Math.max(1, Math.min(50, parseInt(q('limit'), 10) || 10));
    return steamLibrary(env, { all: q('all') === '1', limit });
  }
  if (p === '/steam/achievements') return cached(env, q('appid'), 'ach', fresh);
  if (p === '/steam/store') return cached(env, q('appid'), 'store', fresh);
  if (p === '/steam/news') {
    const count = Math.max(1, Math.min(NEWS_KEEP, parseInt(q('count'), 10) || 15));
    const d = await cached(env, q('appid'), 'news', fresh);
    return { appid: d.appid, items: d.items.slice(0, count) };
  }
  if (p === '/steam/play') return playData(env);
  if (p === '/steam/summary') return summary(env);
  if (p === '/steam/refresh') {
    if (request.method !== 'POST') throw new StErr('use POST', 405);
    const meta = (await kvJSON(env, 'meta')) || {};
    if (meta.lastRun && Date.now() - meta.lastRun < MIN) return { done: 0, wait: true };
    return runBatch(env, 'manual');
  }
  return undefined;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.STATE) return reply({ error: 'server not configured: missing STATE binding' }, 500);
    if (!env.SECRET) return reply({ error: 'server not configured: missing SECRET' }, 500);

    const url = new URL(request.url);
    const given = (request.headers.get('x-sync-key') || url.searchParams.get('k') || '').trim();
    if (!keyMatches(given, String(env.SECRET).trim())) return reply({ error: 'unauthorized' }, 401);

    if (url.pathname.startsWith('/steam/')) {
      try {
        const out = await steamRoute(request, env, url);
        return out === undefined ? reply({ error: 'not found' }, 404) : reply(out);
      } catch (e) {
        return reply({ error: e instanceof StErr ? e.message : 'Steam request failed: ' + e.message }, e.status || 502);
      }
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
  },

  // Cron Triggers: 0,30 * * * * runs the background refresher; * * * * * is the
  // per-minute play tracker. Every tick checks what you're playing, but only the
  // slower schedule does the heavy refresh.
  async scheduled(event, env, ctx) {
    if (!env.STATE) return;
    ctx.waitUntil(checkPlaying(env).catch(() => {}));
    const everyMinute = /^(\*|\*\/1)( \*){4}$/.test(String(event.cron || '').trim());
    if (!everyMinute) ctx.waitUntil(runBatch(env, 'cron'));
  }
};
