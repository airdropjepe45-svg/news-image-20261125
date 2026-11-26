// THE WORLD — Wednesday 25 November 2026
// One-image summary of the day's world news for the make.fun news-image bounty.
// Pure Node (standard library only): hand-rolled TrueType text engine,
// supersampled raster canvas, and PNG encoder. Deterministic output.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// TrueType font engine (cmap 4/12, glyf simple + composite, hmtx advances)
// ---------------------------------------------------------------------------

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function i16(b, o) { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function f2dot14(b, o) { return i16(b, o) / 16384; }

class Font {
  constructor(buf, name) {
    this.buf = buf;
    this.name = name;
    const numTables = u16(buf, 4);
    this.tables = {};
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
      this.tables[tag] = { off: u32(buf, o + 8), len: u32(buf, o + 12) };
    }
    const head = this.tables.head.off;
    this.unitsPerEm = u16(buf, head + 18);
    this.indexToLocFormat = i16(buf, head + 50);
    this.numGlyphs = u16(buf, this.tables.maxp.off + 4);
    const hhea = this.tables.hhea.off;
    this.ascender = i16(buf, hhea + 4);
    this.descender = i16(buf, hhea + 6);
    this.numHMetrics = u16(buf, hhea + 34);
    this.parseCmap();
    this.outlineCache = new Map();
    this.maskCache = new Map();
  }

  parseCmap() {
    const b = this.buf;
    const base = this.tables.cmap.off;
    const n = u16(b, base + 2);
    let fmt12 = -1, fmt4 = -1;
    for (let i = 0; i < n; i++) {
      const rec = base + 4 + i * 8;
      const sub = base + u32(b, rec + 4);
      const fmt = u16(b, sub);
      if (fmt === 12 && fmt12 < 0) fmt12 = sub;
      if (fmt === 4 && fmt4 < 0) fmt4 = sub;
    }
    this.cmap12 = fmt12;
    this.cmap4 = fmt4;
  }

  glyphId(cp) {
    const b = this.buf;
    if (this.cmap12 >= 0) {
      const base = this.cmap12;
      const nGroups = u32(b, base + 12);
      let lo = 0, hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = base + 16 + mid * 12;
        const start = u32(b, g), end = u32(b, g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return u32(b, g + 8) + (cp - start);
      }
      return 0;
    }
    if (this.cmap4 >= 0 && cp <= 0xffff) {
      const base = this.cmap4;
      const segCount = u16(b, base + 6) >> 1;
      const endBase = base + 14;
      const startBase = endBase + 2 * segCount + 2;
      const deltaBase = startBase + 2 * segCount;
      const rangeBase = deltaBase + 2 * segCount;
      for (let i = 0; i < segCount; i++) {
        const end = u16(b, endBase + i * 2);
        if (cp <= end) {
          const start = u16(b, startBase + i * 2);
          if (cp < start) return 0;
          const delta = i16(b, deltaBase + i * 2);
          const ro = u16(b, rangeBase + i * 2);
          if (ro === 0) return (cp + delta) & 0xffff;
          const gi = u16(b, rangeBase + i * 2 + ro + (cp - start) * 2);
          return gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
      }
    }
    return 0;
  }

  advance(gid) {
    const b = this.buf;
    const hmtx = this.tables.hmtx.off;
    const idx = Math.min(gid, this.numHMetrics - 1);
    return u16(b, hmtx + idx * 4);
  }

  glyphOffset(gid) {
    const b = this.buf;
    const loca = this.tables.loca.off;
    if (this.indexToLocFormat === 0) return u16(b, loca + gid * 2) * 2;
    return u32(b, loca + gid * 4);
  }

  // Returns { contours: [ [ {x,y,on}, ... ], ... ], xMin,yMin,xMax,yMax }
  rawGlyph(gid) {
    const b = this.buf;
    const glyf = this.tables.glyf.off;
    const start = this.glyphOffset(gid);
    const end = this.glyphOffset(gid + 1);
    if (start === end) return { contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    const o = glyf + start;
    const nContours = i16(b, o);
    const xMin = i16(b, o + 2), yMin = i16(b, o + 4), xMax = i16(b, o + 6), yMax = i16(b, o + 8);
    if (nContours >= 0) {
      let p = o + 10;
      const endPts = [];
      for (let i = 0; i < nContours; i++) { endPts.push(u16(b, p)); p += 2; }
      const instrLen = u16(b, p); p += 2 + instrLen;
      const totalPts = nContours === 0 ? 0 : endPts[nContours - 1] + 1;
      const flags = [];
      while (flags.length < totalPts) {
        const f = b[p++];
        flags.push(f);
        if (f & 0x08) {
          const rep = b[p++];
          for (let i = 0; i < rep; i++) flags.push(f);
        }
      }
      const xs = [];
      let x = 0;
      for (let i = 0; i < totalPts; i++) {
        const f = flags[i];
        if (f & 0x02) {
          const dx = b[p++];
          x += (f & 0x10) ? dx : -dx;
        } else if (!(f & 0x10)) {
          x += i16(b, p); p += 2;
        }
        xs.push(x);
      }
      const ys = [];
      let y = 0;
      for (let i = 0; i < totalPts; i++) {
        const f = flags[i];
        if (f & 0x04) {
          const dy = b[p++];
          y += (f & 0x20) ? dy : -dy;
        } else if (!(f & 0x20)) {
          y += i16(b, p); p += 2;
        }
        ys.push(y);
      }
      const contours = [];
      let s = 0;
      for (let c = 0; c < nContours; c++) {
        const pts = [];
        for (let i = s; i <= endPts[c]; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
        contours.push(pts);
        s = endPts[c] + 1;
      }
      return { contours, xMin, yMin, xMax, yMax };
    }
    // Composite glyph
    let p = o + 10;
    const contours = [];
    const allPts = [];
    let more = true;
    while (more) {
      const flags = u16(b, p); p += 2;
      const compGid = u16(b, p); p += 2;
      let arg1, arg2;
      if (flags & 0x0001) { arg1 = i16(b, p); arg2 = i16(b, p + 2); p += 4; }
      else { arg1 = b[p] >= 128 ? b[p] - 256 : b[p]; arg2 = b[p + 1] >= 128 ? b[p + 1] - 256 : b[p + 1]; p += 2; }
      let sx = 1, sy = 1, s01 = 0, s10 = 0;
      if (flags & 0x0008) { sx = sy = f2dot14(b, p); p += 2; }
      else if (flags & 0x0040) { sx = f2dot14(b, p); sy = f2dot14(b, p + 2); p += 4; }
      else if (flags & 0x0080) { sx = f2dot14(b, p); s01 = f2dot14(b, p + 2); s10 = f2dot14(b, p + 4); sy = f2dot14(b, p + 6); p += 8; }
      const sub = this.rawGlyph(compGid);
      const subPts = [];
      for (const c of sub.contours) for (const pt of c) subPts.push(pt);
      let dx = 0, dy = 0;
      if (flags & 0x0002) { dx = arg1; dy = arg2; }
      else {
        const anchorComp = allPts[arg1] || { x: 0, y: 0 };
        const anchorSub = subPts[arg2] || { x: 0, y: 0 };
        const tx = anchorSub.x * sx + anchorSub.y * s01;
        const ty = anchorSub.x * s10 + anchorSub.y * sy;
        dx = anchorComp.x - tx;
        dy = anchorComp.y - ty;
      }
      for (const c of sub.contours) {
        const nc = c.map(pt => ({
          x: pt.x * sx + pt.y * s01 + dx,
          y: pt.x * s10 + pt.y * sy + dy,
          on: pt.on,
        }));
        contours.push(nc);
        for (const pt of nc) allPts.push(pt);
      }
      more = (flags & 0x0020) !== 0;
    }
    return { contours, xMin, yMin, xMax, yMax };
  }

  // Flattened polygons (font units, y up) for a glyph, cached.
  outline(gid) {
    if (this.outlineCache.has(gid)) return this.outlineCache.get(gid);
    const g = this.rawGlyph(gid);
    const polys = [];
    for (const contour of g.contours) {
      if (contour.length === 0) continue;
      // Build point list with implied on-curve midpoints.
      const pts = [];
      const n = contour.length;
      for (let i = 0; i < n; i++) {
        const cur = contour[i];
        const nxt = contour[(i + 1) % n];
        pts.push(cur);
        if (!cur.on && !nxt.on) pts.push({ x: (cur.x + nxt.x) / 2, y: (cur.y + nxt.y) / 2, on: true });
      }
      // Start at an on-curve point.
      let startIdx = pts.findIndex(p => p.on);
      if (startIdx < 0) continue;
      const rot = pts.slice(startIdx).concat(pts.slice(0, startIdx));
      const poly = [[rot[0].x, rot[0].y]];
      let i = 1;
      while (i < rot.length) {
        const p = rot[i];
        if (p.on) {
          poly.push([p.x, p.y]);
          i++;
        } else {
          const c = p;
          const e = rot[(i + 1) % rot.length];
          const p0 = poly[poly.length - 1];
          const d = Math.hypot(c.x - p0[0], c.y - p0[1]) + Math.hypot(e.x - c.x, e.y - c.y);
          const segs = Math.max(2, Math.min(24, Math.ceil(d / (this.unitsPerEm * 0.012))));
          for (let s = 1; s <= segs; s++) {
            const t = s / segs, mt = 1 - t;
            poly.push([
              mt * mt * p0[0] + 2 * mt * t * c.x + t * t * e.x,
              mt * mt * p0[1] + 2 * mt * t * c.y + t * t * e.y,
            ]);
          }
          i += 2;
        }
      }
      polys.push(poly);
    }
    const res = { polys, xMin: g.xMin, yMin: g.yMin, xMax: g.xMax, yMax: g.yMax };
    this.outlineCache.set(gid, res);
    return res;
  }

  // Coverage mask for a glyph at a given pixel size (em size in device px).
  // Coordinates: mask origin (x0,y0) is relative to the pen position on the
  // baseline, y growing downward.
  mask(gid, pxSize) {
    const key = gid + '@' + pxSize;
    if (this.maskCache.has(key)) return this.maskCache.get(key);
    const o = this.outline(gid);
    const scale = pxSize / this.unitsPerEm;
    const x0 = Math.floor(o.xMin * scale);
    const x1 = Math.ceil(o.xMax * scale);
    const y0 = Math.floor(-o.yMax * scale);
    const y1 = Math.ceil(-o.yMin * scale);
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const cov = new Float32Array(w * h);
    if (w > 0 && h > 0 && o.polys.length > 0) {
      const edges = [];
      for (const poly of o.polys) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], bpt = poly[(i + 1) % poly.length];
          edges.push([a[0] * scale, -a[1] * scale, bpt[0] * scale, -bpt[1] * scale]);
        }
      }
      const GSS = 4;
      const hits = [];
      for (let sy = 0; sy < h * GSS; sy++) {
        const yy = y0 + (sy + 0.5) / GSS;
        hits.length = 0;
        for (const e of edges) {
          const ey1 = e[1], ey2 = e[3];
          if ((ey1 <= yy && ey2 > yy) || (ey2 <= yy && ey1 > yy)) {
            const t = (yy - ey1) / (ey2 - ey1);
            hits.push({ x: e[0] + t * (e[2] - e[0]), dir: ey2 > ey1 ? 1 : -1 });
          }
        }
        if (hits.length === 0) continue;
        hits.sort((a, b) => a.x - b.x);
        const row = (sy / GSS) | 0;
        let wind = 0;
        for (let i = 0; i < hits.length; i++) {
          wind += hits[i].dir;
          if (wind !== 0 && i + 1 < hits.length) {
            let xa = hits[i].x - x0, xb = hits[i + 1].x - x0;
            if (xb <= 0 || xa >= w) continue;
            xa = Math.max(0, xa); xb = Math.min(w, xb);
            const amt = 1 / GSS;
            const pxa = Math.floor(xa), pxb = Math.floor(xb);
            if (pxa === pxb) {
              cov[row * w + pxa] += (xb - xa) * amt;
            } else {
              cov[row * w + pxa] += (pxa + 1 - xa) * amt;
              for (let px = pxa + 1; px < pxb; px++) cov[row * w + px] += amt;
              cov[row * w + pxb] += (xb - pxb) * amt;
            }
          }
        }
      }
    }
    const res = { cov, w, h, x0, y0 };
    this.maskCache.set(key, res);
    return res;
  }
}

