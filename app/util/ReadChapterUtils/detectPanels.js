/**
 * Manga panel detection in pure JavaScript (no OpenCV needed).
 *
 * Strategy: recursive XY-cut. The page is down-scaled onto a canvas, every pixel
 * is classified as "ink" or "background" (white gutters, or black gutters for
 * dark-bordered pages), and the page is split recursively along full-width /
 * full-height background gutters. Leaves of the cut tree are the panels, and the
 * traversal order of the tree *is* the reading order (rows top-to-bottom,
 * columns right-to-left for manga or left-to-right for manhwa / comics).
 *
 * Returns an array of rects `{ x, y, w, h }` in the image's natural pixel space.
 */

const ANALYSIS_WIDTH = 640;

function fullPage(nw, nh) {
  return [{ x: 0, y: 0, w: nw, h: nh }];
}

/**
 * @param {HTMLImageElement} imgEl  A fully loaded, same-origin image element.
 * @param {object} opts
 * @param {"rtl"|"ltr"} opts.direction  Column reading direction.
 * @param {number} opts.maxAspect  Panels taller than `maxAspect * width` are split into scrolling "shots".
 */
export function detectPanels(imgEl, { direction = "rtl", maxAspect = 2.2 } = {}) {
  const nw = imgEl?.naturalWidth || 0;
  const nh = imgEl?.naturalHeight || 0;
  if (!nw || !nh) return [];

  const scale = Math.min(1, ANALYSIS_WIDTH / nw);
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  let data;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (err) {
    // Tainted canvas (cross-origin image) or similar: fall back to the whole page.
    console.warn("detectPanels: cannot read pixels, using full page", err);
    return fullPage(nw, nh);
  }

  // Grayscale
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
  }

  // Estimate the page background from the outer border (white or black gutters).
  const border = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < border || y >= h - border;
    for (let x = 0; x < w; x++) {
      if (edgeRow || x < border || x >= w - border) {
        sum += gray[y * w + x];
        count++;
      }
    }
  }
  const bgIsDark = count > 0 && sum / count < 90;

  // Ink mask
  const ink = new Uint8Array(w * h);
  if (bgIsDark) {
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] > 70 ? 1 : 0;
  } else {
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < 200 ? 1 : 0;
  }

  const minGutter = Math.max(3, Math.round(w * 0.008));
  const minPanelW = Math.round(w * 0.06);
  const minPanelH = Math.round(h * 0.03);
  const leaves = [];

  function projection(region, axis) {
    const { x0, y0, x1, y1 } = region;
    if (axis === "rows") {
      const proj = new Int32Array(y1 - y0);
      for (let y = y0; y < y1; y++) {
        let c = 0;
        const base = y * w;
        for (let x = x0; x < x1; x++) c += ink[base + x];
        proj[y - y0] = c;
      }
      return proj;
    }
    const proj = new Int32Array(x1 - x0);
    for (let x = x0; x < x1; x++) {
      let c = 0;
      for (let y = y0; y < y1; y++) c += ink[y * w + x];
      proj[x - x0] = c;
    }
    return proj;
  }

  // Split a region along `axis` at background gutters. Returns null when no valid cut exists.
  function split(region, axis) {
    const { x0, y0, x1, y1 } = region;
    const length = axis === "rows" ? y1 - y0 : x1 - x0;
    const breadth = axis === "rows" ? x1 - x0 : y1 - y0;
    if (length < 2 * (axis === "rows" ? minPanelH : minPanelW)) return null;

    const proj = projection(region, axis);
    const thr = Math.max(1, Math.floor(breadth * 0.006));
    const bg = new Uint8Array(length);
    for (let i = 0; i < length; i++) bg[i] = proj[i] <= thr ? 1 : 0;

    // Collect maximal runs of background.
    const runs = [];
    let i = 0;
    while (i < length) {
      if (!bg[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < length && bg[j]) j++;
      runs.push([i, j]);
      i = j;
    }
    if (!runs.length) return null;

    // Segments of content between background runs (treat edge runs as trimming).
    const segments = [];
    let cursor = 0;
    for (const [a, b] of runs) {
      const isEdge = a === 0 || b === length;
      const isGutter = b - a >= minGutter;
      if (!isEdge && !isGutter) continue;
      if (a > cursor) segments.push([cursor, a]);
      cursor = b;
    }
    if (cursor < length) segments.push([cursor, length]);

    const minPart = axis === "rows" ? minPanelH : minPanelW;
    // Merge undersized segments into their neighbour so text specks in gutters don't create slivers.
    const merged = [];
    for (const seg of segments) {
      if (merged.length && (seg[1] - seg[0] < minPart)) {
        merged[merged.length - 1][1] = seg[1];
      } else if (merged.length && merged[merged.length - 1][1] - merged[merged.length - 1][0] < minPart) {
        merged[merged.length - 1][1] = seg[1];
      } else {
        merged.push([seg[0], seg[1]]);
      }
    }
    if (merged.length < 2) {
      // No cut, but we may still have trimmed empty margins.
      if (merged.length === 1 && (merged[0][0] > 0 || merged[0][1] < length)) {
        return { trimmed: toRegion(region, axis, merged[0]) };
      }
      return null;
    }
    return { parts: merged.map((seg) => toRegion(region, axis, seg)) };
  }

  function toRegion(region, axis, [a, b]) {
    return axis === "rows"
      ? { x0: region.x0, y0: region.y0 + a, x1: region.x1, y1: region.y0 + b }
      : { x0: region.x0 + a, y0: region.y0, x1: region.x0 + b, y1: region.y1 };
  }

  function orderParts(parts, axis) {
    if (axis === "rows") return parts; // top to bottom
    return direction === "rtl" ? [...parts].reverse() : parts;
  }

  function recurse(region, axis, depth) {
    if (depth > 8) {
      leaves.push(region);
      return;
    }
    const first = split(region, axis);
    if (first?.parts) {
      const other = axis === "rows" ? "cols" : "rows";
      for (const part of orderParts(first.parts, axis)) recurse(part, other, depth + 1);
      return;
    }
    const trimmedRegion = first?.trimmed || region;
    const other = axis === "rows" ? "cols" : "rows";
    const second = split(trimmedRegion, other);
    if (second?.parts) {
      for (const part of orderParts(second.parts, other)) recurse(part, axis, depth + 1);
      return;
    }
    leaves.push(second?.trimmed || trimmedRegion);
  }

  recurse({ x0: 0, y0: 0, x1: w, y1: h }, "rows", 0);

  // Tight-crop each leaf to its ink, drop empty / tiny leaves.
  const pageArea = w * h;
  const rects = [];
  for (const leaf of leaves) {
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = leaf.y0; y < leaf.y1; y++) {
      const base = y * w;
      for (let x = leaf.x0; x < leaf.x1; x++) {
        if (ink[base + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) continue;
    const rw = maxX - minX + 1;
    const rh = maxY - minY + 1;
    if (rw * rh < pageArea * 0.012 || rw < minPanelW || rh < minPanelH) continue;
    rects.push({ x: minX, y: minY, w: rw, h: rh });
  }

  if (!rects.length) return fullPage(nw, nh);

  // Pad, convert to natural coordinates, and split very tall panels into scrolling shots.
  const pad = Math.round(w * 0.012);
  const out = [];
  for (const r of rects) {
    const x = Math.max(0, r.x - pad);
    const y = Math.max(0, r.y - pad);
    const rw = Math.min(w, r.x + r.w + pad) - x;
    const rh = Math.min(h, r.y + r.h + pad) - y;
    const natural = { x: x / scale, y: y / scale, w: rw / scale, h: rh / scale };
    if (natural.h > natural.w * maxAspect) {
      const shotH = natural.w * 1.5;
      const n = Math.ceil(natural.h / shotH);
      const step = (natural.h - shotH) / Math.max(1, n - 1);
      for (let k = 0; k < n; k++) {
        out.push({ x: natural.x, y: natural.y + k * step, w: natural.w, h: shotH, shot: true });
      }
    } else {
      out.push(natural);
    }
  }
  return out;
}

/**
 * Size of the coordinate space the OCR API reports boxes in. The server first
 * resizes to at most 1600px (reported back as `metadata.imageProcessing.dimensions`),
 * then the detector caps the longest side at 960px and rounds each side up to a
 * multiple of 32. Boxes are relative to that final tensor size.
 */
export function ocrBoxSpace(processedWidth, processedHeight) {
  let w = processedWidth;
  let h = processedHeight;
  if (Math.max(w, h) > 960) {
    const r = w > h ? 960 / w : 960 / h;
    w *= r;
    h *= r;
  }
  return {
    w: Math.max(Math.ceil(w / 32) * 32, 32),
    h: Math.max(Math.ceil(h / 32) * 32, 32),
  };
}

/**
 * Assign OCR paragraphs (natural coords, `{x,y,w,h,text}`) to panels and order
 * them in reading order inside each panel. Returns an array (one entry per panel)
 * of ordered paragraph arrays.
 */
export function assignTextToPanels(panels, paragraphs, direction = "rtl") {
  const buckets = panels.map(() => []);
  if (!panels.length) return buckets;
  for (const p of paragraphs) {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    let idx = panels.findIndex((r) => {
      const mx = r.w * 0.04;
      const my = r.h * 0.04;
      return cx >= r.x - mx && cx <= r.x + r.w + mx && cy >= r.y - my && cy <= r.y + r.h + my;
    });
    if (idx === -1) {
      let best = Infinity;
      panels.forEach((r, i) => {
        const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
        const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          idx = i;
        }
      });
    }
    if (idx >= 0) buckets[idx].push(p);
  }
  return buckets.map((list) => {
    const sorted = [...list].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    const rows = [];
    for (const p of sorted) {
      const cy = p.y + p.h / 2;
      const row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(p.h, 30) * 0.6);
      if (row) {
        row.items.push(p);
        row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length;
      } else {
        rows.push({ cy, items: [p] });
      }
    }
    const ordered = [];
    for (const row of rows) {
      row.items.sort((a, b) => (direction === "rtl" ? b.x + b.w / 2 - (a.x + a.w / 2) : a.x + a.w / 2 - (b.x + b.w / 2)));
      ordered.push(...row.items);
    }
    return ordered;
  });
}
