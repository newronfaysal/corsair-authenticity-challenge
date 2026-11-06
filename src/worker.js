// CORSAIR Authenticity Challenge — leaderboard API (Cloudflare Worker + D1)
//   GET  /api/start                -> { token }            (call when a round begins)
//   POST /api/score                -> { ok, rank, ... }    (call when a round ends)
//   GET  /api/leaderboard?period=week|all
//   GET  /api/admin/export?key=ADMIN_KEY  -> CSV incl. phone numbers (private)
// Secrets: SIGN_KEY (signs round tokens), ADMIN_KEY (protects the export).

const TZ_OFFSET_MS = 6 * 3600 * 1000;      // Bangladesh time (UTC+6)
const MAX_SCORE = 6000;
const MAX_SCORE_PER_SEC = 120;
const MIN_ROUND_SEC = 5;
const MAX_ROUND_SEC = 15 * 60;
const MAX_SUBMITS_PER_PHONE_PER_DAY = 40;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });

// Week key = date (YYYY-MM-DD, Bangladesh time) of the Monday that starts the week.
function weekInfo(now = Date.now()) {
  const d = new Date(now + TZ_OFFSET_MS);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  const next = mon.getTime() + 7 * 86400000 - TZ_OFFSET_MS; // real epoch of next Monday 00:00 BDT
  return { key: mon.toISOString().slice(0, 10), resetsAt: next };
}

const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function cleanName(v) {
  const n = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 24 ? n : null;
}
function cleanPhone(v) {
  let p = String(v || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+88')) p = p.slice(3); else if (p.startsWith('88') && p.length === 13) p = p.slice(2);
  return /^01[3-9]\d{8}$/.test(p) ? p : null;
}
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

async function handleStart(env) {
  const ts = Date.now(), rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const sig = await hmac(env.SIGN_KEY, ts + '.' + rnd);
  return json({ token: `${ts}.${rnd}.${sig}` });
}

async function handleScore(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  const name = cleanName(b.name), phone = cleanPhone(b.phone);
  if (!name) return json({ error: 'Please enter your name (2–24 characters).' }, 400);
  if (!phone) return json({ error: 'Enter a valid Bangladesh mobile number, e.g. 01XXXXXXXXX.' }, 400);
  if (b.consent !== true) return json({ error: 'Please tick the consent box to join the leaderboard.' }, 400);

  const parts = String(b.token || '').split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return json({ error: 'Invalid round. Play again to submit.' }, 400);
  const expected = await hmac(env.SIGN_KEY, parts[0] + '.' + parts[1]);
  if (!safeEq(expected, parts[2])) return json({ error: 'Invalid round. Play again to submit.' }, 400);

  const now = Date.now(), elapsed = (now - Number(parts[0])) / 1000;
  const score = int(b.score, MAX_SCORE + 1);
  if (elapsed < MIN_ROUND_SEC || elapsed > MAX_ROUND_SEC) return json({ error: 'This round has expired. Play again to submit.' }, 400);
  if (score > MAX_SCORE || score > elapsed * MAX_SCORE_PER_SEC) return json({ error: 'Score rejected.' }, 400);

  const day = await env.DB.prepare('SELECT COUNT(*) c FROM scores WHERE phone = ? AND created_at > ?').bind(phone, now - 86400000).first();
  if (day && day.c >= MAX_SUBMITS_PER_PHONE_PER_DAY) return json({ error: 'Daily submission limit reached. Try again tomorrow.' }, 429);

  const wk = weekInfo(now).key;
  try {
    await env.DB.prepare(
      'INSERT INTO scores (token, name, phone, phone_tail, score, caught, combo, week, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(parts[1], name, phone, phone.slice(-3), score, int(b.caught, 1000), int(b.combo, 1000), wk, now).run();
  } catch (e) {
    return json({ error: 'This round was already submitted.' }, 409);
  }

  const rank = async (week) => {
    const q = week
      ? env.DB.prepare('SELECT COUNT(*) c FROM (SELECT phone, MAX(score) m FROM scores WHERE week = ? GROUP BY phone) WHERE m > ?').bind(week, score)
      : env.DB.prepare('SELECT COUNT(*) c FROM (SELECT phone, MAX(score) m FROM scores GROUP BY phone) WHERE m > ?').bind(score);
    return ((await q.first()).c || 0) + 1;
  };
  return json({ ok: true, name, score, weekRank: await rank(wk), allRank: await rank(null) });
}

async function handleBoard(url, env) {
  const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
  const wk = weekInfo();
  const sel = 'SELECT s.name, s.phone_tail AS tail, s.score, s.caught, s.combo, s.created_at AS at FROM scores s';
  const stmt = period === 'week'
    ? env.DB.prepare(`${sel} WHERE s.week = ?1 AND s.id = (SELECT id FROM scores WHERE phone = s.phone AND week = ?1 ORDER BY score DESC, id ASC LIMIT 1) ORDER BY s.score DESC, s.id ASC LIMIT 25`).bind(wk.key)
    : env.DB.prepare(`${sel} WHERE s.id = (SELECT id FROM scores WHERE phone = s.phone ORDER BY score DESC, id ASC LIMIT 1) ORDER BY s.score DESC, s.id ASC LIMIT 25`);
  const { results } = await stmt.all();
  return json({ period, week: wk.key, resetsAt: wk.resetsAt, entries: results },
    200, { 'cache-control': 'public, max-age=15' });
}

async function handleExport(url, request, env) {
  const key = url.searchParams.get('key') || (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!env.ADMIN_KEY || !safeEq(key, env.ADMIN_KEY)) return json({ error: 'Unauthorized' }, 401);
  const { results } = await env.DB.prepare('SELECT id, name, phone, score, caught, combo, week, created_at FROM scores ORDER BY id').all();
  const esc = v => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const rows = ['id,name,phone,score,caught,combo,week,created_at_utc'];
  for (const r of results) rows.push([r.id, esc(r.name), esc(r.phone), r.score, r.caught, r.combo, r.week, new Date(r.created_at).toISOString()].join(','));
  return new Response(rows.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="corsair-leaderboard.csv"', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/start' && request.method === 'GET') return await handleStart(env);
      if (url.pathname === '/api/score' && request.method === 'POST') return await handleScore(request, env);
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') return await handleBoard(url, env);
      if (url.pathname === '/api/admin/export' && request.method === 'GET') return await handleExport(url, request, env);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error. Please try again.' }, 500);
    }
  }
};
