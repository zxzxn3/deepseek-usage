// 生成扩展图标 icon.png（256x256，RGBA，零依赖：zlib + 手写 PNG 编码）。
// 主题：渐变底 + 白色信用卡 + 用量柱状图。
import zlib from "node:zlib";
import fs from "node:fs";

const S = 256;

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: None
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 画布 ----------
const px = Buffer.alloc(S * S * 4);
function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}
// 圆角矩形 SDF 测试
function inRoundedRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x;
  const cy = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// 背景：圆角方形 + 垂直渐变（上浅蓝 → 下靛蓝）
const top = [110, 140, 255];
const bot = [59, 79, 216];
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const r = Math.round(top[0] + (bot[0] - top[0]) * t);
  const g = Math.round(top[1] + (bot[1] - top[1]) * t);
  const b = Math.round(top[2] + (bot[2] - top[2]) * t);
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, 0, 0, S - 1, S - 1, 60)) setPx(x, y, r, g, b);
  }
}
// 白色信用卡
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++)
    if (inRoundedRect(x, y, 42, 84, 214, 172, 18)) setPx(x, y, 255, 255, 255);
// 芯片（淡蓝圆角块）
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++)
    if (inRoundedRect(x, y, 60, 100, 100, 128, 6)) setPx(x, y, 201, 211, 250);
// 柱状图（3 根，右半卡面，逐级升高）
const bars = [
  { x: 120, w: 20, h: 26, c: [77, 107, 254] },
  { x: 146, w: 20, h: 42, c: [46, 79, 216] },
  { x: 172, w: 20, h: 58, c: [22, 43, 158] },
];
for (const b of bars) {
  const y0 = 156 - b.h;
  const y1 = 156;
  for (let y = y0; y <= y1; y++)
    for (let x = b.x; x <= b.x + b.w; x++)
      if (inRoundedRect(x, y, b.x, y0, b.x + b.w, y1, 6))
        setPx(x, y, b.c[0], b.c[1], b.c[2]);
}

const png = encodePng(S, S, px);
fs.writeFileSync(new URL("icon.png", import.meta.url), png);
console.log("icon.png written:", png.length, "bytes");
