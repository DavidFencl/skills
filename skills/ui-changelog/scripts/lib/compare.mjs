// Pixel comparison of one before/after pair: pixelmatch diff image, shift-aware "circled changes"
// image with numbered regions, and for every region the matching box on the before image.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadDependency, slug } from './util.mjs';

export async function compareShot(outDir, shot, result, minDiffPixels = 0) {
  const { before, after } = result;
  if (before.absent && after.file) return { status: 'added' };
  if (after.absent && before.file) return { status: 'removed' };
  if (!before.file || !after.file) return { status: 'failed' };

  const { PNG } = loadDependency('pngjs');
  const pixelmatch = loadDependency('pixelmatch').default;
  const a = PNG.sync.read(readFileSync(path.join(outDir, before.file)));
  const b = PNG.sync.read(readFileSync(path.join(outDir, after.file)));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const threshold = shot.threshold ?? 0.1;
  const diffPixels = pixelmatch(pad(PNG, a, width, height).data, pad(PNG, b, width, height).data, diff.data, width, height, { threshold, includeAA: false, alpha: 0.2 });
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  if (!sizeChanged && diffPixels <= minDiffPixels) return { status: 'unchanged', diffPixels, diffRatio: 0 };
  const file = path.join('shots', `${slug(shot.id)}-diff.png`);
  writeFileSync(path.join(outDir, file), PNG.sync.write(diff));

  const aligned = a.width === b.width ? shiftAwareMask(PNG, a, b) : null;
  let mask = aligned?.mask;
  if (!mask) {
    mask = new PNG({ width, height });
    pixelmatch(pad(PNG, a, width, height).data, pad(PNG, b, width, height).data, mask.data, width, height, { threshold, includeAA: false, diffMask: true, diffColor: [255, 0, 0], aaColor: [0, 0, 0] });
  }
  if (process.env.UI_CHANGELOG_DEBUG) writeFileSync(path.join(outDir, 'shots', `${slug(shot.id)}-mask.png`), PNG.sync.write(mask));
  const regions = changedRegions(mask, b.width, b.height).map((region, index) => ({ n: index + 1, ...region, before: beforeBox(region, aligned?.bands, a) }));
  const circledFile = path.join('shots', `${slug(shot.id)}-circled.png`);
  writeFileSync(path.join(outDir, circledFile), PNG.sync.write(drawOutlines(PNG, b, regions)));
  return { status: 'changed', diffPixels, diffRatio: diffPixels / (width * height), sizeChanged, diff: { file }, circled: { file: circledFile }, regions };
}

// Marks after-pixels that are new or modified, treating content that only moved as unchanged.
// Rows are aligned like lines in a text diff. Inside a band that does not align, the band is split at
// empty vertical gutters and each column is aligned on its own, so multi-column layouts that shift
// by different amounts still match. Pixels left over are compared with their counterpart row, or with
// the row's dominant color when the row was inserted. Every band that was marked is recorded with its
// before and after rows, which is how a region finds its counterpart on the before image.
export function shiftAwareMask(PNG, a, b) {
  const mask = new PNG({ width: b.width, height: b.height });
  const bands = [];
  return alignBlock(a, b, mask, bands, { x0: 0, x1: b.width, a0: 0, a1: a.height, b0: 0, b1: b.height }, 0) ? { mask, bands } : null;
}