function loadFont(fileNames, name) {
  const dirs = [
    '/usr/share/fonts/truetype/dejavu/',
    '/usr/share/fonts/truetype/',
    '/usr/share/fonts/dejavu/',
    '/usr/share/fonts/',
  ];
  for (const d of dirs) {
    for (const f of fileNames) {
      const p = d + f;
      if (fs.existsSync(p)) return new Font(fs.readFileSync(p), name);
    }
  }
  throw new Error('font not found: ' + fileNames.join(', '));
}

// ---------------------------------------------------------------------------
// Supersampled RGBA canvas (drawn at 2x, box-downscaled for anti-aliasing)
// ---------------------------------------------------------------------------

const SS = 2; // canvas supersample factor
const W = 1024, H = 1024;
const DW = W * SS, DH = H * SS;
const buf = new Uint8ClampedArray(DW * DH * 4);

let clipRect = null; // [x0, y0, x1, y1] in device pixels
function setClip(x, y, w, h) {
  clipRect = [Math.round(x * SS), Math.round(y * SS), Math.round((x + w) * SS), Math.round((y + h) * SS)];
}
function clearClip() { clipRect = null; }

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= DW || y >= DH) return;
  if (clipRect && (x < clipRect[0] || y < clipRect[1] || x >= clipRect[2] || y >= clipRect[3])) return;
  const i = (y * DW + x) * 4;
  if (a >= 255) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  } else if (a > 0) {
    const ia = 255 - a;
    buf[i] = (r * a + buf[i] * ia) / 255;
    buf[i + 1] = (g * a + buf[i + 1] * ia) / 255;
    buf[i + 2] = (b * a + buf[i + 2] * ia) / 255;
    buf[i + 3] = 255;
  }
}

function fillAll(c) {
  for (let i = 0; i < DW * DH; i++) {
    buf[i * 4] = c[0]; buf[i * 4 + 1] = c[1]; buf[i * 4 + 2] = c[2]; buf[i * 4 + 3] = 255;
  }
}

// All drawing coordinates below are in final-image (1024) space.
function fillRect(x, y, w, h, c) {
  const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
  const a = c.length > 3 ? c[3] : 255;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPx(xx, yy, c[0], c[1], c[2], a);
  }
}

function strokeRect(x, y, w, h, c, lw) {
  fillRect(x, y, w, lw, c);
  fillRect(x, y + h - lw, w, lw, c);
  fillRect(x, y, lw, h, c);
  fillRect(x + w - lw, y, lw, h, c);
}

function fillCircle(cx, cy, r, c) {
  const a = c.length > 3 ? c[3] : 255;
  const cyD = cy * SS, cxD = cx * SS, rD = r * SS;
  const y0 = Math.floor(cyD - rD), y1 = Math.ceil(cyD + rD);
  for (let yy = y0; yy <= y1; yy++) {
    const dy = yy + 0.5 - cyD;
    const dx = Math.sqrt(Math.max(0, rD * rD - dy * dy));
    const xa = Math.round(cxD - dx), xb = Math.round(cxD + dx);
    for (let xx = xa; xx < xb; xx++) setPx(xx, yy, c[0], c[1], c[2], a);
  }
}

