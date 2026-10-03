// OVLO server — npm i ws ; node server.js (Node 18+)
// ENV: BOT_TOKEN, APP_LINK (https://t.me/<bot>/<app>), CHANNEL (@Daxor_unit), PORT
// Without BOT_TOKEN it runs in dev mode (no auth / no force-join / no inline bot).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = process.env, TOKEN = E.BOT_TOKEN || '', CH = E.CHANNEL || '@Daxor_unit', LINK = E.APP_LINK || '', PORT = E.PORT || 3000;
// Physics constants are identical to the on-device engine in index.html (rounded corners, 120 Hz fixed step)
const W = 400, H = 700, PR = 34, UR = 19, GOAL = 150, CRN = 80, WIN = 7, TIME = 180, TK = 1 / 120, LP = 3200, VMAX = 1600, BOTWAIT = 15000, GRACE = 10000;
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
const mcache = new Map(); // uid -> expiry; only positive results are cached, so "Check Again" always re-asks Telegram
setInterval(() => { const t = Date.now(); for (const [k, v] of mcache) if (v < t) mcache.delete(k); }, 6e4);
async function member(uid) { // true / false / null (Telegram busy or unreachable)
  if (!TOKEN) return true;
  if ((mcache.get(uid) || 0) > Date.now()) return true;
  try {
    const r = await api('getChatMember', { chat_id: CH, user_id: uid });
    if (!r.ok && (r.error_code === 429 || r.error_code >= 500)) return null;
    const ok = !!(r.ok && ['creator', 'administrator', 'member'].includes(r.result.status));
    if (ok) mcache.set(uid, Date.now() + 6e5);
    return ok;
  } catch { return null; }
}

const mk = id => ({ id, pl: [null, null], ready: [0, 0], phase: 'wait', sc: [0, 0], t: TIME, pause: 0, k: 0, act: Date.now(), cd: 3, last: -1,
  pk: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, pd: [{ x: W / 2, y: H - 90, vx: 0, vy: 0, tx: W / 2, ty: H - 90 }, { x: W / 2, y: 90, vx: 0, vy: 0, tx: W / 2, ty: 90 }] });
const send = (r, o, i) => { const s = JSON.stringify(o); r.pl.forEach((p, k) => p && (i === undefined || i === k) && p.ws.readyState === 1 && p.ws.send(s)); };
const info = r => r.pl.forEach((p, i) => p && send(r, { t: 'room', idx: i, p: r.phase, n: r.pl.filter(Boolean).length, ready: r.ready, id: r.id }, i));
const rd = v => Math.round(v * 10) / 10;