function alignBlock(a, b, mask, marked, { x0, x1, a0, a1, b0, b1 }, depth) {
  const ids = new Map();
  const rowIds = (image, from, to) =>
    Array.from({ length: to - from }, (_, i) => {
      const y = from + i;
      const hash = createHash('sha1').update(image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4)).digest('base64');
      if (!ids.has(hash)) ids.set(hash, ids.size);
      return ids.get(hash);
    });
  const pairs = myersMatches(rowIds(a, a0, a1), rowIds(b, b0, b1));
  if (!pairs) return false;
  const bounds = [[-1, -1], ...pairs, [a1 - a0, b1 - b0]];
  const bands = [];
  for (let p = 0; p < bounds.length - 1; p++) {
    const band = { x0, x1, aStart: a0 + bounds[p][0] + 1, aEnd: a0 + bounds[p + 1][0], bStart: b0 + bounds[p][1] + 1, bEnd: b0 + bounds[p + 1][1] };
    if (band.aEnd <= band.aStart && band.bEnd <= band.bStart) continue;
    const last = bands.at(-1);
    // Blank rows match by chance and fragment one change into many hunks; nearby hunks are one change.
    if (last && band.aStart - last.aEnd <= 24 && band.bStart - last.bEnd <= 24) Object.assign(last, { aEnd: band.aEnd, bEnd: band.bEnd });
    else bands.push(band);
  }
  for (const band of bands) {
    if (band.bEnd <= band.bStart) {
      if (!isPlain(a, band.aStart, band.aEnd, x0, x1)) {
        markRemoval(b, mask, band);
        marked.push(band);
      }
      continue;
    }
    const strips = depth < 3 ? splitAtGutters(a, b, band) : [];
    if (strips.length > 1) {
      for (const [s0, s1] of strips) {
        const sub = { x0: s0, x1: s1, a0: band.aStart, a1: band.aEnd, b0: band.bStart, b1: band.bEnd };
        if (!alignBlock(a, b, mask, marked, sub, depth + 1)) {
          markPixels(a, b, mask, { ...band, x0: s0, x1: s1 });
          marked.push({ ...band, x0: s0, x1: s1 });
        }
      }
    } else {
      markPixels(a, b, mask, band);
      marked.push(band);
    }
  }
  return true;
}

function markPixels(a, b, mask, { x0, x1, aStart, aEnd, bStart, bEnd }) {
  const background = contextBackground(b, { x0, x1, bStart, bEnd });
  for (let y = bStart; y < bEnd; y++) {
    const counterpart = aStart + (y - bStart) < aEnd ? aStart + (y - bStart) : -1;
    for (let x = x0; x < x1; x++) {
      const i = (y * b.width + x) * 4;
      const changed = counterpart === -1 ? colorDistance(b.data, i, background, 0) > 48 : colorDistance(b.data, i, a.data, (counterpart * a.width + x) * 4) > 48;
      if (changed) setMask(mask, x, y);
    }
  }
}

function markRemoval(b, mask, { x0, x1, bStart }) {
  const y = Math.min(Math.max(bStart, 0), b.height - 1);
  for (let dy = -2; dy <= 2; dy++) for (let x = x0; x < x1; x++) if (y + dy >= 0 && y + dy < b.height) setMask(mask, x, y + dy);
}

// The page color around a band: the row just above it, or just below when the band starts at the top.
function contextBackground(b, { x0, x1, bStart, bEnd }) {
  return dominantColor(b, bStart > 0 ? bStart - 1 : Math.min(bEnd, b.height - 1), x0, x1);
}

function splitAtGutters(a, b, { x0, x1, aStart, aEnd, bStart, bEnd }, minGutter = 12) {
  const background = contextBackground(b, { x0, x1, bStart, bEnd });
  const allowed = Math.max(2, Math.floor((aEnd - aStart + bEnd - bStart) * 0.03));
  const isGutter = (x) => {
    let foreground = 0;
    for (const [image, from, to] of [[a, aStart, aEnd], [b, bStart, bEnd]]) {
      for (let y = from; y < to; y++) if (colorDistance(image.data, (y * image.width + x) * 4, background, 0) > 24 && ++foreground > allowed) return false;
    }
    return true;
  };
  const strips = [];
  let stripStart = -1;
  let gap = 0;
  for (let x = x0; x <= x1; x++) {
    if (x < x1 && !isGutter(x)) {
      if (stripStart === -1) stripStart = x;
      else if (gap >= minGutter) {
        strips.push([stripStart, x - gap]);
        stripStart = x;
      }
      gap = 0;
    } else if (stripStart !== -1) {
      gap++;
      if (x === x1) strips.push([stripStart, x - gap + 1]);
    }
  }
  return strips.map(([s0, s1]) => [Math.max(x0, s0 - 2), Math.min(x1, s1 + 2)]);
}

