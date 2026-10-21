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
        Type: Secret   Name: SECRET   Value: a long random string you invent
   5. Deploy again, then paste the Worker URL and the secret into
      Game Log's Sync panel.

   Opening the URL in a browser should return {"error":"unauthorized"}.

   ROUTES (all need the x-sync-key header)
   GET  /                 -> the saved library JSON (or null)
   PUT  /                 -> save library. Refused with 409 if the stored
                             copy is newer, so a stale device can't
                             overwrite fresher data. The previous copy is
                             kept under "state-prev" as a safety net.
   GET  /steam/search?q=  -> up to 6 Steam matches with cover art URLs
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
    const input = { ids: ids.map(appid => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
    const r = await fetch('https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=' + encodeURIComponent(JSON.stringify(input)));
    const j = await r.json();
    for (const it of (j.response && j.response.store_items) || []) {
      const a = it.assets; if (!a || !a.asset_url_format) continue;
      const u = f => f ? ASSET_BASE + a.asset_url_format.replace('${FILENAME}', f) : '';
      out[it.appid] = {
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