function start(r) {
  r.bk = null; r.stk = 0; r.acc = 0; r.lt = 0; r.phase = 'count'; r.cd = 3; r.last = -1; r.sc = [0, 0]; r.t = TIME; r.pause = 0; r.ready = [0, 0];
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
function movePads(r, dt) { // same model as the on-device engine: straight at the target, capped at LP units/s
  r.pd.forEach((p, i) => {
    const y0 = i ? PR : H / 2 + PR, y1 = i ? H / 2 - PR : H - PR;
    const tx = Math.min(W - PR, Math.max(PR, p.tx)), ty = Math.min(y1, Math.max(y0, p.ty));
    p.x0 = p.x; p.y0 = p.y;
    let dx = tx - p.x, dy = ty - p.y; const d = Math.hypot(dx, dy), m = LP * dt;
    if (d > m) { dx *= m / d; dy *= m / d; }
    p.x += dx; p.y += dy;
    p.vx += (dx / dt - p.vx) * .35; p.vy += (dy / dt - p.vy) * .35;
  });
}
const cv = v => Math.max(-1800, Math.min(1800, v)); // paddle speed used in collisions
function hit(k, cx, cy, r, vx, vy, e, fr = 0) {
  let dx = k.x - cx, dy = k.y - cy, d = Math.hypot(dx, dy);
  if (d >= r) return;
  if (d < 1e-6) { dx = 0; dy = 1; d = 1; }
  const nx = dx / d, ny = dy / d; k.x = cx + nx * r; k.y = cy + ny * r;
  const rv = (k.vx - vx) * nx + (k.vy - vy) * ny;
  if (rv < 0) { k.vx -= (1 + e) * rv * nx; k.vy -= (1 + e) * rv * ny; }
  if (fr) { // light friction: a paddle sliding past the puck drags it along
    const ax = k.vx - vx, ay = k.vy - vy, an = ax * nx + ay * ny, tx = ax - an * nx, ty = ay - an * ny;
    k.vx -= tx * fr; k.vy -= ty * fr;
  }
  const sp = Math.hypot(k.vx, k.vy); if (sp > VMAX) { k.vx *= VMAX / sp; k.vy *= VMAX / sp; }
}
const CC = [[UR + CRN, UR + CRN], [W - UR - CRN, UR + CRN], [UR + CRN, H - UR - CRN], [W - UR - CRN, H - UR - CRN]]; // corner arc centres
function puck(r, dt) {
  const k = r.pk, n = 3, h = dt / n, px = [W / 2 - GOAL / 2, W / 2 + GOAL / 2];
  for (let s = 0; s < n; s++) {
    k.x += k.vx * h; k.y += k.vy * h; const f = Math.exp(-.35 * h); k.vx *= f; k.vy *= f;
    const q = (s + 1) / n;
    r.pd.forEach(p => hit(k, p.x0 + (p.x - p.x0) * q, p.y0 + (p.y - p.y0) * q, PR + UR, cv(p.vx), cv(p.vy), .8));
    px.forEach(x => { hit(k, x, 0, UR, 0, 0, .9); hit(k, x, H, UR, 0, 0, .9); });
    if (k.x < UR) { k.x = UR; k.vx = Math.abs(k.vx) * .95; } else if (k.x > W - UR) { k.x = W - UR; k.vx = -Math.abs(k.vx) * .95; }
    if (Math.abs(k.x - W / 2) < GOAL / 2) continue;
    if (k.y < UR) { k.y = UR; k.vy = Math.abs(k.vy) * .95; } else if (k.y > H - UR) { k.y = H - UR; k.vy = -Math.abs(k.vy) * .95; }
    for (const [ax, ay] of CC) { // rounded corners
      if (ax < W / 2 ? k.x >= ax : k.x <= ax) continue;
      if (ay < H / 2 ? k.y >= ay : k.y <= ay) continue;
      const dx = k.x - ax, dy = k.y - ay, d = Math.hypot(dx, dy); if (d <= CRN) continue;
      const nx = -dx / d, ny = -dy / d; k.x = ax + dx * CRN / d; k.y = ay + dy * CRN / d;
      const vn = k.vx * nx + k.vy * ny; if (vn < 0) { k.vx -= 1.95 * vn * nx; k.vy -= 1.95 * vn * ny; }
    }
  }
  // a puck resting in a corner gets pushed back to the middle
  const cr = Math.min(k.x, W - k.x) < 110 && Math.min(k.y, H - k.y) < 110;
  r.stk = cr && Math.hypot(k.vx, k.vy) < 40 ? (r.stk || 0) + dt : 0;
  if (r.stk > .8) { r.stk = 0; const dx = W / 2 - k.x, dy = H / 2 - k.y, dd = Math.hypot(dx, dy) || 1; k.vx = dx / dd * 380; k.vy = dy / dd * 380; }
  if (k.y < -UR) goal(r, 0); else if (k.y > H + UR) goal(r, 1);
}
function bot(r, dt) {
  const i = r.bi, b = r.pd[i], k = r.pk, s = i ? 1 : -1; // s=+1: bot defends y=0, attacks toward +y
  const B = r.bk || (r.bk = { x: k.x, y: k.y, ox: 0, t: 0 });
  const a = 1 - Math.exp(-6 * dt); B.x += (k.x - B.x) * a; B.y += (k.y - B.y) * a; // ~160ms reaction
  if ((B.t -= dt) <= 0) { B.t = .4; B.ox = (Math.random() - .5) * 28; }      // small aiming error
  const px = B.x + B.ox, py = B.y, mine = i ? py < H / 2 : py > H / 2;
  let tx, ty;
  if (mine) {
    if (s * (py - b.y) > 6) { tx = px; ty = py + s * 30; }                     // behind puck: drive through it
    else { tx = px + (b.x >= px ? 70 : -70); ty = py - s * 60; }               // go around to get behind it
  } else { tx = W / 2 + (px - W / 2) * .35; ty = i ? 95 : H - 95; }            // defend
  let dx = tx - b.x, dy = ty - b.y; const d = Math.hypot(dx, dy), m = 1000 * dt; // ~1000 u/s max
  if (d > m) { dx *= m / d; dy *= m / d; }
  b.tx = b.x + dx; b.ty = b.y + dy;
}
function tick(r, dt) {
  if (r.phase === 'count') {
    const n = Math.ceil(r.cd -= dt);
    if (n !== r.last) { r.last = n; send(r, { t: 'count', n: Math.max(n, 0) }); }
    if (r.cd <= 0) r.phase = 'play';
  }
  if (r.bot && r.phase === 'play') bot(r, dt);
  movePads(r, dt);
  if (r.phase === 'play') {
    if (r.pause > 0) r.pause -= dt;
    else { puck(r, dt); r.t = Math.max(0, r.t - dt); if (r.t <= 0 && r.phase === 'play' && r.sc[0] !== r.sc[1]) end(r); }
  }
}
function step(r, now) {
  const el = r.lt ? Math.min(.05, (now - r.lt) / 1000) : 0; r.lt = now;
  if (r.pl.some(p => p && p.gone)) return; // paused while a player reconnects
  r.acc = (r.acc || 0) + el;
  while (r.acc >= TK && (r.phase === 'play' || r.phase === 'count')) { r.acc -= TK; tick(r, TK); }
  if (r.phase === 'play' || r.phase === 'count')
    send(r, { t: 's', k: [rd(r.pk.x), rd(r.pk.y)], v: [rd(r.pk.vx), rd(r.pk.vy)], z: r.pause > 0 ? 1 : 0, p: r.pd.map(p => [rd(p.x), rd(p.y)]), sc: r.sc, tm: Math.ceil(r.t) });
}
setInterval(() => { const now = performance.now(); for (const r of rooms.values()) if (r.phase === 'count' || r.phase === 'play') step(r, now); }, 1000 / 60);
setInterval(() => { for (const [k, r] of rooms) if (Date.now() - r.act > 18e5 || (!r.pl[0] && !r.pl[1] && Date.now() - r.act > 6e4)) rooms.delete(k); }, 6e4);

setInterval(() => {
  const t = Date.now();
  for (const r of rooms.values()) if (r.pub && r.phase === 'wait' && !r.bot && r.botAt <= t && r.pl.filter(Boolean).length === 1) {
    r.bi = r.pl[0] ? 1 : 0; r.bot = 1; r.pl[r.bi] = { uid: 'bot', ws: { readyState: 3, send() { }, close() { } } }; r.ready[r.bi] = 1; info(r);
  }
}, 500);
const err = c => JSON.stringify({ t: 'err', c });
const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); s.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); });
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 1024 });
wss.on('connection', ws => {
  let r = null, i = -1;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !r) {
      if (!m.q && !m.test && !ID.test(m.id)) return;
      const u = auth(m.init); if (!u) return ws.send(err('auth'));
      const mm = await member(u.id);
      if (mm === null) return ws.send(err('busy'));
      if (!mm) return ws.send(err('member'));
      if (ws.readyState !== 1 || r) return;
      let room;
      if (m.test) { // hidden test game: private room, bot already seated at the top, starts right away
        if (rooms.size > 5000) return;
        room = mk(crypto.randomBytes(5).toString('hex')); room.test = 1; room.bot = 1; room.bi = 1;
        room.pl[1] = { uid: 'bot', ws: { readyState: 3, send() { }, close() { } } }; room.ready[1] = 1; rooms.set(room.id, room);
      } else if (m.q) { // quick match: join a waiting public room, else open one (a bot fills in after BOTWAIT)
        room = [...rooms.values()].find(x => x.pub && x.phase === 'wait' && !x.bot && x.pl.filter(Boolean).length === 1 && x.pl.find(Boolean).uid !== u.id);
        if (!room) { if (rooms.size > 5000) return; room = mk(crypto.randomBytes(5).toString('hex')); room.pub = 1; room.botAt = Date.now() + BOTWAIT; rooms.set(room.id, room); }
      } else {
        if (!rooms.has(m.id)) { if (rooms.size > 5000) return; rooms.set(m.id, mk(m.id)); }
        room = rooms.get(m.id);
      }
      let j = room.pl.findIndex(p => p && p.uid === u.id); if (j < 0) j = room.pl.findIndex(p => !p);
      if (j < 0) return ws.send(err('full'));
      if (room.pl[j]) try { room.pl[j].ws.close(); } catch { }
      r = room; i = j; r.pl[i] = { ws, uid: u.id }; r.act = Date.now(); info(r);
      if (r.test && r.phase === 'wait') start(r);
    } else if (!r) return;
    else if (m.t === 'm') {
      if (!(Number.isFinite(m.x) && Number.isFinite(m.y))) return;
      const p = r.pd[i]; p.tx = i ? W - m.x : m.x; p.ty = i ? H - m.y : m.y;
    } else if (m.t === 'ready' && (r.phase === 'wait' || r.phase === 'over') && r.pl[0] && r.pl[1]) {
      if (r.bot && !r.test && r.phase === 'over') { // rematch after a bot game goes back to the queue
        r.pl[r.bi] = null; r.bot = 0; r.bk = null; r.phase = 'wait'; r.ready = [0, 0]; r.sc = [0, 0]; r.botAt = Date.now() + BOTWAIT; r.act = Date.now();
        return info(r);
      }
      r.ready[i] = 1; if (r.bot) r.ready[r.bi] = 1; r.act = Date.now();
      if (r.ready[0] && r.ready[1]) start(r); else info(r);
    }
  });
  ws.on('close', () => {
    if (!r || !r.pl[i] || r.pl[i].ws !== ws) return;
    if (r.phase === 'count' || r.phase === 'play') { // keep the seat for a few seconds so the player can reconnect
      const room = r, k = i; room.pl[k].gone = Date.now();
      setTimeout(() => { const p = room.pl[k]; if (p && p.ws === ws && rooms.get(room.id) === room) { room.pl[k] = null; send(room, { t: 'left' }); rooms.delete(room.id); } }, GRACE);
      return;
    }
    if (r.test) { rooms.delete(r.id); return; }
    r.pl[i] = null; r.ready = [0, 0]; r.act = Date.now();
    if (['count', 'play', 'over'].includes(r.phase)) { send(r, { t: 'left' }); rooms.delete(r.id); }
    else if (r.pub && (r.bot || (!r.pl[0] && !r.pl[1]))) rooms.delete(r.id);
    else { r.phase = 'wait'; if (r.pub) r.botAt = Date.now() + BOTWAIT; info(r); }
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
