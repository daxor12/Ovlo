// OVLO server — npm i ws ; node server.js (Node 18+)
// ENV: BOT_TOKEN, APP_LINK (https://t.me/<bot>/<app>), CHANNEL (@Daxor_unit), PORT
// Without BOT_TOKEN it runs in dev mode (no auth / no force-join / no inline bot).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = process.env, TOKEN = E.BOT_TOKEN || '', CH = E.CHANNEL || '@Daxor_unit', LINK = E.APP_LINK || '', PORT = E.PORT || 3000;
const W = 400, H = 700, PR = 34, UR = 19, GOAL = 150, WIN = 7, TIME = 180, DT = 1 / 60, PMAX = 2200, VMAX = 1200;
const rooms = new Map(), ID = /^[\w-]{4,24}$/;
const api = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

function auth(init) {
  if (!TOKEN) return { id: 'dev' + Math.random().toString(36).slice(2, 8) };
  try {
    const p = new URLSearchParams(init), h = p.get('hash'); p.delete('hash');
    const s = [...p].map(([k, v]) => k + '=' + v).sort().join('\n');
    const k = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const c = crypto.createHmac('sha256', k).update(s).digest('hex');
    if (c !== h || Date.now() / 1000 - p.get('auth_date') > 86400) return null;
    return JSON.parse(p.get('user'));
  } catch { return null; }
}
async function member(uid) {
  if (!TOKEN) return true;
  const r = await api('getChatMember', { chat_id: CH, user_id: uid });
  return !!(r.ok && ['creator', 'administrator', 'member'].includes(r.result.status));
}

const mk = id => ({ id, pl: [null, null], ready: [0, 0], phase: 'wait', sc: [0, 0], t: TIME, pause: 0, k: 0, act: Date.now(), cd: 3, last: -1,
  pk: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, pd: [{ x: W / 2, y: H - 90, vx: 0, vy: 0, tx: W / 2, ty: H - 90 }, { x: W / 2, y: 90, vx: 0, vy: 0, tx: W / 2, ty: 90 }] });
const send = (r, o, i) => { const s = JSON.stringify(o); r.pl.forEach((p, k) => p && (i === undefined || i === k) && p.ws.readyState === 1 && p.ws.send(s)); };
const info = r => r.pl.forEach((p, i) => p && send(r, { t: 'room', idx: i, p: r.phase, n: r.pl.filter(Boolean).length, ready: r.ready }, i));
const rd = v => Math.round(v * 10) / 10;

function start(r) {
  r.phase = 'count'; r.cd = 3; r.last = -1; r.sc = [0, 0]; r.t = TIME; r.pause = 0; r.ready = [0, 0];
  r.pk = { x: W / 2, y: H / 2 + (Math.random() < .5 ? 110 : -110), vx: 0, vy: 0 };
  r.pd[0].x = r.pd[0].tx = W / 2; r.pd[0].y = r.pd[0].ty = H - 90;
  r.pd[1].x = r.pd[1].tx = W / 2; r.pd[1].y = r.pd[1].ty = 90;
}
function end(r) { r.phase = 'over'; r.ready = [0, 0]; send(r, { t: 'over', sc: r.sc, w: r.sc[0] > r.sc[1] ? 0 : 1 }); }
function goal(r, i) {
  r.sc[i]++; send(r, { t: 'goal', by: i, sc: r.sc });
  if (r.sc[i] >= WIN || r.t <= 0) return end(r);
  r.pk = { x: W / 2, y: i === 0 ? H / 2 - 110 : H / 2 + 110, vx: 0, vy: 0 }; r.pause = 1.2;
}
function movePads(r, dt) {
  r.pd.forEach((p, i) => {
    const y0 = i ? PR : H / 2 + PR, y1 = i ? H / 2 - PR : H - PR;
    const tx = Math.min(W - PR, Math.max(PR, p.tx)), ty = Math.min(y1, Math.max(y0, p.ty));
    p.x0 = p.x; p.y0 = p.y;
    const a = 1 - Math.exp(-28 * dt);
    let dx = (tx - p.x) * a, dy = (ty - p.y) * a; const d = Math.hypot(dx, dy), m = PMAX * dt;
    if (d > m) { dx *= m / d; dy *= m / d; }
    p.x += dx; p.y += dy;
    p.vx += (dx / dt - p.vx) * .5; p.vy += (dy / dt - p.vy) * .5;
  });
}
function hit(k, cx, cy, r, vx, vy, e) {
  let dx = k.x - cx, dy = k.y - cy, d = Math.hypot(dx, dy);
  if (d >= r) return;
  if (d < 1e-6) { dx = 0; dy = 1; d = 1; }
  const nx = dx / d, ny = dy / d; k.x = cx + nx * r; k.y = cy + ny * r;
  const rv = (k.vx - vx) * nx + (k.vy - vy) * ny;
  if (rv < 0) { k.vx -= (1 + e) * rv * nx; k.vy -= (1 + e) * rv * ny; }
  const sp = Math.hypot(k.vx, k.vy); if (sp > VMAX) { k.vx *= VMAX / sp; k.vy *= VMAX / sp; }
}
function puck(r, dt) {
  const k = r.pk, n = 4, h = dt / n, px = [W / 2 - GOAL / 2, W / 2 + GOAL / 2];
  for (let s = 0; s < n; s++) {
    k.x += k.vx * h; k.y += k.vy * h; const f = Math.exp(-.35 * h); k.vx *= f; k.vy *= f;
    const q = (s + 1) / n;
    r.pd.forEach(p => hit(k, p.x0 + (p.x - p.x0) * q, p.y0 + (p.y - p.y0) * q, PR + UR, p.vx, p.vy, .78));
    px.forEach(x => { hit(k, x, 0, UR, 0, 0, .9); hit(k, x, H, UR, 0, 0, .9); });
    if (k.x < UR) { k.x = UR; k.vx = Math.abs(k.vx) * .95; } else if (k.x > W - UR) { k.x = W - UR; k.vx = -Math.abs(k.vx) * .95; }
    if (Math.abs(k.x - W / 2) < GOAL / 2) continue;
    if (k.y < UR) { k.y = UR; k.vy = Math.abs(k.vy) * .95; } else if (k.y > H - UR) { k.y = H - UR; k.vy = -Math.abs(k.vy) * .95; }
  }
  if (k.y < -UR) goal(r, 0); else if (k.y > H + UR) goal(r, 1);
}
function step(r) {
  if (r.phase === 'count') {
    const n = Math.ceil(r.cd -= DT);
    if (n !== r.last) { r.last = n; send(r, { t: 'count', n: Math.max(n, 0) }); }
    if (r.cd <= 0) r.phase = 'play';
  }
  movePads(r, DT);
  if (r.phase === 'play') {
    if (r.pause > 0) r.pause -= DT;
    else { puck(r, DT); r.t = Math.max(0, r.t - DT); if (r.t <= 0 && r.phase === 'play' && r.sc[0] !== r.sc[1]) end(r); }
  }
  if (++r.k % 2 === 0 && (r.phase === 'play' || r.phase === 'count'))
    send(r, { t: 's', k: [rd(r.pk.x), rd(r.pk.y)], p: r.pd.map(p => [rd(p.x), rd(p.y)]), sc: r.sc, tm: Math.ceil(r.t) });
}
setInterval(() => { for (const r of rooms.values()) if (r.phase === 'count' || r.phase === 'play') step(r); }, 1000 / 60);
setInterval(() => { for (const [k, r] of rooms) if (Date.now() - r.act > 18e5 || (!r.pl[0] && !r.pl[1] && Date.now() - r.act > 6e4)) rooms.delete(k); }, 6e4);

