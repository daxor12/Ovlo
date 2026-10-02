// OVLO server — npm i ws ; node server.js (Node 18+)
// ENV: BOT_TOKEN, APP_LINK (https://t.me/<bot>/<app>), CHANNEL (@Daxor_unit), PORT
// Without BOT_TOKEN it runs in dev mode (no auth / no force-join / no inline bot).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = process.env, TOKEN = E.BOT_TOKEN || '', CH = E.CHANNEL || '@Daxor_unit', LINK = E.APP_LINK || '', PORT = E.PORT || 3000;
const W = 400, H = 700, PR = 34, UR = 19, GOAL = 150, WIN = 7, TIME = 180, DT = 1 / 60, PMAX = 3200, VMAX = 1000,V0 = 600, BOTWAIT = 15000, GRACE = 10000;
const botWait = () => 8000 + Math.random() * 10000;
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
  r.bk = null; r.phase = 'count'; r.cd = 3; r.last = -1; r.sc = [0, 0]; r.t = TIME; r.pause = 0; r.ready = [0, 0];
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
    const a = 1 - Math.exp(-60 * dt);
    let dx = (tx - p.x) * a, dy = (ty - p.y) * a; const d = Math.hypot(dx, dy), m = PMAX * dt;
    if (d > m) { dx *= m / d; dy *= m / d; }
    p.x += dx; p.y += dy;
    p.vx += (dx / dt - p.vx) * .6; p.vy += (dy / dt - p.vy) * .6;
  });
}
const cv = v => Math.max(-1300, Math.min(1300, v)); // paddle speed used in collisions
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
  const sp = Math.hypot(k.vx, k.vy); if (sp > V0) { const c = V0 + (VMAX - V0) * (1 - Math.exp(-(sp - V0) / (VMAX - V0))); k.vx *= c / sp; k.vy *= c / sp; } // soft cap: harder hit = faster puck
}
function puck(r, dt) {
  const k = r.pk, n = 4, h = dt / n, px = [W / 2 - GOAL / 2, W / 2 + GOAL / 2];
  for (let s = 0; s < n; s++) {
    k.x += k.vx * h; k.y += k.vy * h; const f = Math.exp(-.35 * h); k.vx *= f; k.vy *= f;
    const q = (s + 1) / n;
    r.pd.forEach(p => hit(k, p.x0 + (p.x - p.x0) * q, p.y0 + (p.y - p.y0) * q, PR + UR, cv(p.vx), cv(p.vy), .78));
    px.forEach(x => { hit(k, x, 0, UR, 0, 0, .9); hit(k, x, H, UR, 0, 0, .9); });
    if (k.x < UR) { k.x = UR; k.vx = Math.abs(k.vx) * .95; } else if (k.x > W - UR) { k.x = W - UR; k.vx = -Math.abs(k.vx) * .95; }
    if (Math.abs(k.x - W / 2) < GOAL / 2) continue;
    if (k.y < UR) { k.y = UR; k.vy = Math.abs(k.vy) * .95; } else if (k.y > H - UR) { k.y = H - UR; k.vy = -Math.abs(k.vy) * .95; }
  }
  if (k.y < -UR) goal(r, 0); else if (k.y > H + UR) goal(r, 1);
}
function bot(r, dt) {
  const i = r.bi, b = r.pd[i], k = r.pk, sg = i ? 1 : -1;
  const T = (x, y) => i ? [x, y] : [W - x, H - y];                            // table <-> bot frame (bot defends y=0, attacks +y)
  const [bx, by] = T(b.x, b.y);
  const B = r.bk || (r.bk = { h: [], vx: 0, vy: 0, tx: bx, ty: by, T: 0, ph: Math.random() * 6.28, wait: .3 + Math.random() * .5, err: 0, rolled: 0, att: 0, m: 0, pow: .8, aim: 0, side: 1 });
  if ((B.wait -= dt) > 0) { b.tx = b.x; b.ty = b.y; return; }                 // a short beat after "GO"
  B.T += dt;
  const lead = r.sc[i] - r.sc[1 - i], skill = Math.min(1.25, Math.max(.75, 1 - lead * .12)); // eases off when ahead
  B.h.push([k.x, k.y, k.vx, k.vy]); while (B.h.length > Math.round(.14 / skill / dt) + 1) B.h.shift(); // true reaction delay (~140ms)
  const o = B.h[0], [qx, qy] = T(o[0], o[1]), vx = sg * o[2], vy = sg * o[3], spd = Math.hypot(vx, vy);
  const px = qx + Math.sin(B.T * 1.7 + B.ph) * 5, py = qy + Math.sin(B.T * 1.3 + B.ph * 2) * 5, wob = Math.sin(B.T * .9 + B.ph);
  const coming = vy < -120 && py > by - 10;                                    // puck heading for the bot's goal
  if (!coming) B.rolled = 0;
  let tx, ty, rate = 14, vmax = 700;
  if (py < H / 2 - 8 && (!coming || spd < 380)) {                              // ATTACK: puck on my half and not rushing me
    if (!B.att) { B.att = 1; B.m = 0; B.pow = .5 + .5 * Math.random(); B.aim = (Math.random() - .5) * 110; B.side = bx >= px ? 1 : -1; }
    const ux0 = W / 2 + B.aim - px, uy0 = H - py, ul = Math.hypot(ux0, uy0) || 1, ux = ux0 / ul, uy = uy0 / ul, beh = py - by;
    if (!B.m && beh > 14) B.m = 1; else if (B.m && beh < -10) { B.m = 0; B.side = bx >= px ? 1 : -1; }
    if (B.m) { tx = px + ux * 28; ty = py + uy * 28; } else { tx = px - ux * 60 + B.side * 70; ty = py - uy * 60; }
    vmax = (480 + 620 * B.pow) * Math.min(1.12, skill); rate = 18;
  } else {
    B.att = 0;
    if (coming) {                                                              // DEFEND: go to the predicted intercept (with wall bounces)
      if (!B.rolled) { B.rolled = 1; const f = spd / VMAX; B.err = (Math.random() - .5) * (14 + 40 * f); if (Math.random() < (.04 + .1 * f) / skill) B.err += (Math.random() < .5 ? -1 : 1) * (45 + Math.random() * 40); }
      const t = Math.max(0, py - 85) / -vy, w = W - 2 * UR;
      let x = (px + vx * t - UR) % (2 * w); if (x < 0) x += 2 * w;
      tx = UR + (x > w ? 2 * w - x : x) + B.err; ty = 85; vmax = 1150 * skill; rate = 24;
    } else { tx = W / 2 + (px - W / 2) * .55 + wob * 12; ty = 90 + (spd < 250 ? 25 : 0); } // idle: shadow the puck loosely
  }
  tx = Math.min(W - PR, Math.max(PR, tx)); ty = Math.min(H / 2 - PR, Math.max(PR, ty));
  const g = 1 - Math.exp(-rate * dt); B.tx += (tx - B.tx) * g; B.ty += (ty - B.ty) * g;
  // "hand" model: speed- and acceleration-limited
  const ex = B.tx - bx, ey = B.ty - by, d = Math.hypot(ex, ey) || 1e-6, sp = Math.min(vmax, d * 12);
  let wx = ex / d * sp - B.vx, wy = ey / d * sp - B.vy; const wl = Math.hypot(wx, wy), am = 10000 * dt;
  if (wl > am) { wx *= am / wl; wy *= am / wl; }
  B.vx += wx; B.vy += wy;
  const q = dt / (1 - Math.exp(-60 * dt)), [nx, ny] = T(bx + B.vx * q, by + B.vy * q); b.tx = nx; b.ty = ny; // movePads moves ~63% of the gap per tick
}
function step(r) {
  if (r.pl.some(p => p && p.gone)) return; // paused while a player reconnects
  if (r.phase === 'count') {
    const n = Math.ceil(r.cd -= DT);
    if (n !== r.last) { r.last = n; send(r, { t: 'count', n: Math.max(n, 0) }); }
    if (r.cd <= 0) r.phase = 'play';
  }
  if (r.bot && r.phase === 'play') bot(r, DT);
  movePads(r, DT);
  if (r.phase === 'play') {
    if (r.pause > 0) r.pause -= DT;
    else { puck(r, DT); r.t = Math.max(0, r.t - DT); if (r.t <= 0 && r.phase === 'play' && r.sc[0] !== r.sc[1]) end(r); }
  }
  r.k++;
  if (r.phase === 'play' || r.phase === 'count')
    send(r, { t: 's', ts: Date.now(), k: [rd(r.pk.x), rd(r.pk.y)], v: [rd(r.pk.vx), rd(r.pk.vy)], z: r.pause > 0 ? 1 : 0, p: r.pd.map(p => [rd(p.x), rd(p.y)]), sc: r.sc, tm: Math.ceil(r.t) });
}
// fixed-timestep loop with accumulator: setInterval jitter no longer slows the game down
let lastT = Date.now(), acc = 0;
setInterval(() => {
  const n = Date.now(); acc += Math.min(n - lastT, 100); lastT = n;
  while (acc >= 1000 / 60) {
    acc -= 1000 / 60;
    for (const r of rooms.values()) if (r.phase === 'count' || r.phase === 'play') step(r);
  }
}, 4);
setInterval(() => { for (const [k, r] of rooms) if (Date.now() - r.act > 18e5 || (!r.pl[0] && !r.pl[1] && Date.now() - r.act > 6e4)) rooms.delete(k); }, 6e4);

