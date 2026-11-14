// login-track.js — Netlify Function
// Records one row in crm_login_log each time someone signs in to the CRM.
//  - WHO: taken from the caller's own Supabase session token (never from anything typed or sent in the body)
//  - IP : the real connection IP as seen by Netlify (cannot be faked by the browser)
//  - WHERE: approximate location from the IP (Netlify geo if present, otherwise a free IP lookup)
//  - Nothing secret is stored: no password, no token. The token is only used to act as the user for one insert.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qyubbieikviesfcorusq.supabase.co';

function parseUA(ua) {
  ua = ua || '';
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge ' + ((ua.match(/Edg\/(\d+)/) || [])[1] || '');
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome ' + ((ua.match(/Chrome\/(\d+)/) || [])[1] || '');
  else if (/Firefox\//.test(ua)) browser = 'Firefox ' + ((ua.match(/Firefox\/(\d+)/) || [])[1] || '');
  else if (/Safari\//.test(ua)) browser = 'Safari ' + ((ua.match(/Version\/(\d+)/) || [])[1] || '');
  let os = 'Unknown';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const device = /Mobi|Android|iPhone/.test(ua) ? 'Mobile' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Desktop';
  return { browser: browser.trim(), os, device };
}

async function lookupGeo(ip) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(ip), { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.success !== false) return { country: j.country || null, region: j.region || null, city: j.city || null, source: 'ipwho.is' };
  } catch (e) { /* geo is best-effort */ }
  return { country: null, region: null, city: null, source: null };
}

exports.handler = async (event, context) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* ignore */ }
  const anon = process.env.SUPABASE_ANON_KEY || body.k;
  if (!jwt || !anon) return reply(401, { error: 'Not signed in' });
  const H = { apikey: anon, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };

  try {
    // who is this? (the token must be valid — Supabase checks it)
    const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: H });
    if (!u.ok) return reply(401, { error: 'Invalid session' });
    const au = await u.json();
    const q = await fetch(SUPABASE_URL + '/rest/v1/crm_users?select=id,name,username,role&auth_uid=eq.' + encodeURIComponent(au.id) + '&limit=1', { headers: H });
    const rows = await q.json();
    if (!Array.isArray(rows) || !rows.length) return reply(403, { error: 'No CRM account' });
    const me = rows[0];

    const h = event.headers || {};
    const ip = (h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || h['client-ip'] || '').trim() || null;
    let geo = { country: null, region: null, city: null, source: null };
    try {
      const g = context && context.geo ? context.geo : (h['x-nf-geo'] ? JSON.parse(Buffer.from(h['x-nf-geo'], 'base64').toString('utf8')) : null);
      if (g && (g.country || g.city)) geo = { country: (g.country && (g.country.name || g.country)) || null, region: (g.subdivision && (g.subdivision.name || g.subdivision)) || null, city: g.city || null, source: 'netlify' };
    } catch (e) { /* fall through to lookup */ }
    if (!geo.country && ip) geo = await lookupGeo(ip);

    const ua = (h['user-agent'] || '').slice(0, 400);
    const p = parseUA(ua);
    const row = { user_id: me.id, agent_name: me.name, username: me.username, role: me.role, ip, country: geo.country, region: geo.region, city: geo.city, device: p.device, browser: p.browser, os: p.os, user_agent: ua, geo_source: geo.source, last_seen: new Date().toISOString() };
    const ins = await fetch(SUPABASE_URL + '/rest/v1/crm_login_log?select=id', { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!ins.ok) return reply(500, { error: 'Could not save', detail: (await ins.text()).slice(0, 200) });
    let id = null; try { const j = await ins.json(); id = j && j[0] && j[0].id; } catch (e) { /* id is optional */ }
    return reply(200, { ok: true, id });
  } catch (e) {
    return reply(500, { error: String(e && e.message || e) });
  }
};