// Rows that are one color, such as blank space or a border line, carry no content worth flagging when removed.
function isPlain(image, from, to, x0, x1) {
  const allowed = Math.floor((x1 - x0) * 0.03);
  for (let y = from; y < to; y++) {
    const background = dominantColor(image, y, x0, x1);
    let other = 0;
    for (let x = x0; x < x1; x++) if (colorDistance(image.data, (y * image.width + x) * 4, background, 0) > 24 && ++other > allowed) return false;
  }
  return true;
}

function setMask(mask, x, y) {
  const i = (y * mask.width + x) * 4;
  mask.data[i] = 255;
  mask.data[i + 3] = 255;
}

function colorDistance(data1, i1, data2, i2) {
  return Math.abs(data1[i1] - data2[i2]) + Math.abs(data1[i1 + 1] - data2[i2 + 1]) + Math.abs(data1[i1 + 2] - data2[i2 + 2]);
}

function dominantColor(image, y, x0 = 0, x1 = image.width) {
  const counts = new Map();
  let best = [0, 0, 0];
  let bestCount = 0;
  for (let x = x0; x < x1; x += 2) {
    const i = (y * image.width + x) * 4;
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) [best, bestCount] = [[image.data[i], image.data[i + 1], image.data[i + 2]], count];
  }
  return best;
}

// Myers diff over row ids; returns matched [aIndex, bIndex] pairs in order, or null when the rows differ too much.
export function myersMatches(a, b, maxEdits = 4000) {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace = [];
  for (let d = 0; d <= Math.min(n + m, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace, n, m) {
  const pairs = [];
  let [x, y] = [n, m];
  for (let d = trace.length - 1; d >= 0; d--) {
    const saved = trace[d];
    const at = (k) => saved[k + d + 1];
    const k = x - y;
    const prevK = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      [x, y] = [x - 1, y - 1];
      pairs.push([x, y]);
    }
    [x, y] = [prevX, prevY];
  }
  return pairs.reverse();
}

// Groups changed pixels into boxes in reading order: mark 8px cells, join cells closer than 3 cells, drop specks.
export function changedRegions(mask, width, height, cell = 8, gap = 3, minPixels = 4) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * mask.width + x) * 4;
      if (mask.data[i + 3] && mask.data[i] === 255 && mask.data[i + 1] === 0) counts[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    const box = { c0: cols, r0: rows, c1: 0, r1: 0, pixels: 0 };
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const index = queue.pop();
      const c = index % cols;
      const r = Math.floor(index / cols);
      Object.assign(box, { c0: Math.min(box.c0, c), r0: Math.min(box.r0, r), c1: Math.max(box.c1, c), r1: Math.max(box.r1, r), pixels: box.pixels + counts[index] });
      for (let dr = -gap; dr <= gap; dr++) {
        for (let dc = -gap; dc <= gap; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          const next = nr * cols + nc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen[next] || !counts[next]) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    if (box.pixels >= minPixels) boxes.push(box);
  }
  const margin = 10;
  return boxes
    .map(({ c0, r0, c1, r1 }) => {
      const x = Math.max(0, c0 * cell - margin);
      const y = Math.max(0, r0 * cell - margin);
      return { x, y, width: Math.min(width, (c1 + 1) * cell + margin) - x, height: Math.min(height, (r1 + 1) * cell + margin) - y };
    })
    .sort((p, q) => p.y - q.y || p.x - q.x);
}

