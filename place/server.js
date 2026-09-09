// Rhysen Place — 情侣双人版 demo
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8895;
const W = parseInt(process.env.W || '64');
const H = parseInt(process.env.H || '64');
const COOLDOWN = parseInt(process.env.COOLDOWN || '5000'); // ms
const DATA = path.join(__dirname, 'data', 'canvas.json');
const HIST = path.join(__dirname, 'data', 'history.jsonl');
const AI_KEY = process.env.AI_KEY || 'rhysen';
const view = require('./view');

// 望舒版色板 v0.1 — 33 色
const PALETTE = [
  '#ffffff','#e4e4e4','#b8b8b8','#888888','#222222','#000000',
  '#6d001a','#be0039','#ff4500','#ffa800','#ffd635','#fff8b8',
  '#00a368','#00cc78','#7eed56','#00756f','#009eaa','#00ccc0',
  '#2450a4','#3690ea','#51e9f4','#493ac1','#6a5cff','#94b3ff',
  '#811e9f','#b44ac0','#e4abff','#de107f','#ff3881','#ff99aa',
  '#6d482f','#9c6926','#ffb470'
];

let cells, owners, times;
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    if (d.w === W && d.h === H) { cells = d.cells; owners = d.owners; times = d.times; return; }
  } catch {}
  cells = new Array(W * H).fill(0);
  owners = new Array(W * H).fill(null);
  times = new Array(W * H).fill(0);
}
load();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA, JSON.stringify({ w: W, h: H, cells, owners, times }));
  }, 500);
}

const lastPlace = new Map(); // name -> ts
function canPlace(name, isAI) {
  const now = Date.now();
  const last = lastPlace.get(name) || 0;
  const cd = COOLDOWN;
  if (now - last < cd) return { ok: false, wait: cd - (now - last) };
  return { ok: true };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  res.json({ w: W, h: H, palette: PALETTE, cooldown: COOLDOWN, cells, owners, times });
});

app.get('/api/history', (req, res) => {
  let lines = [];
  try { lines = fs.readFileSync(HIST, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  res.json(lines);
});

app.get('/api/cooldown', (req, res) => {
  const name = String(req.query.name || '').trim();
  const r = canPlace(name);
  res.json({ ok: r.ok, wait: r.wait || 0, cooldown: COOLDOWN });
});

function place({ x, y, c, name, ai }) {
  x = +x; y = +y; c = +c;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H) return { error: '坐标越界' };
  if (!Number.isInteger(c) || c < 0 || c >= PALETTE.length) return { error: '颜色不在色板里' };
  name = String(name || '').trim().slice(0, 20);
  if (!name) return { error: '要留个名字' };
  const r = canPlace(name);
  if (!r.ok) return { error: '还在冷却', wait: r.wait };
  const now = Date.now();
  const i = y * W + x;
  cells[i] = c; owners[i] = name; times[i] = now;
  lastPlace.set(name, now);
  const ev = { x, y, c, name, t: now, ai: !!ai };
  fs.appendFile(HIST, JSON.stringify(ev) + '\n', () => {});
  save();
  broadcast(ev);
  return { ok: true, ev, cooldown: COOLDOWN };
}

// 人类：前端点击
app.post('/api/place', (req, res) => {
  const r = place(req.body || {});
  if (r.error) return res.status(r.wait ? 429 : 400).json(r);
  res.json(r);
});

// AI：curl / MCP 走这条，人机同一套规则
app.post('/api/ai/place', (req, res) => {
  if (req.headers['x-ai-key'] !== AI_KEY) return res.status(401).json({ error: 'no' });
  const r = place({ ...(req.body || {}), ai: true });
  if (r.error) return res.status(r.wait ? 429 : 400).json(r);
  res.json(r);
});

// 文本快照，给 AI 看画布用（每格一个色号，16进制两位）
app.get('/api/ascii', (req, res) => {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let s = '';
    for (let x = 0; x < W; x++) s += cells[y * W + x].toString(16).padStart(2, '0') + ' ';
    rows.push(s.trim());
  }
  res.type('text/plain').send(`# ${W}x${H}, palette index hex\n` + rows.join('\n'));
});

// AI 看画布：图
app.get('/api/png', (req, res) => {
  const q = req.query;
  const scale = Math.max(2, Math.min(32, +q.scale || 16));
  const png = view.renderPNG({ W, H, cells, palette: PALETTE, scale, x0: +q.x || 0, y0: +q.y || 0, w: +q.w || W - (+q.x || 0), h: +q.h || H - (+q.y || 0) });
  res.type('image/png').send(png);
});
// AI 看画布：整幅压缩文字
app.get('/api/rle', (req, res) => res.type('text/plain').send(view.renderRLE({ W, H, cells, owners })));
// AI 看画布：局部窗口
app.get('/api/window', (req, res) => {
  const q = req.query;
  res.type('text/plain').send(view.renderWindow({ W, H, cells, owners, times, x0: +q.x || 0, y0: +q.y || 0, w: +q.w || 16, h: +q.h || 16 }));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(ev) {
  const s = JSON.stringify({ type: 'place', ...ev });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', online: wss.clients.size }));
  const s = JSON.stringify({ type: 'online', n: wss.clients.size });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
  ws.on('close', () => {
    const s = JSON.stringify({ type: 'online', n: wss.clients.size });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Rhysen Place demo on ${PORT}, ${W}x${H}, cooldown ${COOLDOWN}ms`));