const err = c => JSON.stringify({ t: 'err', c });
const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); s.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); });
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 1024 });
wss.on('connection', ws => {
  let r = null, i = -1;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !r) {
      if (!ID.test(m.id)) return;
      const u = auth(m.init); if (!u) return ws.send(err('auth'));
      if (!await member(u.id)) return ws.send(err('member'));
      if (ws.readyState !== 1 || r) return;
      if (!rooms.has(m.id)) { if (rooms.size > 5000) return; rooms.set(m.id, mk(m.id)); }
      const room = rooms.get(m.id);
      let j = room.pl.findIndex(p => p && p.uid === u.id); if (j < 0) j = room.pl.findIndex(p => !p);
      if (j < 0) return ws.send(err('full'));
      if (room.pl[j]) try { room.pl[j].ws.close(); } catch { }
      r = room; i = j; r.pl[i] = { ws, uid: u.id }; r.act = Date.now(); info(r);
    } else if (!r) return;
    else if (m.t === 'm') {
      if (!(Number.isFinite(m.x) && Number.isFinite(m.y))) return;
      const p = r.pd[i]; p.tx = i ? W - m.x : m.x; p.ty = i ? H - m.y : m.y;
    } else if (m.t === 'ready' && (r.phase === 'wait' || r.phase === 'over') && r.pl[0] && r.pl[1]) {
      r.ready[i] = 1; r.act = Date.now();
      if (r.ready[0] && r.ready[1]) start(r); else info(r);
    }
  });
  ws.on('close', () => {
    if (!r || !r.pl[i] || r.pl[i].ws !== ws) return;
    r.pl[i] = null; r.ready = [0, 0]; r.act = Date.now();
    if (['count', 'play', 'over'].includes(r.phase)) { send(r, { t: 'left' }); rooms.delete(r.id); }
    else { r.phase = 'wait'; info(r); }
  });
});
srv.listen(PORT, () => console.log('OVLO on :' + PORT));

// Inline mode: "@Bot" (or "@Bot m_<id>" from the Mini App's Invite button)
async function poll() {
  let off = 0;
  for (; ;) {
    try {
      const r = await api('getUpdates', { offset: off, timeout: 30, allowed_updates: ['inline_query'] });
      for (const u of r.result || []) {
        off = u.update_id + 1; const q = u.inline_query; if (!q) continue;
        const m = /^m_([\w-]{4,24})$/.exec(q.query.trim()), id = m ? m[1] : crypto.randomBytes(5).toString('hex');
        api('answerInlineQuery', {
          inline_query_id: q.id, cache_time: 0, is_personal: true,
          results: [{ type: 'article', id, title: 'Play Air Hockey 🏒', description: 'OVLO',
            input_message_content: { message_text: '🏒 OVLO — Air Hockey\nI challenge you!' },
            reply_markup: { inline_keyboard: [[{ text: 'Play 🏒', url: `${LINK}?startapp=${id}` }]] } }]
        });
      }
    } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
}
if (TOKEN) poll();
