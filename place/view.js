// AI 看画布的两条路：图（PNG）和文字（RLE + 局部窗口）
const zlib = require('zlib');

const NAMES = ['白','浅灰','灰','深灰','炭','黑','酒红','红','橙红','橙','黄','奶黄','深绿','绿','草绿','墨绿','青','水青','深蓝','蓝','天蓝','靛','紫蓝','淡蓝','紫','浅紫','粉紫','玫红','桃红','粉','棕','土黄','杏'];

// 3x5 点阵数字，画坐标用
const DIGITS = {
  '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'], '2': ['111','001','111','100','111'],
  '3': ['111','001','111','001','111'], '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
  '6': ['111','100','111','101','111'], '7': ['111','001','001','001','001'], '8': ['111','101','111','101','111'],
  '9': ['111','101','111','001','111'],
};

function hex(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); }

function crc32(buf) { return zlib.crc32 ? zlib.crc32(buf) : crcFallback(buf); }
let crcTable;
function crcFallback(buf) {
  if (!crcTable) { crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 渲染：每格 scale 像素，淡格线，每 10 格深线，边上标坐标
function renderPNG({ W, H, cells, palette, scale = 16, x0 = 0, y0 = 0, w = W, h = H }) {
  const M = 14; // 边距，放坐标
  const width = M + w * scale, height = M + h * scale;
  const rgb = Buffer.alloc(width * height * 3, 0xf4);
  const pal = palette.map(hex);
  const put = (px, py, [r, g, b]) => { if (px < 0 || py < 0 || px >= width || py >= height) return; const i = (py * width + px) * 3; rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; };
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    const c = pal[cells[(y0 + cy) * W + (x0 + cx)]];
    for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) put(M + cx * scale + px, M + cy * scale + py, c);
  }
  const grid = [0, 0, 0];
  const blend = (px, py, a) => { const i = (py * width + px) * 3; if (i < 0 || i + 2 >= rgb.length) return; for (let k = 0; k < 3; k++) rgb[i + k] = Math.round(rgb[i + k] * (1 - a)); };
  if (scale >= 6) {
    for (let cx = 0; cx <= w; cx++) { const a = (x0 + cx) % 10 === 0 ? 0.45 : 0.12; for (let py = M; py < height; py++) blend(M + cx * scale, py, a); }
    for (let cy = 0; cy <= h; cy++) { const a = (y0 + cy) % 10 === 0 ? 0.45 : 0.12; for (let px = M; px < width; px++) blend(px, M + cy * scale, a); }
  }
  const label = (n, px, py) => { const s = String(n); for (let i = 0; i < s.length; i++) { const g = DIGITS[s[i]]; for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === '1') put(px + i * 4 + c, py + r, grid); } };
  const step = scale >= 12 ? 5 : 10;
  for (let cx = 0; cx < w; cx++) if ((x0 + cx) % step === 0) label(x0 + cx, M + cx * scale + 2, 3);
  for (let cy = 0; cy < h; cy++) if ((y0 + cy) % step === 0) label(y0 + cy, 1, M + cy * scale + 2);
  return encodePNG(width, height, rgb);
}

// 文字路一：整幅 RLE，空行合并
function renderRLE({ W, H, cells, owners }) {
  const lines = [];
  let blankFrom = null;
  const flushBlank = (until) => { if (blankFrom !== null) { lines.push(blankFrom === until ? `y${blankFrom}: 全白` : `y${blankFrom}-${until}: 全白`); blankFrom = null; } };
  for (let y = 0; y < H; y++) {
    const row = cells.slice(y * W, (y + 1) * W);
    if (row.every(c => c === 0)) { if (blankFrom === null) blankFrom = y; continue; }
    flushBlank(y - 1);
    const runs = [];
    for (let x = 0; x < W;) { let x2 = x; while (x2 < W && row[x2] === row[x]) x2++; runs.push(`${NAMES[row[x]]}${x2 - x}`); x = x2; }
    lines.push(`y${y}: ` + runs.join(' '));
  }
  flushBlank(H - 1);
  const who = {}; owners.forEach(o => { if (o) who[o] = (who[o] || 0) + 1; });
  const filled = owners.filter(Boolean).length;
  return `# 画布 ${W}x${H}，从左到右每行按"颜色+格数"压缩，(0,0) 在左上\n# 已放 ${filled} 格：` + Object.entries(who).map(([n, c]) => `${n} ${c}`).join('，') + '\n' + lines.join('\n');
}

// 文字路二：局部窗口，字符网格 + 图例 + 谁放的
function renderWindow({ W, H, cells, owners, times, x0, y0, w, h }) {
  x0 = Math.max(0, Math.min(W - 1, x0 | 0)); y0 = Math.max(0, Math.min(H - 1, y0 | 0));
  w = Math.max(1, Math.min(W - x0, w | 0 || 16)); h = Math.max(1, Math.min(H - y0, h | 0 || 16));
  const glyphs = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
  const used = new Set();
  const rows = [];
  for (let y = y0; y < y0 + h; y++) {
    let s = String(y).padStart(3) + ' ';
    for (let x = x0; x < x0 + w; x++) { const c = cells[y * W + x]; used.add(c); s += glyphs[c] + ' '; }
    rows.push(s.trimEnd());
  }
  let head = '    ';
  for (let x = x0; x < x0 + w; x++) head += (x % 5 === 0 ? String(x % 100).padStart(2).slice(-1) : ' ') + ' ';
  const legend = [...used].sort((a, b) => a - b).map(c => `${glyphs[c]}=${NAMES[c]}`).join(' ');
  const who = {};
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = owners[y * W + x]; if (o) who[o] = (who[o] || 0) + 1; }
  const whoS = Object.entries(who).map(([n, c]) => `${n} ${c} 格`).join('，') || '还没人动过';
  return `# 窗口 x${x0}-${x0 + w - 1}, y${y0}-${y0 + h - 1}（列号取个位，每 5 格标一次）\n# 图例：${legend}\n# 这块里：${whoS}\n${head.trimEnd()}\n${rows.join('\n')}`;
}

module.exports = { renderPNG, renderRLE, renderWindow, NAMES };