function fillPolygon(pts, c) {
  const a = c.length > 3 ? c[3] : 255;
  const P = pts.map(p => [p[0] * SS, p[1] * SS]);
  let minY = Infinity, maxY = -Infinity;
  for (const p of P) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(DH - 1, Math.ceil(maxY));
  const xs = [];
  for (let yy = y0; yy <= y1; yy++) {
    const yc = yy + 0.5;
    xs.length = 0;
    for (let i = 0; i < P.length; i++) {
      const p1 = P[i], p2 = P[(i + 1) % P.length];
      if ((p1[1] <= yc && p2[1] > yc) || (p2[1] <= yc && p1[1] > yc)) {
        const t = (yc - p1[1]) / (p2[1] - p1[1]);
        xs.push(p1[0] + t * (p2[0] - p1[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(DW, Math.round(xs[i + 1]));
      for (let xx = xa; xx < xb; xx++) setPx(xx, yy, c[0], c[1], c[2], a);
    }
  }
}

function drawLine(x1, y1, x2, y2, wdt, c) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (wdt / 2), ny = (dx / len) * (wdt / 2);
  fillPolygon([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], c);
  fillCircle(x1, y1, wdt / 2, c);
  fillCircle(x2, y2, wdt / 2, c);
}

function strokePolygon(pts, c, wdt) {
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    drawLine(p1[0], p1[1], p2[0], p2[1], wdt, c);
  }
}

function blitMask(m, dx, dy, c) {
  // dx, dy in device (2x) pixels, top-left of mask
  for (let yy = 0; yy < m.h; yy++) {
    for (let xx = 0; xx < m.w; xx++) {
      const v = m.cov[yy * m.w + xx];
      if (v <= 0) continue;
      const a = Math.min(255, Math.round(v * 255));
      setPx(dx + xx, dy + yy, c[0], c[1], c[2], a);
    }
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function measureText(text, font, size, letterSpacing) {
  const ls = letterSpacing || 0;
  let wdt = 0;
  for (const ch of text) {
    const gid = font.glyphId(ch.codePointAt(0));
    wdt += font.advance(gid) * size / font.unitsPerEm + ls;
  }
  return wdt;
}

// Draw text with baseline at y. Returns total advance width.
function drawText(text, x, y, font, size, color, letterSpacing) {
  const ls = letterSpacing || 0;
  const pxSize = size * SS;
  let pen = x;
  for (const ch of text) {
    const gid = font.glyphId(ch.codePointAt(0));
    const m = font.mask(gid, pxSize);
    if (m.w > 0 && m.h > 0) {
      blitMask(m, Math.round(pen * SS) + m.x0, Math.round(y * SS) + m.y0, color);
    }
    pen += font.advance(gid) * size / font.unitsPerEm + ls;
  }
  return pen - x;
}

function drawTextCentered(text, cx, y, font, size, color, letterSpacing) {
  const wdt = measureText(text, font, size, letterSpacing);
  return drawText(text, cx - wdt / 2, y, font, size, color, letterSpacing);
}

function drawTextRight(text, rx, y, font, size, color, letterSpacing) {
  const wdt = measureText(text, font, size, letterSpacing);
  return drawText(text, rx - wdt, y, font, size, color, letterSpacing);
}

// Greedy word wrap. Returns array of lines.
function wrapText(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const trial = cur === '' ? word : cur + ' ' + word;
    if (measureText(trial, font, size) <= maxWidth || cur === '') {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// Draw wrapped text starting at baseline y; returns y after last line.
function drawWrapped(text, x, y, font, size, color, maxWidth, lineHeight, maxLines) {
  const lines = wrapText(text, font, size, maxWidth);
  const n = maxLines ? Math.min(lines.length, maxLines) : lines.length;
  for (let i = 0; i < n; i++) {
    drawText(lines[i], x, y + i * lineHeight, font, size, color);
  }
  return y + n * lineHeight;
}

// Fit a font size so that text fits maxWidth (shrink from startSize).
function fitSize(text, font, startSize, maxWidth, letterSpacing) {
  let s = startSize;
  while (s > 4 && measureText(text, font, s, letterSpacing) > maxWidth) s -= 0.25;
  return s;
}

// ---------------------------------------------------------------------------
// PNG encoder (RGBA, adaptive filter, zlib deflate — deterministic)
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(rgb, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const rowOff = y * stride;
    const outOff = y * (stride + 1);
    // Try filters 0..4, pick lowest sum of absolute signed bytes.
    let bestFilter = 0, bestScore = Infinity, bestRow = null;
    for (let f = 0; f <= 4; f++) {
      const row = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const cur = rgb[rowOff + i];
        const a = i >= 3 ? rgb[rowOff + i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        let v;
        if (f === 0) v = cur;
        else if (f === 1) v = cur - a;
        else if (f === 2) v = cur - b;
        else if (f === 3) v = cur - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = cur - pr;
        }
        v &= 0xff;
        row[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestFilter = f; bestRow = row; }
    }
    raw[outOff] = bestFilter;
    bestRow.copy(raw, outOff + 1);
    prev.set(rgb.subarray(rowOff, rowOff + stride));
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function downscale() {
  const out = new Uint8ClampedArray(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const di = (y * W + x) * 3;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const si = ((y * SS + dy) * DW + (x * SS + dx)) * 4;
          r += buf[si]; g += buf[si + 1]; b += buf[si + 2];
        }
      }
      const n = SS * SS;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette and fonts
// ---------------------------------------------------------------------------

const PAPER = [247, 243, 232];
const INK = [26, 35, 50];
const NAVY = [22, 50, 79];
const RED = [179, 35, 42];
const TEAL = [23, 126, 122];
const ORANGE = [224, 123, 42];
const GOLD = [201, 162, 39];
const GREY = [74, 85, 104];
const RULE = [170, 162, 140];
const CARD_BG = [253, 251, 244];
const CARD_LINE = [199, 191, 168];
const DARK = [20, 32, 46];
const WHITE = [255, 255, 255];
const SKY = [168, 205, 226];
const SEA = [62, 110, 150];
const LAND = [196, 198, 168];
const LAND_LINE = [140, 144, 112];

const REGION_COLORS = {
  'N. AMERICA': [47, 102, 144],
  'LATIN AMERICA': [63, 164, 106],
  'EUROPE': [90, 95, 192],
  'MIDDLE EAST': [192, 57, 43],
  'N. AFRICA': [224, 165, 38],
  'SUB-SAHARAN AFRICA': [142, 68, 173],
  'SOUTH ASIA': [230, 126, 34],
  'EAST & SE ASIA': [22, 160, 133],
  'OCEANIA': [0, 166, 192],
  'GLOBAL': [127, 140, 141],
};

const serif = loadFont(['DejaVuSerif.ttf'], 'serif');
const serifB = loadFont(['DejaVuSerif-Bold.ttf'], 'serifB');
const sans = loadFont(['DejaVuSans.ttf'], 'sans');
const sansB = loadFont(['DejaVuSans-Bold.ttf'], 'sansB');

// ---------------------------------------------------------------------------
// Illustration scenes (flat vector, drawn inside a panel)
// ---------------------------------------------------------------------------

function artLabel(x, y, text, bg, fg, size) {
  const s = size || 10;
  const tw = measureText(text, sansB, s);
  const pw = tw + 10, ph = s + 7;
  fillRect(x, y, pw, ph, bg);
  drawText(text, x + 5, y + ph - 5, sansB, s, fg);
  return pw;
}

function flame(cx, cy, r, c1, c2) {
  fillPolygon([[cx - r, cy], [cx - r * 0.4, cy - r * 1.1], [cx, cy - r * 1.7], [cx + r * 0.45, cy - r * 1.0], [cx + r, cy]], c1);
  fillPolygon([[cx - r * 0.5, cy], [cx, cy - r * 0.9], [cx + r * 0.5, cy]], c2);
}

function smoke(cx, cy, r, c) {
  fillCircle(cx, cy, r, c);
  fillCircle(cx + r * 0.8, cy - r * 0.3, r * 0.75, c);
  fillCircle(cx - r * 0.8, cy - r * 0.2, r * 0.65, c);
  fillCircle(cx + r * 0.2, cy - r * 0.7, r * 0.6, c);
}

function containerShip(x, y, w, h) {
  fillRect(x, y, w, h, SKY);
  fillRect(x, y + h * 0.72, w, h * 0.28, SEA);
  // cranes
  const ink2 = [40, 60, 80];
  for (const fx of [0.16, 0.52, 0.84]) {
    const cx = x + w * fx;
    drawLine(cx, y + h * 0.72, cx, y + h * 0.16, 2, ink2);
    drawLine(cx, y + h * 0.16, cx + w * 0.13, y + h * 0.16, 2, ink2);
    drawLine(cx + w * 0.11, y + h * 0.16, cx + w * 0.11, y + h * 0.30, 1.2, ink2);
  }
  // hull
  const hy = y + h * 0.60;
  fillPolygon([[x + w * 0.06, hy], [x + w * 0.94, hy], [x + w * 0.88, hy + h * 0.16], [x + w * 0.13, hy + h * 0.16]], [38, 48, 64]);
  fillRect(x + w * 0.06, hy - 3, w * 0.88, 3, RED);
  // containers
  const cols = [[200, 70, 60], [60, 120, 180], [70, 160, 90], [230, 160, 50], [120, 90, 170], [220, 110, 50]];
  const cw = w * 0.115, ch = h * 0.115;
  for (let r = 0; r < 3; r++) {
    for (let cix = 0; cix < 6; cix++) {
      if (r === 2 && (cix === 0 || cix === 5)) continue;
      const cxp = x + w * 0.13 + cix * (cw + 2);
      const cyp = hy - (r + 1) * (ch + 1.5);
      fillRect(cxp, cyp, cw, ch, cols[(r * 6 + cix) % cols.length]);
      strokeRect(cxp, cyp, cw, ch, [30, 40, 55], 0.8);
    }
  }
  // bridge tower
  fillRect(x + w * 0.80, hy - h * 0.30, w * 0.07, h * 0.30, [240, 240, 235]);
  fillRect(x + w * 0.80, hy - h * 0.30, w * 0.07, h * 0.07, [38, 48, 64]);
  // waves
  for (let i = 0; i < 7; i++) {
    const wx = x + w * (0.08 + i * 0.13);
    drawLine(wx, y + h * 0.86, wx + w * 0.06, y + h * 0.86, 1.4, [190, 220, 240]);
  }
}

function tariffBars(x, y, w, h, rates) {
  // small rate table drawn over the ship art's sky area
  const bw = w * 0.30;
  const bx = x + w - bw - 6;
  let by = y + 5;
  const rowH = (h * 0.52) / rates.length;
  fillRect(bx - 4, by - 3, bw + 8, rowH * rates.length + 6, [253, 251, 244, 235]);
  strokeRect(bx - 4, by - 3, bw + 8, rowH * rates.length + 6, CARD_LINE, 0.8);
  for (const [name, pct] of rates) {
    drawText(name, bx, by + rowH - 3, sansB, 7.5, INK);
    const barW = (bw * 0.52) * (pct / 35);
    fillRect(bx + bw * 0.42, by + 2, barW, rowH - 5, RED);
    drawText(pct + '%', bx + bw * 0.42 + barW + 3, by + rowH - 3, sansB, 7.5, RED);
    by += rowH;
  }
}

function chartPanel(x, y, w, h, rows) {
  fillRect(x, y, w, h, DARK);
  // grid
  for (let i = 1; i < 5; i++) {
    drawLine(x + 6, y + (h * i) / 5, x + w - 6, y + (h * i) / 5, 0.6, [52, 72, 96]);
  }
  // falling polyline
  const pts = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const fx = 0.06 + (i / (n - 1)) * 0.5;
    const fy = 0.18 + (i / (n - 1)) * 0.62 + (i % 2 === 0 ? 0.05 : -0.04);
    pts.push([x + w * fx, y + h * fy]);
  }
  for (let i = 0; i + 1 < pts.length; i++) drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2.2, [255, 90, 90]);
  for (const p of pts) fillCircle(p[0], p[1], 2.2, [255, 120, 120]);
  // arrow head
  const last = pts[pts.length - 1];
  fillPolygon([[last[0] + 2, last[1] + 2], [last[0] - 8, last[1] + 1], [last[0] - 1, last[1] - 7]], [255, 90, 90]);
  // index rows on the right
  const rx = x + w * 0.60;
  let ry = y + 8;
  const rowH = (h - 14) / rows.length;
  for (const [name, val] of rows) {
    drawText(name, rx, ry + rowH - 4, sansB, 8, [200, 220, 240]);
    drawTextRight(val, x + w - 7, ry + rowH - 4, sansB, 8.5, [255, 110, 110]);
    ry += rowH;
  }
}

function rocketStation(x, y, w, h) {
  fillRect(x, y, w, h, [16, 26, 52]);
  // stars (deterministic pseudo-random positions)
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) {
    fillCircle(x + rnd() * w, y + rnd() * h * 0.8, 0.9, [220, 230, 255]);
  }
  // earth curve at bottom
  fillCircle(x + w * 0.5, y + h * 1.30, w * 0.52, [52, 110, 180]);
  // rocket (left)
  const rx = x + w * 0.20, ry = y + h * 0.18, rw = w * 0.075, rh = h * 0.52;
  fillRect(rx, ry + rh * 0.18, rw, rh * 0.82, [235, 238, 242]);
  fillPolygon([[rx, ry + rh * 0.18], [rx + rw / 2, ry], [rx + rw, ry + rh * 0.18]], RED);
  fillPolygon([[rx, ry + rh], [rx - rw * 0.55, ry + rh * 1.12], [rx, ry + rh * 0.78]], [200, 60, 50]);
  fillPolygon([[rx + rw, ry + rh], [rx + rw * 1.55, ry + rh * 1.12], [rx + rw, ry + rh * 0.78]], [200, 60, 50]);
  fillCircle(rx + rw / 2, ry + rh * 0.42, rw * 0.22, [52, 110, 180]);
  flame(rx + rw / 2, ry + rh * 1.02, rw * 0.5, [240, 140, 40], [250, 200, 80]);
  // station (right)
  const sx = x + w * 0.62, sy = y + h * 0.34;
  fillRect(sx - w * 0.20, sy - 3, w * 0.40, 6, [200, 208, 220]);
  fillRect(sx - w * 0.19, sy - h * 0.16, w * 0.11, h * 0.32, [70, 110, 190]);
  fillRect(sx + w * 0.08, sy - h * 0.16, w * 0.11, h * 0.32, [70, 110, 190]);
  for (let i = 0; i < 3; i++) {
    drawLine(sx - w * 0.19, sy - h * 0.16 + (i + 1) * h * 0.08, sx - w * 0.08, sy - h * 0.16 + (i + 1) * h * 0.08, 0.8, [160, 190, 235]);
    drawLine(sx + w * 0.08, sy - h * 0.16 + (i + 1) * h * 0.08, sx + w * 0.19, sy - h * 0.16 + (i + 1) * h * 0.08, 0.8, [160, 190, 235]);
  }
  fillRect(sx - w * 0.035, sy - h * 0.13, w * 0.07, h * 0.26, [235, 238, 242]);
  fillCircle(sx, sy - h * 0.13, w * 0.02, [235, 238, 242]);
  // docking capsule approaching
  fillRect(sx - w * 0.085, sy - 3.5, w * 0.045, 7, [240, 200, 90]);
  drawLine(rx + rw + 4, ry + rh * 0.3, sx - w * 0.09, sy, 0.8, [150, 180, 230]);
}

function tankerShips(x, y, w, h) {
  fillRect(x, y, w, h, [190, 214, 232]);
  fillRect(x, y + h * 0.66, w, h * 0.34, SEA);
  for (const fx of [0.10, 0.55]) {
    const sx = x + w * fx, sy = y + h * 0.52;
    fillPolygon([[sx, sy], [sx + w * 0.36, sy], [sx + w * 0.32, sy + h * 0.16], [sx + w * 0.04, sy + h * 0.16]], [44, 54, 70]);
    fillRect(sx + w * 0.05, sy - h * 0.13, w * 0.20, h * 0.13, [120, 130, 145]);
    fillRect(sx + w * 0.28, sy - h * 0.20, w * 0.05, h * 0.20, [230, 230, 225]);
  }
  // mines
  for (const [fx, fy] of [[0.42, 0.82], [0.88, 0.78], [0.05, 0.88]]) {
    const mx = x + w * fx, my = y + h * fy, r = h * 0.085;
    fillCircle(mx, my, r, [30, 34, 40]);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      drawLine(mx, my, mx + Math.cos(ang) * r * 1.5, my + Math.sin(ang) * r * 1.5, 1.2, [30, 34, 40]);
    }
  }
}

function refineryTowers(x, y, w, h, withFire, withDrones) {
  fillRect(x, y, w, h, [206, 222, 235]);
  fillRect(x, y + h * 0.80, w, h * 0.20, [120, 124, 110]);
  const steel = [90, 100, 115];
  const towers = [[0.12, 0.55], [0.30, 0.72], [0.52, 0.62], [0.70, 0.78]];
  for (const [fx, fh] of towers) {
    const tx = x + w * fx, tw = w * 0.085, ty = y + h * 0.80 - h * fh;
    fillRect(tx, ty, tw, h * fh, steel);
    fillCircle(tx + tw / 2, ty, tw / 2, steel);
    fillRect(tx - 1.5, ty + h * fh * 0.35, tw + 3, 2, [70, 80, 95]);
    fillRect(tx - 1.5, ty + h * fh * 0.65, tw + 3, 2, [70, 80, 95]);
  }
  // horizontal tank
  fillRect(x + w * 0.82, y + h * 0.62, w * 0.14, h * 0.18, [150, 158, 170]);
  fillCircle(x + w * 0.82, y + h * 0.71, h * 0.09, [150, 158, 170]);
  fillCircle(x + w * 0.96, y + h * 0.71, h * 0.09, [150, 158, 170]);
  // flare stack
  drawLine(x + w * 0.06, y + h * 0.80, x + w * 0.06, y + h * 0.30, 2.4, steel);
  flame(x + w * 0.06, y + h * 0.30, h * 0.05, [240, 140, 40], [250, 200, 80]);
  if (withFire) {
    flame(x + w * 0.34, y + h * 0.24, h * 0.11, [225, 90, 30], [250, 190, 70]);
    flame(x + w * 0.56, y + h * 0.30, h * 0.09, [225, 90, 30], [250, 190, 70]);
    smoke(x + w * 0.34, y + h * 0.10, h * 0.09, [90, 92, 98]);
    smoke(x + w * 0.58, y + h * 0.14, h * 0.08, [90, 92, 98]);
  }
  if (withDrones) {
    for (const [fx, fy] of [[0.22, 0.16], [0.48, 0.10], [0.66, 0.20], [0.86, 0.12]]) {
      const dxp = x + w * fx, dyp = y + h * fy, s = h * 0.07;
      drawLine(dxp - s, dyp - s * 0.5, dxp + s, dyp + s * 0.5, 1.4, [40, 44, 52]);
      drawLine(dxp - s, dyp + s * 0.5, dxp + s, dyp - s * 0.5, 1.4, [40, 44, 52]);
      fillCircle(dxp, dyp, s * 0.32, [40, 44, 52]);
      // red X over drone
      drawLine(dxp - s * 1.25, dyp - s * 1.25, dxp + s * 1.25, dyp + s * 1.25, 1.6, RED);
      drawLine(dxp - s * 1.25, dyp + s * 1.25, dxp + s * 1.25, dyp - s * 1.25, 1.6, RED);
    }
  }
}

function skyline(x, y, w, h, mode) {
  fillRect(x, y, w, h, [214, 224, 233]);
  const heights = [0.55, 0.8, 0.45, 0.9, 0.62, 0.75, 0.5, 0.85];
  const bw = w / heights.length;
  for (let i = 0; i < heights.length; i++) {
    const bx = x + i * bw + 1.5;
    const bh = h * heights[i];
    const by = y + h - bh;
    fillRect(bx, by, bw - 3, bh, [88, 100, 118]);
    // windows
    for (let wy = by + 4; wy < y + h - 4; wy += 6) {
      for (let wx = bx + 3; wx < bx + bw - 5; wx += 6) {
        if (((wx * 7 + wy * 13) | 0) % 3 !== 0) fillRect(wx, wy, 2.4, 3, [240, 225, 160]);
      }
    }
  }
  if (mode === 'strike') {
    const ex = x + w * 0.42, ey = y + h * 0.30;
    const star = [];
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const r = i % 2 === 0 ? h * 0.30 : h * 0.13;
      star.push([ex + Math.cos(ang) * r, ey + Math.sin(ang) * r]);
    }
    fillPolygon(star, [240, 150, 40]);
    fillCircle(ex, ey, h * 0.10, [250, 205, 90]);
    smoke(ex + w * 0.1, ey - h * 0.12, h * 0.10, [95, 98, 105]);
  } else if (mode === 'smoke') {
    smoke(x + w * 0.30, y + h * 0.22, h * 0.11, [95, 98, 105]);
    smoke(x + w * 0.62, y + h * 0.16, h * 0.13, [95, 98, 105]);
    flame(x + w * 0.62, y + h * 0.34, h * 0.07, [225, 90, 30], [250, 190, 70]);
  }
}

function houseScene(x, y, w, h) {
  fillRect(x, y, w, h, [222, 232, 240]);
  fillRect(x, y + h * 0.82, w, h * 0.18, [150, 170, 120]);
  const hx = x + w * 0.16, hy = y + h * 0.42, hw = w * 0.42, hh = h * 0.40;
  fillRect(hx, hy, hw, hh, [245, 240, 228]);
  fillPolygon([[hx - 4, hy], [hx + hw / 2, hy - h * 0.24], [hx + hw + 4, hy]], [150, 60, 50]);
  fillRect(hx + hw * 0.40, hy + hh * 0.38, hw * 0.20, hh * 0.62, [110, 75, 50]);
  fillRect(hx + hw * 0.10, hy + hh * 0.22, hw * 0.18, hh * 0.26, [250, 220, 130]);
  fillRect(hx + hw * 0.72, hy + hh * 0.22, hw * 0.18, hh * 0.26, [250, 220, 130]);
  // chimney + smoke
  fillRect(hx + hw * 0.72, hy - h * 0.20, hw * 0.12, h * 0.18, [150, 60, 50]);
  smoke(hx + hw * 0.78, hy - h * 0.26, h * 0.06, [160, 165, 172]);
  // thermometer
  const tx = x + w * 0.74;
  fillRect(tx, y + h * 0.16, 6, h * 0.52, [255, 255, 255]);
  strokeRect(tx, y + h * 0.16, 6, h * 0.52, [120, 130, 145], 1);
  fillRect(tx + 1.5, y + h * 0.30, 3, h * 0.38, RED);
  fillCircle(tx + 3, y + h * 0.72, 7, RED);
}

function tankerTruck(x, y, w, h) {
  fillRect(x, y, w, h, [226, 220, 200]);
  fillRect(x, y + h * 0.78, w, h * 0.22, [110, 108, 100]);
  const ty = y + h * 0.40;
  // tank body
  fillRect(x + w * 0.08, ty, w * 0.58, h * 0.30, [200, 120, 40]);
  fillCircle(x + w * 0.08, ty + h * 0.15, h * 0.15, [200, 120, 40]);
  fillCircle(x + w * 0.66, ty + h * 0.15, h * 0.15, [200, 120, 40]);
  fillRect(x + w * 0.08, ty + h * 0.12, w * 0.58, 2.5, [160, 90, 30]);
  // cab
  fillRect(x + w * 0.70, ty + h * 0.06, w * 0.16, h * 0.28, [70, 90, 120]);
  fillRect(x + w * 0.72, ty + h * 0.09, w * 0.10, h * 0.10, [190, 220, 240]);
  // wheels
  for (const fx of [0.16, 0.34, 0.52, 0.78]) fillCircle(x + w * fx, y + h * 0.76, h * 0.075, [35, 38, 44]);
  // fire
  flame(x + w * 0.30, ty + 2, h * 0.13, [225, 90, 30], [250, 190, 70]);
  flame(x + w * 0.50, ty + 2, h * 0.10, [225, 90, 30], [250, 190, 70]);
  smoke(x + w * 0.40, ty - h * 0.16, h * 0.10, [90, 92, 98]);
}

function courthouse(x, y, w, h) {
  fillRect(x, y, w, h, [224, 230, 238]);
  const cx = x + w / 2;
  fillPolygon([[cx - w * 0.38, y + h * 0.30], [cx, y + h * 0.08], [cx + w * 0.38, y + h * 0.30]], [120, 110, 95]);
  fillRect(cx - w * 0.38, y + h * 0.30, w * 0.76, h * 0.07, [140, 130, 112]);
  for (let i = 0; i < 5; i++) {
    const colx = cx - w * 0.32 + i * w * 0.155;
    fillRect(colx, y + h * 0.40, w * 0.055, h * 0.40, [238, 235, 226]);
  }
  fillRect(cx - w * 0.40, y + h * 0.80, w * 0.80, h * 0.07, [140, 130, 112]);
  fillRect(cx - w * 0.44, y + h * 0.88, w * 0.88, h * 0.06, [120, 110, 95]);
  // scales
  drawLine(cx, y + h * 0.44, cx, y + h * 0.62, 1.6, GOLD);
  drawLine(cx - w * 0.10, y + h * 0.47, cx + w * 0.10, y + h * 0.47, 1.4, GOLD);
  fillPolygon([[cx - w * 0.14, y + h * 0.56], [cx - w * 0.06, y + h * 0.56], [cx - w * 0.10, y + h * 0.47]], GOLD);
  fillPolygon([[cx + w * 0.06, y + h * 0.56], [cx + w * 0.14, y + h * 0.56], [cx + w * 0.10, y + h * 0.47]], GOLD);
}

function twoFlags(x, y, w, h) {
  fillRect(x, y, w, h, [200, 222, 238]);
  fillRect(x, y + h * 0.80, w, h * 0.20, [140, 175, 120]);
  const pole = (fx, draw) => {
    const px = x + w * fx;
    drawLine(px, y + h * 0.14, px, y + h * 0.84, 2.2, [90, 80, 70]);
    draw(px, y + h * 0.16, w * 0.30, h * 0.30);
  };
  // Australia-ish: blue field, stars
  pole(0.14, (px, py, fw, fh) => {
    fillRect(px, py, fw, fh, [30, 60, 140]);
    fillRect(px, py, fw * 0.5, fh * 0.5, [30, 60, 140]);
    drawLine(px, py, px + fw * 0.5, py + fh * 0.5, 2, WHITE);
    drawLine(px + fw * 0.5, py, px, py + fh * 0.5, 2, WHITE);
    fillRect(px, py + fh * 0.2, fw * 0.5, fh * 0.1, RED);
    fillRect(px + fw * 0.2, py, fw * 0.1, fh * 0.5, RED);
    for (const [sx2, sy2] of [[0.75, 0.3], [0.68, 0.62], [0.85, 0.55], [0.25, 0.75]]) {
      fillCircle(px + fw * sx2, py + fh * sy2, 2.2, WHITE);
    }
  });
  // Solomon-ish: diagonal stripes
  pole(0.56, (px, py, fw, fh) => {
    fillPolygon([[px, py], [px + fw, py], [px, py + fh]], [30, 120, 70]);
    fillPolygon([[px + fw, py], [px + fw, py + fh], [px, py + fh]], [40, 90, 180]);
    drawLine(px, py + fh, px + fw, py, fh * 0.16, [240, 200, 40]);
    for (let i = 0; i < 3; i++) fillCircle(px + fw * (0.14 + i * 0.13), py + fh * 0.18, 1.8, WHITE);
  });
}

function factory(x, y, w, h) {
  fillRect(x, y, w, h, [220, 228, 234]);
  fillRect(x, y + h * 0.82, w, h * 0.18, [150, 150, 140]);
  const fx = x + w * 0.10, fy = y + h * 0.82;
  // sawtooth roof building
  fillRect(fx, fy - h * 0.34, w * 0.62, h * 0.34, [170, 120, 90]);
  for (let i = 0; i < 3; i++) {
    const sx = fx + i * w * 0.21;
    fillPolygon([[sx, fy - h * 0.34], [sx + w * 0.21, fy - h * 0.34], [sx + w * 0.21, fy - h * 0.52]], [140, 95, 70]);
  }
  // chimney
  fillRect(fx + w * 0.66, fy - h * 0.62, w * 0.07, h * 0.62, [130, 90, 70]);
  smoke(fx + w * 0.70, fy - h * 0.68, h * 0.07, [170, 175, 182]);
  // windows row
  for (let i = 0; i < 6; i++) fillRect(fx + 6 + i * w * 0.10, fy - h * 0.24, w * 0.06, h * 0.12, [250, 225, 160]);
  // workers silhouettes
  for (const fx2 of [0.80, 0.88]) {
    const wx = x + w * fx2, wy = fy;
    fillCircle(wx, wy - h * 0.20, h * 0.05, [50, 55, 65]);
    fillRect(wx - h * 0.035, wy - h * 0.15, h * 0.07, h * 0.15, [50, 55, 65]);
  }
}

// ---------------------------------------------------------------------------
// World map (simplified continent outlines, equirectangular projection)
// ---------------------------------------------------------------------------

const CONTINENTS = [
  // North America
  [[-168,66],[-158,71],[-141,70],[-130,70],[-122,70],[-115,68],[-108,68],[-100,69],[-92,69],[-86,66],[-82,64],[-80,60],[-78,56],[-74,58],[-68,58],[-64,52],[-60,47],[-65,44],[-70,44],[-71,41],[-74,39],[-76,35],[-79,33],[-81,29],[-81,25],[-83,28],[-86,30],[-90,29],[-94,29],[-97,27],[-97,23],[-95,19],[-92,15],[-88,14],[-84,12],[-81,9],[-78,8],[-77,7],[-80,9],[-83,10],[-86,13],[-87,16],[-88,20],[-90,21],[-91,19],[-94,18],[-96,16],[-100,17],[-104,20],[-107,23],[-110,24],[-112,28],[-115,31],[-118,33],[-121,35],[-123,39],[-124,44],[-125,49],[-129,52],[-133,57],[-137,59],[-143,60],[-150,60],[-154,58],[-159,56],[-162,59],[-166,60],[-168,66]],
  // Greenland
  [[-46,60],[-36,63],[-28,66],[-22,70],[-19,74],[-24,78],[-32,81],[-45,81],[-56,78],[-58,73],[-54,68],[-52,63],[-48,60],[-46,60]],
  // South America
  [[-77,7],[-74,10],[-70,12],[-64,11],[-60,9],[-56,6],[-52,5],[-50,1],[-46,-1],[-42,-3],[-36,-6],[-35,-9],[-38,-13],[-39,-16],[-40,-21],[-44,-23],[-48,-26],[-51,-30],[-53,-34],[-56,-36],[-58,-39],[-61,-41],[-63,-42],[-65,-45],[-66,-48],[-67,-51],[-68,-54],[-69,-55],[-71,-54],[-73,-52],[-74,-48],[-73,-44],[-73,-40],[-72,-35],[-71,-30],[-70,-24],[-70,-19],[-72,-18],[-75,-16],[-77,-13],[-79,-9],[-81,-5],[-80,-1],[-77,2],[-77,5],[-77,7]],
  // Europe (mainland)
  [[-9,44],[-9,38],[-9,37],[-6,36],[-2,37],[0,39],[3,42],[6,43],[8,44],[10,44],[12,45],[14,46],[16,45],[18,43],[19,41],[21,39],[22,37],[24,37],[26,38],[27,40],[26,42],[28,44],[30,46],[31,47],[35,46],[38,47],[39,49],[37,52],[35,55],[33,57],[31,59],[30,61],[28,64],[26,67],[24,70],[20,70],[15,68],[11,65],[7,63],[5,61],[5,59],[7,58],[9,57],[10,56],[8,55],[6,54],[3,53],[1,51],[-1,50],[-3,49],[-5,48],[-2,46],[-1,44],[-4,43],[-8,44],[-9,44]],
  // Britain
  [[-5,50],[-3,51],[-1,52],[0,54],[-1,56],[-3,58],[-5,58],[-6,56],[-5,53],[-4,52],[-5,50]],
  // Iceland
  [[-22,64],[-15,64],[-14,66],[-19,66],[-22,65],[-22,64]],
  // Africa
  [[-17,15],[-17,20],[-15,25],[-13,28],[-10,31],[-7,34],[-6,35],[-2,35],[3,37],[8,37],[11,34],[13,33],[20,32],[25,32],[30,31],[32,30],[34,28],[35,25],[37,22],[38,19],[39,16],[40,14],[42,13],[44,12],[48,11],[51,11],[51,10],[48,6],[44,0],[42,-4],[40,-9],[40,-14],[38,-18],[36,-21],[34,-25],[32,-28],[29,-31],[26,-34],[21,-35],[18,-33],[16,-29],[14,-24],[13,-19],[12,-14],[13,-10],[11,-5],[9,-1],[9,3],[7,4],[4,6],[1,6],[-3,5],[-6,4],[-9,5],[-12,8],[-15,11],[-17,14],[-17,15]],
  // Madagascar
  [[44,-16],[47,-14],[49,-15],[50,-18],[48,-22],[46,-24],[44,-22],[43,-18],[44,-16]],
  // Middle East + Asia (one landmass)
  [[28,41],[33,37],[36,36],[36,33],[35,30],[34,28],[35,25],[37,22],[39,19],[41,15],[42,13],[44,12],[47,13],[50,15],[53,16],[55,17],[57,19],[59,21],[59,23],[57,25],[55,26],[53,27],[51,28],[49,29],[50,26],[49,24],[47,24],[46,25],[44,26],[42,28],[41,31],[42,35],[44,37],[47,38],[48,40],[50,42],[52,44],[50,46],[48,48],[49,50],[52,52],[55,53],[58,54],[61,55],[66,56],[71,57],[75,58],[80,59],[86,60],[92,61],[98,62],[104,63],[110,64],[116,65],[122,66],[128,67],[134,68],[140,69],[146,70],[152,70],[158,69],[164,68],[170,67],[175,66],[178,66],[178,64],[170,63],[162,61],[158,58],[156,54],[153,50],[150,47],[147,44],[144,41],[142,38],[141,35],[139,36],[137,34],[134,33],[131,32],[128,30],[125,29],[122,28],[120,26],[118,24],[116,22],[113,21],[110,20],[108,17],[107,13],[106,9],[104,7],[103,3],[101,3],[100,6],[99,9],[98,12],[97,15],[95,16],[93,18],[91,22],[89,22],[87,21],[85,19],[82,17],[80,14],[79,10],[77,8],[76,10],[74,14],[72,19],[70,21],[68,23],[66,25],[63,25],[60,24],[58,23],[56,24],[54,25],[52,26],[50,27],[48,29],[46,29],[44,29],[43,30],[42,32],[40,34],[38,36],[35,36],[33,36],[30,37],[28,39],[28,41]],
  // Japan
  [[130,31],[132,33],[135,34],[137,35],[139,35],[140,37],[141,40],[141,43],[142,44],[143,43],[141,41],[140,38],[139,37],[136,35],[133,34],[131,32],[130,31]],
  // Sumatra
  [[95,5],[97,3],[100,0],[103,-3],[105,-5],[104,-6],[101,-3],[98,1],[95,4],[95,5]],
  // Java
  [[106,-6],[110,-6],[114,-7],[114,-8],[109,-8],[106,-7],[106,-6]],
  // Borneo
  [[109,1],[110,3],[113,4],[116,6],[118,5],[119,1],[117,-2],[114,-3],[111,-2],[109,1]],
  // Sulawesi
  [[119,0],[120,1],[122,0],[121,-2],[120,-4],[119,-2],[119,0]],
  // New Guinea
  [[131,-1],[134,-2],[138,-2],[142,-3],[146,-5],[147,-8],[144,-7],[140,-7],[136,-4],[133,-3],[131,-1]],
  // Australia
  [[113,-22],[114,-26],[115,-31],[116,-34],[118,-35],[122,-34],[126,-33],[130,-32],[133,-32],[135,-35],[137,-35],[138,-36],[139,-37],[141,-38],[144,-38],[146,-38],[148,-38],[150,-37],[151,-34],[153,-31],[153,-28],[152,-25],[150,-22],[148,-20],[146,-19],[144,-16],[143,-13],[142,-11],[142,-14],[141,-16],[141,-18],[139,-18],[137,-16],[136,-13],[135,-12],[133,-12],[131,-12],[129,-14],[127,-14],[124,-16],[122,-17],[119,-19],[116,-20],[114,-21],[113,-22]],
  // New Zealand (North + South simplified as one)
  [[173,-35],[175,-37],[178,-38],[177,-40],[175,-41],[174,-41],[173,-39],[172,-37],[173,-35]],
  [[172,-41],[174,-42],[173,-44],[170,-45],[168,-46],[167,-46],[168,-44],[170,-43],[172,-41]],
  // Philippines (simplified)
  [[120,18],[121,16],[122,13],[121,10],[122,8],[121,6],[120,8],[120,12],[120,16],[120,18]],
  // Sri Lanka
  [[80,10],[81,8],[80,6],[80,8],[80,10]],
];

function drawMap(x, y, w, h, stories) {
  fillRect(x, y, w, h, [214, 228, 236]);
  strokeRect(x, y, w, h, [150, 168, 182], 0.8);
  const lonMin = -172, lonMax = 192, latMax = 80, latMin = -58;
  const proj = (lon, lat) => [
    x + ((lon - lonMin) / (lonMax - lonMin)) * w,
    y + ((latMax - lat) / (latMax - latMin)) * h,
  ];
  // graticule
  for (let lon = -150; lon <= 180; lon += 30) {
    const [gx] = proj(lon, 0);
    drawLine(gx, y, gx, y + h, 0.4, [188, 204, 216]);
  }
  for (let lat = -30; lat <= 60; lat += 30) {
    const [, gy] = proj(0, lat);
    drawLine(x, gy, x + w, gy, 0.4, [188, 204, 216]);
  }
  for (const poly of CONTINENTS) {
    const pts = poly.map(p => proj(p[0], p[1]));
    fillPolygon(pts, LAND);
    strokePolygon(pts, LAND_LINE, 0.7);
  }
  // pins
  for (const s of stories) {
    const [px, py] = proj(s.lon, s.lat);
    const ox = px + (s.dx || 0), oy = py + (s.dy || 0);
    const col = REGION_COLORS[s.region] || INK;
    fillCircle(ox, oy, 4.6, WHITE);
    fillCircle(ox, oy, 3.9, col);
    drawTextCentered(String(s.n), ox, oy + 1.7, sansB, 4.8, WHITE);
  }
}

// ---------------------------------------------------------------------------
// Story data — 48 stories, all first reported Wednesday 25 November 2026
// ---------------------------------------------------------------------------

const STORIES = [
  // ---- Leads (1-3) ----
  { n: 1, place: 'WASHINGTON', field: 'Trade', region: 'N. AMERICA', badge: 'CONFIRMED', lon: -77, lat: 39,
    headline: 'US proposes tariffs of up to 20% on EU, China and 12 more',
    text: "The USTR cites 'excess capacity' in 14 economies: China 20%, India 25%, Vietnam 35%, EU 15%. Nothing is in force yet — hearings are set for January 2027.",
    why: 'The widest tariff salvo since the spring court ruling.', outlets: 'USTR · Reuters · CNBC' },
  { n: 2, place: 'SEOUL', field: 'Markets', region: 'EAST & SE ASIA', badge: 'CONFIRMED', lon: 127, lat: 37,
    headline: 'AI doubts sink Asian chip stocks; Kospi closes down 6.2%',
    text: "Kospi ends at 4,697.51. SK Hynix −11.1%, Samsung −9.9%, Taiwan's Taiex −4.8%, Japan's Nikkei −2.8% as the AI sell-off deepens.",
    why: 'Investors doubt the AI boom will ever pay for itself.', outlets: 'Yonhap · Reuters' },
  { n: 3, place: 'JIUQUAN', field: 'Space', region: 'EAST & SE ASIA', badge: 'CONFIRMED', lon: 100, lat: 41,
    headline: "Pakistan's first astronaut docks at China's Tiangong station",
    text: 'Shenzhou-24 lifted off at 00:18 UTC and docked at 03:56. Muhammad Zeeshan Ali, 40, is the first foreigner aboard Tiangong; he stays 5–10 days with Tang Hongbo and Wu Yi.',
    why: "China's station takes its first foreign astronaut.", outlets: 'CMSA · Xinhua · Reuters' },
  // ---- Cards (4-13) ----
  { n: 4, place: 'STRAIT OF HORMUZ', field: 'Energy', region: 'MIDDLE EAST', badge: 'CLAIM', lon: 56, lat: 26,
    headline: 'Iran says two tankers hit mines in Hormuz',
    text: "IRGC Navy says the ships took an 'unauthorised route'. Not independently confirmed.", outlets: 'Reuters' },
  { n: 5, place: 'RAS TANURA', field: 'War', region: 'MIDDLE EAST', badge: 'OFFICIAL', lon: 50, lat: 27,
    headline: 'Saudis down four Houthi drones after Hodeidah strike',
    text: 'Coalition: 4 drones destroyed, no casualties. Houthis claim fires (CLAIM).', outlets: 'Reuters' },
  { n: 6, place: 'KYIV', field: 'War', region: 'EUROPE', badge: 'REPORTED', lon: 31, lat: 50,
    headline: 'Russian strikes kill 5, cut power in 5 regions',
    text: 'Zaporizhzhia plant on diesel after 17th grid loss this year.', outlets: 'Reuters · AP' },
  { n: 7, place: 'SAMARA', field: 'War', region: 'EUROPE', badge: 'REPORTED', lon: 50, lat: 53,
    headline: 'Ukrainian drones set two Russian refineries ablaze',
    text: 'Syzran and Kuibyshev plants hit overnight.', outlets: 'Reuters' },
  { n: 8, place: 'LONDON', field: 'Energy', region: 'EUROPE', badge: 'OFFICIAL', lon: 0, lat: 51,
    headline: 'UK energy price cap to rise 26% in January',
    text: 'Ofgem lifts typical bill £1,723 → £2,166 from 1 January.', outlets: 'Ofgem' },
  { n: 9, place: 'CAIRO', field: 'Disaster', region: 'N. AFRICA', badge: 'REPORTED', lon: 31, lat: 30,
    headline: 'Fuel tanker fire kills at least 30 near Cairo',
    text: 'Tanker overturned and exploded on a ring road — Health Ministry.', outlets: 'Reuters · AP' },
  { n: 10, place: 'GAZA', field: 'War', region: 'MIDDLE EAST', badge: 'CONFIRMED', lon: 34, lat: 31,
    headline: 'Israeli strike kills Hamas security chief in Shati',
    text: 'Abu al-Awf, wife and two daughters killed pre-dawn; IDF confirms.', outlets: 'Al Jazeera · AP' },
  { n: 11, place: 'PRETORIA', field: 'Justice', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 28, lat: -26,
    headline: "Court lifts 'Farmgate' threat to Ramaphosa",
    text: 'Judges void the 2022 panel report behind the impeachment push.', outlets: 'News24' },
  { n: 12, place: 'HONIARA', field: 'Diplomacy', region: 'OCEANIA', badge: 'OFFICIAL', lon: 160, lat: -9,
    headline: 'Solomons sign security pact with Australia',
    text: 'Canberra the primary security partner; no foreign base in islands.', outlets: "PM's office · Reuters" },
  { n: 13, place: 'DHAKA', field: 'Labour', region: 'SOUTH ASIA', badge: 'CONFIRMED', lon: 90, lat: 24,
    headline: 'Garment wage up 36% to 17,000 taka',
    text: 'Wage board votes 4–2; 481 factories had halted. From 1 December.', outlets: 'Reuters · AFP' },
  // ---- Briefs (14-48) ----
  { n: 14, place: 'BOGOR', field: 'Disaster', region: 'EAST & SE ASIA', badge: 'OFFICIAL', lon: 107, lat: -7,
    text: '26 miners trapped ~100 m down a flooded illegal gold pit; rescue ongoing, police confirm.', outlets: 'CNN Indonesia' },
  { n: 15, place: 'JERUSALEM', field: 'Justice', region: 'MIDDLE EAST', badge: 'REPORTED', lon: 35, lat: 32,
    text: "Judges urge rethink of Netanyahu graft charges, citing 'considerable difficulties'; PM: 'trial must end'.", outlets: 'AP' },
  { n: 16, place: 'SYDNEY', field: 'Economy', region: 'OCEANIA', badge: 'OFFICIAL', lon: 151, lat: -34,
    text: 'Inflation jumps to 4.9% in October, from 4.3%; housing +6.4%.', outlets: 'ABS' },
  { n: 17, place: 'NEW YORK', field: 'Rights', region: 'GLOBAL', badge: 'OFFICIAL', lon: -74, lat: 40,
    text: 'UN: five women an hour killed by partner or kin — 47,000 in 2025 — as 16 Days of Activism begins.', outlets: 'UN' },
  { n: 18, place: 'BEIJING', field: 'Tech', region: 'EAST & SE ASIA', badge: 'REPORTED', lon: 116, lat: 40,
    text: "Huawei rejects US guilty verdict (Brooklyn, Tue), slams 'suppression'; guilty on 10 of 12 counts.", outlets: 'SCMP · Reuters' },
  { n: 19, place: 'SAN JUAN', field: 'Culture', region: 'LATIN AMERICA', badge: 'REPORTED', lon: -66, lat: 18,
    text: "Puerto Rico's Jennifer Barreto wins Miss Universe at home, first mother to take the crown.", outlets: 'Gulf News' },
  { n: 20, place: 'HODEIDAH', field: 'War', region: 'MIDDLE EAST', badge: 'REPORTED', lon: 43, lat: 15,
    text: 'Saudi-led coalition strikes the port on Wednesday.', outlets: 'Reuters · AFP' },
  { n: 21, place: 'GAZA', field: 'Rights', region: 'MIDDLE EAST', badge: 'REPORTED', lon: 34, lat: 31, dx: 5, dy: 5,
    text: "Amnesty: 22,331 women and girls among Gaza's 74,237 dead (30.1%); calls for ICC probe.", outlets: 'Amnesty' },
  { n: 22, place: 'DAMAZIN', field: 'War', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 34, lat: 12,
    text: 'RSF drones kill at least 19 in Blue Nile; 20–22 injured.', outlets: 'local reports' },
  { n: 23, place: 'PYONGYANG', field: 'Diplomacy', region: 'EAST & SE ASIA', badge: 'CONFIRMED', lon: 126, lat: 39, dx: -5, dy: 5,
    text: 'North Korea expels Swiss envoy Sylvain Astier, orders Pyongyang office closed; 48 hours to leave.', outlets: 'Reuters · Yonhap' },
  { n: 24, place: 'KUALA LUMPUR', field: 'Tech', region: 'EAST & SE ASIA', badge: 'OFFICIAL', lon: 102, lat: 3,
    text: 'MCMC sues Google for RM600m over harmful YouTube content; 74,703 reports filed.', outlets: 'Reuters' },
  { n: 25, place: 'ENUGU', field: 'Culture', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 7, lat: 6,
    text: "Nollywood legend Pete Edochie dies at 79; family: 'An Iroko Has Fallen'.", outlets: 'BBC Africa' },
  { n: 26, place: 'AMMAN', field: 'Justice', region: 'MIDDLE EAST', badge: 'OFFICIAL', lon: 36, lat: 32, dx: 5, dy: -5,
    text: 'Jordan sentences a man to death over an attack that killed an officer.', outlets: 'Reuters' },
  { n: 27, place: 'IOWA', field: 'Science', region: 'N. AMERICA', badge: 'OFFICIAL', lon: -93, lat: 41,
    text: 'US Army detonates five tons of lead azide — the entire US stockpile — at Iowa plant.', outlets: 'Reuters' },
  { n: 28, place: 'CANBERRA', field: 'Rights', region: 'OCEANIA', badge: 'OFFICIAL', lon: 149, lat: -35,
    text: 'Australia formally apologises to LGBTQ+ defence personnel; old convictions to be extinguished.', outlets: 'Reuters' },
  { n: 29, place: 'DARMSTADT', field: 'Science', region: 'EUROPE', badge: 'OFFICIAL', lon: 9, lat: 50,
    text: "ESA's Hera releases first close-up images of asteroid Dimorphos, four years after DART.", outlets: 'ESA' },
  { n: 30, place: 'FRANKFURT', field: 'Markets', region: 'EUROPE', badge: 'REPORTED', lon: 9, lat: 50, dx: 6, dy: 5,
    text: 'European shares edge up 0.5% (STOXX 600 at 636.01) on consumer boost.', outlets: 'Reuters' },
  { n: 31, place: 'CENTURION', field: 'Sport', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 28, lat: -26, dx: 6, dy: 5,
    text: 'South Africa pile up 494/7 vs Bangladesh; Ackerman 150 off 138 balls.', outlets: 'Daily Sports' },
  { n: 32, place: 'MADRID', field: 'Sport', region: 'EUROPE', badge: 'REPORTED', lon: -4, lat: 40,
    text: 'Champions League: Real Madrid rout PSV 5-1; Arsenal held 1-1 by Dortmund.', outlets: 'IANS' },
  { n: 33, place: 'ATHENS', field: 'Labour', region: 'EUROPE', badge: 'REPORTED', lon: 24, lat: 38,
    text: 'Greeks strike nationwide over wages and public services; transport disrupted.', outlets: 'Reuters' },
  { n: 34, place: 'CARTAGENA', field: 'Crime', region: 'LATIN AMERICA', badge: 'CONFIRMED', lon: -76, lat: 10,
    text: 'Supermarket hostage siege ends: all hostages rescued, one captor killed.', outlets: 'Reuters' },
  { n: 35, place: 'TONKA', field: 'War', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: -3, lat: 17,
    text: "JNIM gives residents until Friday to leave, then blockade; violators 'military targets'.", outlets: 'RFI' },
  { n: 36, place: 'JAKARTA', field: 'Environment', region: 'EAST & SE ASIA', badge: 'REPORTED', lon: 107, lat: -6, dx: -6, dy: -5,
    text: 'Seized forest land (338,536 ha) goes to a Danantara unit, Reuters identifies.', outlets: 'Reuters' },
  { n: 37, place: 'ADEN', field: 'War', region: 'MIDDLE EAST', badge: 'REPORTED', lon: 45, lat: 13,
    text: 'Houthis encircle Aden, ~60 km out; residents prepare to flee.', outlets: 'Guardian' },
  { n: 38, place: 'MALI', field: 'War', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: -1, lat: 19, dx: 6, dy: -5,
    text: 'African insurgents fly off-the-shelf FPV drones against Russian Africa Corps.', outlets: 'Reuters' },
  { n: 39, place: 'LUSAKA', field: 'Justice', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 28, lat: -15,
    text: 'Four of 18 Zambia treason-accused freed; bail ruling postponed.', outlets: 'QNC News' },
  { n: 40, place: 'LAGOS', field: 'Business', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 3, lat: 7, dx: -6, dy: 4,
    text: "Payaza acquires Ghana's Seesail; Cell C completes Melon Mobile deal.", outlets: 'BusinessTechAfrica' },
  { n: 41, place: 'ABUJA', field: 'Politics', region: 'SUB-SAHARAN AFRICA', badge: 'REPORTED', lon: 7, lat: 9, dx: 6, dy: -4,
    text: 'Nigeria Senate approves loan requests President Tinubu had withdrawn.', outlets: 'Premium Times' },
  { n: 42, place: 'NEW DELHI', field: 'Justice', region: 'SOUTH ASIA', badge: 'REPORTED', lon: 77, lat: 29,
    text: 'Supreme Court issues notice on Umar Khalid, Sharjeel Imam bail pleas; no interim bail.', outlets: 'LiveLaw' },
  { n: 43, place: 'LAHORE', field: 'Sport', region: 'SOUTH ASIA', badge: 'OFFICIAL', lon: 74, lat: 31, dx: -6, dy: -4,
    text: "Fatima Sana reinstated as Pakistan women's captain for West Indies tour.", outlets: 'IANS' },
  { n: 44, place: 'BRISBANE', field: 'Sport', region: 'OCEANIA', badge: 'REPORTED', lon: 153, lat: -27,
    text: 'Pacer Xavier Bartlett has knee surgery, out 4–6 weeks.', outlets: 'IANS' },
  { n: 45, place: 'LUCKNOW', field: 'Sport', region: 'SOUTH ASIA', badge: 'REPORTED', lon: 81, lat: 27, dx: 6, dy: 5,
    text: 'Syed Modi: Chico Wardoyo and Richie Richardo win in round of 32.', outlets: 'PBSI' },
  { n: 46, place: 'LONDON', field: 'Markets', region: 'GLOBAL', badge: 'REPORTED', lon: 0, lat: 51, dx: -7, dy: -5,
    text: 'Brent slips to $90.96, WTI $81.54; Goldman raises December targets.', outlets: 'market reports' },
  { n: 47, place: 'LONDON', field: 'Markets', region: 'GLOBAL', badge: 'REPORTED', lon: 0, lat: 51, dx: 7, dy: 6,
    text: 'Gold eases to $3,544.54/oz in early trade.', outlets: 'Reuters' },
  { n: 48, place: 'NEW DELHI', field: 'Justice', region: 'SOUTH ASIA', badge: 'REPORTED', lon: 77, lat: 29, dx: -7, dy: 6,
    text: 'Saurav Das moves Delhi High Court after being stopped from flying to UK.', outlets: 'LiveLaw' },
];

const REGION_ORDER = ['N. AMERICA', 'LATIN AMERICA', 'EUROPE', 'MIDDLE EAST', 'N. AFRICA', 'SUB-SAHARAN AFRICA', 'SOUTH ASIA', 'EAST & SE ASIA', 'OCEANIA', 'GLOBAL'];
const REGION_SHORT = {
  'N. AMERICA': 'N.AM', 'LATIN AMERICA': 'LATIN AM', 'EUROPE': 'EUROPE', 'MIDDLE EAST': 'MID EAST',
  'N. AFRICA': 'N.AFRICA', 'SUB-SAHARAN AFRICA': 'SUB-SAHARA', 'SOUTH ASIA': 'S.ASIA',
  'EAST & SE ASIA': 'E&SE ASIA', 'OCEANIA': 'OCEANIA', 'GLOBAL': 'GLOBAL',
};

const BADGE_COLORS = {
  CONFIRMED: [23, 126, 122],
  OFFICIAL: [22, 50, 79],
  REPORTED: [120, 110, 60],
  CLAIM: [179, 35, 42],
};
const BADGE_LETTER = { CONFIRMED: 'C', OFFICIAL: 'O', REPORTED: 'R', CLAIM: 'CL' };

function drawBadge(x, y, badge, small) {
  const c = BADGE_COLORS[badge] || GREY;
  if (small) {
    const t = BADGE_LETTER[badge];
    const tw = measureText(t, sansB, 7);
    fillRect(x, y, tw + 6, 11, c);
    drawText(t, x + 3, y + 8.5, sansB, 7, WHITE);
    return tw + 6;
  }
  const tw = measureText(badge, sansB, 7.5);
  fillRect(x, y, tw + 8, 12, c);
  drawText(badge, x + 4, y + 9.5, sansB, 7.5, WHITE);
  return tw + 8;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

const X0 = 16, X1 = 1008, CW = X1 - X0;

function rule(y, lw, c) {
  fillRect(X0, y, CW, lw || 1, c || INK);
}

function drawBrief(x, y, w, s) {
  const size = 7.5, lh = 8.8;
  const col = REGION_COLORS[s.region] || INK;
  const prefix = s.n + ' ' + s.place + ' · ' + s.field + ' — ';
  const pw = measureText(prefix, sansB, size);
  const words = s.text.split(' ');
  const lines = [];
  let cur = '', limit = w - pw;
  for (const word of words) {
    const trial = cur === '' ? word : cur + ' ' + word;
    if (measureText(trial, sans, size) <= limit || cur === '') {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
      limit = w;
    }
  }
  if (cur !== '') lines.push(cur);
  drawText(prefix, x, y, sansB, size, col);
  for (let i = 0; i < lines.length; i++) {
    drawText(lines[i], i === 0 ? x + pw : x, y + i * lh, sans, size, INK);
  }
  // badge letter + outlets at end of last line (or a new line)
  const tail = ' [' + BADGE_LETTER[s.badge] + '] ' + s.outlets;
  const lastW = measureText(lines[lines.length - 1], sans, size) + (lines.length === 1 ? pw : 0);
  const tailW = measureText(tail, sans, 7);
  let extra = 0;
  if (lastW + tailW <= w) {
    drawText(tail, x + lastW, y + (lines.length - 1) * lh, sans, 7, GREY);
  } else {
    drawText(tail.trim(), x, y + lines.length * lh, sans, 7, GREY);
    extra = 1;
  }
  return (lines.length + extra) * lh + 2.5;
}

function renderPage() {
  fillAll(PAPER);
  // frame
  strokeRect(6, 6, 1012, 1012, INK, 2.2);
  strokeRect(11, 11, 1002, 1002, INK, 0.8);

  // ---- top strip ----
  drawText('THE WORLD IN ONE DAY', X0, 28, sansB, 11, INK, 1.4);
  drawTextRight('48 STORIES · 10 REGIONS · 19 FIELDS · ALL FIRST REPORTED ON WEDNESDAY 25 NOVEMBER 2026', X1, 28, sans, 8.2, GREY);
  rule(34, 1.6);
  rule(37.5, 0.7);

  // ---- masthead ----
  const mastSize = fitSize('Wednesday 25 November 2026', serifB, 54, CW);
  drawTextCentered('Wednesday 25 November 2026', 512, 80, serifB, mastSize, INK);
  const sub = "US proposes tariffs on 14 economies · AI doubts sink Asian chip stocks · Pakistan's first astronaut docks at Tiangong";
  const subSize = fitSize(sub, serifB, 13.5, CW);
  drawTextCentered(sub, 512, 100, serifB, subSize, RED);
  rule(108, 1);

  // ---- region bars ----
  const regionCounts = {};
  for (const s of STORIES) regionCounts[s.region] = (regionCounts[s.region] || 0) + 1;
  let bx = X0;
  for (const r of REGION_ORDER) {
    const cnt = regionCounts[r] || 0;
    const bw = (cnt / STORIES.length) * CW;
    fillRect(bx, 112, Math.max(2, bw - 1.5), 7, REGION_COLORS[r]);
    const label = REGION_SHORT[r] + ' ' + cnt;
    const ls = fitSize(label, sansB, 6.8, Math.max(18, bw - 3));
    drawTextCentered(label, bx + bw / 2, 130, sansB, ls, INK);
    bx += bw;
  }
  // ---- fields line ----
  const fieldCounts = {};
  for (const s of STORIES) fieldCounts[s.field] = (fieldCounts[s.field] || 0) + 1;
  const fieldList = Object.entries(fieldCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const fieldsText = 'FIELDS — ' + fieldList.map(([f, c]) => f + ' ' + c).join(' · ');
  const fs2 = fitSize(fieldsText, sans, 7.4, CW);
  drawTextCentered(fieldsText, 512, 144, sans, fs2, GREY);
  rule(150, 1);

  // ---- stats row ----
  const stats = [
    ['20%', 'top proposed US tariff, on China', RED],
    ['−6.2%', 'Kospi close in AI chip sell-off', NAVY],
    ['+26%', 'UK energy price cap from 1 January', TEAL],
    ['30+', 'killed in Cairo tanker fire', ORANGE],
    ['26', 'trapped in flooded Java gold pit', [142, 68, 173]],
    ['1st', "foreigner aboard China's Tiangong", GOLD],
  ];
  const statW = (CW - 5 * 5) / 6;
  stats.forEach(([num, label, col], i) => {
    const sx = X0 + i * (statW + 5);
    fillRect(sx, 154, statW, 46, CARD_BG);
    strokeRect(sx, 154, statW, 46, CARD_LINE, 0.8);
    fillRect(sx, 154, statW, 3.5, col);
    drawTextCentered(num, sx + statW / 2, 180, serifB, 20, INK);
    const lines = wrapText(label, sans, 7.4, statW - 10);
    lines.slice(0, 2).forEach((ln, li) => {
      drawTextCentered(ln, sx + statW / 2, 190 + li * 8.5, sans, 7.4, GREY);
    });
  });

  // ---- THE DAY IN UTC strip ----
  fillRect(X0, 204, CW, 28, [238, 234, 220]);
  drawText('THE DAY', X0 + 4, 216, sansB, 9.5, NAVY);
  drawText('IN UTC', X0 + 4, 228, sansB, 9.5, NAVY);
  const utc = [
    ['00:18', 'Shenzhou-24 lifts off'], ['00:30', 'Australia CPI 4.9%'],
    ['03:56', 'Tiangong docks'], ['05:30', 'Taiex closes −4.8%'],
    ['06:30', 'Kospi closes −6.2%'], ['06:35', 'Crew enters Tiangong'],
    ['10:59', 'Ofgem cap +26%'], ['13:00', 'US tariffs proposed'],
  ];
  const utcX = X0 + 78, utcW = (X1 - utcX) / 4;
  utc.forEach(([t, txt], i) => {
    const cx = utcX + (i % 4) * utcW;
    const cy = 216 + Math.floor(i / 4) * 13;
    drawText(t, cx, cy, sansB, 8.5, RED);
    drawText(txt, cx + 34, cy, sans, 8.2, INK);
  });
  rule(236, 1);

  // ---- leads ----
  const leadW = (CW - 2 * 10) / 3;
  const leadArt = [
    (x, y, w, h) => {
      containerShip(x, y, w, h);
      tariffBars(x, y, w, h, [['China', 20], ['India', 25], ['Vietnam', 35], ['EU', 15]]);
    },
    (x, y, w, h) => {
      chartPanel(x, y, w, h, [['KOSPI', '−6.2%'], ['SK HYNIX', '−11.1%'], ['SAMSUNG', '−9.9%'], ['TAIEX', '−4.8%'], ['NIKKEI', '−2.8%']]);
      drawText('4,697.51', x + w * 0.60, y + 25, sans, 6.5, [150, 175, 205]);
    },
    (x, y, w, h) => {
      rocketStation(x, y, w, h);
      artLabel(x + 5, y + 5, 'LIFT-OFF 00:18 UTC', [253, 251, 244], NAVY, 7.5);
      const t = 'DOCKED 03:56 UTC';
      const tw = measureText(t, sansB, 7.5) + 10;
      artLabel(x + w - tw - 5, y + h - 19, t, [253, 251, 244], NAVY, 7.5);
    },
  ];
  for (let i = 0; i < 3; i++) {
    const s = STORIES[i];
    const lx = X0 + i * (leadW + 10);
    const col = REGION_COLORS[s.region];
    fillCircle(lx + 9, 248, 8.5, RED);
    drawTextCentered(String(s.n), lx + 9, 251.5, sansB, 10, WHITE);
    drawText(s.place + ' · ' + s.field.toUpperCase(), lx + 22, 251.5, sansB, 8.5, col);
    const bwBadge = measureText(s.badge, sansB, 7.5) + 8;
    drawBadge(lx + leadW - bwBadge, 240, s.badge, false);
    setClip(lx, 256, leadW, 74);
    leadArt[i](lx, 256, leadW, 74);
    clearClip();
    strokeRect(lx, 256, leadW, 74, CARD_LINE, 0.8);
    let hy = 344;
    const hLines = wrapText(s.headline, serifB, 15, leadW).slice(0, 2);
    for (const ln of hLines) { drawText(ln, lx, hy, serifB, 15, INK); hy += 17; }
    hy += 1;
    const tLines = wrapText(s.text, sans, 8.8, leadW).slice(0, 3);
    for (const ln of tLines) { drawText(ln, lx, hy, sans, 8.8, [40, 48, 62]); hy += 10.5; }
    drawText('WHY IT MATTERS', lx, 408, sansB, 7.2, RED);
    drawTextRight(s.outlets, lx + leadW, 408, sans, 7.5, GREY);
    const whySize = fitSize(s.why, serif, 8.8, leadW);
    drawText(s.why, lx, 419, serif, whySize, NAVY);
  }
  rule(428, 1);

  // ---- cards ----
  const cardArt = {
    4: (x, y, w, h) => { tankerShips(x, y, w, h); artLabel(x + 4, y + 4, '2 TANKERS', NAVY, WHITE, 8.5); },
    5: (x, y, w, h) => { refineryTowers(x, y, w, h, false, true); artLabel(x + 4, y + 4, '4 DOWNED', NAVY, WHITE, 8.5); },
    6: (x, y, w, h) => { skyline(x, y, w, h, 'strike'); artLabel(x + 4, y + 4, '5 REGIONS', NAVY, WHITE, 8.5); },
    7: (x, y, w, h) => { refineryTowers(x, y, w, h, true, false); artLabel(x + 4, y + 4, '2 REFINERIES', NAVY, WHITE, 8.5); },
    8: (x, y, w, h) => { houseScene(x, y, w, h); artLabel(x + 4, y + 4, '+26% · £2,166', NAVY, WHITE, 8.5); },
    9: (x, y, w, h) => { tankerTruck(x, y, w, h); artLabel(x + 4, y + 4, '30+ DEAD', NAVY, WHITE, 8.5); },
    10: (x, y, w, h) => { skyline(x, y, w, h, 'smoke'); artLabel(x + 4, y + 4, 'SHATI CAMP', NAVY, WHITE, 8.5); },
    11: (x, y, w, h) => { courthouse(x, y, w, h); artLabel(x + 4, y + 4, 'VOIDED', NAVY, WHITE, 8.5); },
    12: (x, y, w, h) => { twoFlags(x, y, w, h); artLabel(x + 4, y + 4, 'NO FOREIGN BASE', NAVY, WHITE, 8.5); },
    13: (x, y, w, h) => { factory(x, y, w, h); artLabel(x + 4, y + 4, '17,000 TAKA', NAVY, WHITE, 8.5); },
  };
  const cardW = (CW - 4 * 5) / 5;
  const cardH = 95;
  for (let i = 0; i < 10; i++) {
    const s = STORIES[3 + i];
    const cx = X0 + (i % 5) * (cardW + 5);
    const cy = 432 + Math.floor(i / 5) * (cardH + 8);
    fillRect(cx, cy, cardW, cardH, CARD_BG);
    strokeRect(cx, cy, cardW, cardH, CARD_LINE, 0.8);
    setClip(cx + 2, cy + 2, cardW - 4, 30);
    cardArt[s.n](cx + 2, cy + 2, cardW - 4, 30);
    clearClip();
    const col = REGION_COLORS[s.region];
    drawText(s.n + ' ' + s.place + ' · ' + s.field.toUpperCase(), cx + 5, cy + 41, sansB, 6.8, col);
    const bwB = measureText(BADGE_LETTER[s.badge], sansB, 7) + 6;
    drawBadge(cx + cardW - bwB - 4, cy + 34, s.badge, true);
    let hy = cy + 52;
    for (const ln of wrapText(s.headline, serifB, 10.2, cardW - 10).slice(0, 2)) {
      drawText(ln, cx + 5, hy, serifB, 10.2, INK); hy += 11.5;
    }
    hy += 0.5;
    for (const ln of wrapText(s.text, sans, 7.6, cardW - 10).slice(0, 2)) {
      drawText(ln, cx + 5, hy, sans, 7.6, [40, 48, 62]); hy += 9;
    }
    drawText(s.outlets, cx + 5, cy + cardH - 4, sans, 6.8, GREY);
  }
  rule(634, 1);

  // ---- bottom: map + date check (left), briefs (right) ----
  const leftW = 300;
  drawText('WHERE IT HAPPENED', X0, 650, sansB, 9.5, NAVY);
  drawText(' — pins = story numbers', X0 + measureText('WHERE IT HAPPENED', sansB, 9.5), 650, sans, 8, GREY);
  setClip(X0, 654, leftW, 152);
  drawMap(X0, 654, leftW, 152, STORIES);
  clearClip();

  const dcY = 812;
  fillRect(X0, dcY, leftW, 138, [250, 246, 235]);
  strokeRect(X0, dcY, leftW, 138, CARD_LINE, 0.8);
  drawText('DATE CHECK — NOT 25 NOVEMBER, LEFT OUT ON PURPOSE', X0 + 6, dcY + 14, sansB, fitSize('DATE CHECK — NOT 25 NOVEMBER, LEFT OUT ON PURPOSE', sansB, 8, leftW - 12), RED);
  const dcLines = [
    '• Huawei convicted in Brooklyn — Tue 24 (reaction: story 18)',
    '• Nvidia reinstates Jensen Huang — Tue 24',
    "• Huang 'violated code of conduct' all-hands — Tue 24",
    '• Riyadh PIF tower drone strike, 11 hurt — Tue 24',
    '• Saudi-led strike on Hodeidah (first wave) — Tue 24',
    '• Senegal AFCON title restored by CAS — Tue 24',
    '• US consumer confidence 103.3 — Tue 24',
    '• COP31 collapse, Antalya — Sun 22',
    '• Ukraine sinks corvette at Benghazi — Sun 22',
    '• ICJ Myanmar genocide ruling — 19 Nov',
    'Not yet: US Thanksgiving (Thu 26) · tariff hearings (Jan 2027) · UK cap rise (1 Jan)',
  ];
  let dcy = dcY + 27;
  for (const ln of dcLines) {
    const sz = fitSize(ln, sans, 7.3, leftW - 12);
    drawText(ln, X0 + 6, dcy, sans, sz, [40, 48, 62]);
    dcy += 9.8;
  }
  // legend
  const legY = dcY + 150;
  drawText('CONFIRMED = 2+ outlets / primary data · OFFICIAL = authority’s own figure or act', X0, legY, sans, 6.9, GREY);
  drawText('REPORTED = major outlet report · CLAIM = one side’s account', X0, legY + 10, sans, 6.9, GREY);

  // briefs
  const briefX = X0 + leftW + 12;
  const briefW = X1 - briefX;
  drawText('ALSO ON WEDNESDAY 25 NOVEMBER — 35 MORE STORIES', briefX, 650, sansB, 10, INK);
  fillRect(briefX, 654, briefW, 1, RULE);
  const colW = (briefW - 2 * 10) / 3;
  const briefCols = [
    STORIES.slice(13, 25),
    STORIES.slice(25, 37),
    STORIES.slice(37, 48),
  ];
  briefCols.forEach((colStories, ci) => {
    const cx = briefX + ci * (colW + 10);
    let cy = 668;
    for (const s of colStories) {
      cy += drawBrief(cx, cy, colW, s);
    }
  });

  // ---- footer ----
  rule(994, 0.8, RULE);
  drawTextCentered('Sources: Reuters · AP · AFP · BBC · Al Jazeera · Xinhua · Yonhap · USTR · Ofgem · ESA · ABS · UN · News24 · LiveLaw — every drawing original. All 48 stories first reported on Wednesday 25 November 2026.', 512, 1007, sans, 7.2, GREY);
}

function main() {
  renderPage();
  const rgba = downscale();
  const png = encodePNG(rgba, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'entry.png'), png);
}

main();