setInterval(() => {
  const t = Date.now();
  for (const r of rooms.values()) {
    if (r.pub && r.phase === 'wait' && !r.bot && r.botAt <= t && r.pl.filter(Boolean).length === 1) {
      r.bi = r.pl[0] ? 1 : 0; r.bot = 1; r.pl[r.bi] = { uid: 'bot', ws: { readyState: 3, send() { }, close() { } } }; r.ready[r.bi] = 0; r.brAt = t + 1500 + Math.random() * 3500; info(r);
    } else if (r.bot && r.brAt && r.brAt <= t && r.phase === 'wait') { // opponent "presses ready" after a human-like delay
      r.brAt = 0; r.ready[r.bi] = 1; if (r.ready[0] && r.ready[1]) start(r); else info(r);
    }
  }
}, 500);
const err = c => JSON.stringify({ t: 'err', c });
const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); s.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); });
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 1024 });
wss.on('connection', ws => {
  try { ws._socket.setNoDelay(true); } catch { } // disable Nagle: lower latency
  let r = null, i = -1;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'p') { if (typeof m.c === 'number') ws.send(JSON.stringify({ t: 'pong', c: m.c })); return; }
    if (m.t === 'join' && !r) {
      if (!m.q && !ID.test(m.id)) return;
      const u = auth(m.init); if (!u) return ws.send(err('auth'));
      const mm = await member(u.id);
      if (mm === null) return ws.send(err('busy'));
      if (!mm) return ws.send(err('member'));
      if (ws.readyState !== 1 || r) return;
      let room;
      if (m.q) { // quick match: join a waiting public room, else open one (a bot fills in after BOTWAIT)
        room = [...rooms.values()].find(x => x.pub && x.phase === 'wait' && !x.bot && x.pl.filter(Boolean).length === 1 && x.pl.find(Boolean).uid !== u.id);
        if (!room) { if (rooms.size > 5000) return; room = mk(crypto.randomBytes(5).toString('hex')); room.pub = 1; room.botAt = Date.now() + botWait(); rooms.set(room.id, room); }
      } else {
        if (!rooms.has(m.id)) { if (rooms.size > 5000) return; rooms.set(m.id, mk(m.id)); }
        room = rooms.get(m.id);
      }
      let j = room.pl.findIndex(p => p && p.uid === u.id); if (j < 0) j = room.pl.findIndex(p => !p);
      if (j < 0) return ws.send(err('full'));
      if (room.pl[j]) try { room.pl[j].ws.close(); } catch { }
      r = room; i = j; r.pl[i] = { ws, uid: u.id }; r.act = Date.now(); info(r);
    } else if (!r) return;
    else if (m.t === 'm') {
      if (!(Number.isFinite(m.x) && Number.isFinite(m.y))) return;
      const p = r.pd[i]; p.tx = i ? W - m.x : m.x; p.ty = i ? H - m.y : m.y;
    } else if (m.t === 'ready' && (r.phase === 'wait' || r.phase === 'over') && r.pl[0] && r.pl[1]) {
      if (r.bot && r.phase === 'over') { // rematch after a bot game goes back to the queue
        r.pl[r.bi] = null; r.bot = 0; r.bk = null; r.phase = 'wait'; r.ready = [0, 0]; r.sc = [0, 0]; r.botAt = Date.now() + botWait(); r.act = Date.now();
        return info(r);
      }
      r.ready[i] = 1; r.act = Date.now();
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
    r.pl[i] = null; r.ready = [0, 0]; r.act = Date.now();
    if (['count', 'play', 'over'].includes(r.phase)) { send(r, { t: 'left' }); rooms.delete(r.id); }
    else if (r.pub && (r.bot || (!r.pl[0] && !r.pl[1]))) rooms.delete(r.id);
    else { r.phase = 'wait'; if (r.pub) r.botAt = Date.now() + botWait(); info(r); }
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