// The box on the before image that shows what the after region replaced. Rows above a band keep the
// offset of the band's start, rows below keep the offset of its end, and rows inside map into the band.
// Content that was only inserted has no before box.
export function beforeBox(region, bands, a) {
  const clampBox = (x, y0, y1) => {
    const top = Math.max(0, Math.min(a.height, y0));
    const bottom = Math.max(0, Math.min(a.height, y1));
    const left = Math.max(0, Math.min(a.width, x));
    const right = Math.max(left, Math.min(a.width, region.x + region.width));
    return bottom - top >= 4 && right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  };
  if (!bands) return clampBox(region.x, region.y, region.y + region.height);
  const ry0 = region.y;
  const ry1 = region.y + region.height;
  const hits = bands.filter((band) => band.x0 < region.x + region.width && band.x1 > region.x && band.bStart <= ry1 && Math.max(band.bEnd, band.bStart + 1) >= ry0);
  if (!hits.length) return clampBox(region.x, ry0, ry1);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const { aStart, aEnd, bStart, bEnd } of hits) {
    const inside = (y) => aStart + Math.min(Math.max(y - bStart, 0), aEnd - aStart);
    y0 = Math.min(y0, ry0 <= bStart ? ry0 + (aStart - bStart) : inside(ry0));
    y1 = Math.max(y1, ry1 >= bEnd ? ry1 + (aEnd - bEnd) : inside(ry1));
  }
  return clampBox(region.x, y0, y1);
}

const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];

function drawOutlines(PNG, image, regions) {
  const out = new PNG({ width: image.width, height: image.height });
  image.data.copy(out.data);
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = 255;
  };
  const radius = 8;
  const ring = (box, inset, color) => {
    const x0 = box.x + inset;
    const y0 = box.y + inset;
    const x1 = box.x + box.width - 1 - inset;
    const y1 = box.y + box.height - 1 - inset;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (x > x0 && x < x1 && y > y0 && y < y1) {
          y = y1 - 1;
          continue;
        }
        const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
        const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
        if ((cx !== x || cy !== y) && Math.hypot(x - cx, y - cy) > radius) continue;
        paint(x, y, color);
      }
    }
    for (let k = 0; k <= 90; k++) {
      const angle = (k / 90) * (Math.PI / 2);
      const dx = Math.round(Math.cos(angle) * radius);
      const dy = Math.round(Math.sin(angle) * radius);
      paint(x0 + radius - dx, y0 + radius - dy, color);
      paint(x1 - radius + dx, y0 + radius - dy, color);
      paint(x0 + radius - dx, y1 - radius + dy, color);
      paint(x1 - radius + dx, y1 - radius + dy, color);
    }
  };
  // A numbered tab on each box, above it when there is room, so the report can refer to "change 2".
  const badge = (box) => {
    const digits = String(box.n).split('').map(Number);
    const scale = 2;
    const width = digits.length * 3 * scale + (digits.length - 1) * scale + 8;
    const height = 5 * scale + 6;
    const left = Math.min(Math.max(0, box.x), out.width - width);
    const top = box.y >= height + 1 ? box.y - height + 1 : box.y + 4;
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) paint(x, y, [255, 45, 85]);
    digits.forEach((digit, index) => {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if (DIGITS[digit][row * 3 + col] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) paint(left + 4 + index * 4 * scale + col * scale + sx, top + 3 + row * scale + sy, [255, 255, 255]);
        }
      }
    });
  };
  for (const box of regions) {
    ring(box, -1, [255, 255, 255]);
    for (let inset = 0; inset < 3; inset++) ring(box, inset, [255, 45, 85]);
    ring(box, 3, [255, 255, 255]);
  }
  for (const box of regions) badge(box);
  return out;
}

function pad(PNG, image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = new PNG({ width, height, fill: true });
  PNG.bitblt(image, out, 0, 0, image.width, image.height, 0, 0);
  return out;
}
