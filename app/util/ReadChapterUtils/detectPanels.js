/**
 * Manga panel detection in pure JavaScript (no OpenCV needed).
 *
 * Strategy: recursive XY-cut. The page is down-scaled, every pixel is classified
 * as "ink" or "background" (relative to the page's own paper tone, white or
 * black), and the page is split recursively along separators that span the
 * region: white gutters, or thin full-width black lines (layouts that draw a
 * single border between panels instead of leaving a gap). Scan borders and
 * margin text are ignored. Leaves of the cut tree are the panels, and the tree
 * order *is* the reading order (rows top-to-bottom, columns right-to-left for
 * manga or left-to-right for manhwa / comics).
 *
 * Returns rects `{ x, y, w, h }` in the image's natural pixel space.
 */

const ANALYSIS_WIDTH = 800;

function fullPage(nw, nh) {
  return [{ x: 0, y: 0, w: nw, h: nh }];
}

/**
 * Browser entry point.
 * @param {HTMLImageElement} imgEl  A fully loaded, pixel-readable image element.
 */
export function detectPanels(imgEl, opts = {}) {
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
    console.warn("detectPanels: cannot read pixels, using full page", err);
    return fullPage(nw, nh);
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
  }
  return detectPanelsFromGray({ gray, w, h, nw, nh }, opts);
}

/**
 * Pure core (also usable from Node with any decoder).
 * @param {{gray: Uint8Array, w: number, h: number, nw: number, nh: number}} img  Down-scaled grayscale + natural size.
 * @param {object} opts
 * @param {"rtl"|"ltr"} opts.direction  Column reading direction.
 * @param {number} opts.maxAspect  Panels taller than `maxAspect * width` become scrolling "shots".
 */
export function detectPanelsFromGray({ gray, w, h, nw, nh }, { direction = "rtl", maxAspect = 2.2, bleedGutters = false, debug = null } = {}) {
  if (!w || !h || !nw || !nh) return [];
  const scale = w / nw;

  /* ---- paper tone: pick the dominant bright (or dark) level ---- */
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let brightMode = 255, brightMax = -1, darkMode = 0, darkMax = -1;
  for (let v = 0; v < 256; v++) {
    if (v >= 140 && hist[v] > brightMax) { brightMax = hist[v]; brightMode = v; }
    if (v <= 115 && hist[v] > darkMax) { darkMax = hist[v]; darkMode = v; }
  }
  const border = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  let sum = 0, count = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < border || y >= h - border;
    for (let x = 0; x < w; x++) {
      if (edgeRow || x < border || x >= w - border) { sum += gray[y * w + x]; count++; }
    }
  }
  const bgIsDark = count > 0 && sum / count < 90 && darkMax > 0;
  const ink = new Uint8Array(w * h);
  if (bgIsDark) {
    const t = Math.min(darkMode + 55, 120);
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] > t ? 1 : 0;
  } else {
    // JPEG ringing around black lines is ~200-230 gray; keep it out of "ink".
    const t = Math.max(150, Math.min(brightMode - 55, 200));
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < t ? 1 : 0;
  }

  const minGutter = Math.max(3, Math.round(w * 0.005));
  const minPanelW = Math.round(w * 0.06);
  const minPanelH = Math.round(h * 0.03);
  const leaves = [];

  /**
   * Per-line stats along `axis` inside `region`: `proj` = ink count per row/col,
   * `cov3` = breadth positions covered by ink in this line or its two neighbours
   * (catches thin, slightly slanted or broken drawn lines). At page level a small
   * margin is ignored on each side (page numbers, credits, scan noise).
   */
  function stats(region, axis, depth) {
    const { x0, y0, x1, y1 } = region;
    const marginFrac = depth === 0 ? 0.03 : 0;
    const rows = axis === "rows";
    const length = rows ? y1 - y0 : x1 - x0;
    const m = Math.round((rows ? x1 - x0 : y1 - y0) * marginFrac);
    const a = (rows ? x0 : y0) + m;
    const b = (rows ? x1 : y1) - m;
    const breadth = Math.max(1, b - a);
    const proj = new Int32Array(length);
    const cov3 = new Int32Array(length);
    const gap = new Int32Array(length); // longest uninterrupted background stretch
    const at = (i, p) => (rows ? ink[(y0 + i) * w + p] : ink[p * w + (x0 + i)]);
    for (let i = 0; i < length; i++) {
      let c = 0, cv = 0, run = 0, best = 0;
      const hasPrev = i > 0, hasNext = i + 1 < length;
      for (let p = a; p < b; p++) {
        const v = at(i, p);
        c += v;
        if (v) { run = 0; } else { run++; if (run > best) best = run; }
        if (v || (hasPrev && at(i - 1, p)) || (hasNext && at(i + 1, p))) cv++;
      }
      proj[i] = c;
      cov3[i] = cv;
      gap[i] = best;
    }
    return { proj, cov3, gap, breadth, length };
  }

  /**
   * Split a region along `axis`. Separators are runs of background (white gutters)
   * at least `minGutter` long or, when `allowLines`, thin drawn lines that span the
   * breadth and are bordered by light rows on both sides. Runs touching the region
   * edge are trimmed. Returns { parts, byLine } | { trimmed } | null.
   */
  function split(region, axis, depth, allowLines) {
    const minPart = axis === "rows" ? minPanelH : minPanelW;
    const { proj, cov3, gap, breadth, length } = stats(region, axis, depth);
    if (length < 2 * minPart) return null;
    // Page level tolerates lettering that crosses a gutter; deeper levels are strict.
    const bgThr = Math.max(1, Math.floor(breadth * (depth === 0 ? 0.012 : 0.005)));
    const pageDim = axis === "rows" ? h : w;
    const maxLine = Math.max(2, Math.round(pageDim * 0.012));
    const light = (i) => i < 0 || i >= length || proj[i] < breadth * 0.5;

    const cls = new Uint8Array(length); // 0 content, 1 background, 2 line candidate
    for (let i = 0; i < length; i++) {
      // At page level a gutter crossed by lettering or hair still shows as a long
      // uninterrupted white stretch with little ink overall.
      const bg = proj[i] <= bgThr || (bleedGutters && depth === 0 && gap[i] >= breadth * 0.6 && proj[i] <= breadth * 0.25);
      cls[i] = bg ? 1 : allowLines && cov3[i] >= breadth * 0.75 ? 2 : 0;
    }
    // A drawn line must be thin and bordered by light lines; otherwise it is dark art.
    if (allowLines) {
      let i = 0;
      while (i < length) {
        if (cls[i] !== 2) { i++; continue; }
        let j = i;
        while (j < length && cls[j] === 2) j++;
        let ok = j - i <= maxLine;
        if (ok) {
          // walk outward past background lines to the first content line on each side
          let up = i - 1; while (up >= 0 && cls[up] === 1) up--;
          let dn = j; while (dn < length && cls[dn] === 1) dn++;
          ok = light(up) && light(dn);
        }
        if (!ok) for (let k = i; k < j; k++) cls[k] = 0;
        i = j;
      }
    }

    const runs = [];
    let i = 0;
    while (i < length) {
      if (!cls[i]) { i++; continue; }
      let j = i, bg = 0, line = 0;
      while (j < length && cls[j]) { if (cls[j] === 1) bg++; else line++; j++; }
      runs.push({ a: i, b: j, bg, line });
      i = j;
    }
    if (!runs.length) return null;
    if (debug && depth <= 1) debug.push({ depth, axis, region: `${region.x0},${region.y0}-${region.x1},${region.y1}`, breadth, bgThr, runs: runs.map((r) => `${r.a}-${r.b}(bg${r.bg}/ln${r.line})`).join(" ") });

    // A gap narrower than `minGutter` still counts when solid border lines flank it
    // (tight layouts); gaps inside artwork have no such borders.
    const solidNear = (from, dir) => {
      for (let k = 1; k <= 3; k++) {
        const i = from + dir * k;
        if (i < 0 || i >= length) return false;
        if (proj[i] >= breadth * 0.6) return true;
      }
      return false;
    };
    const segments = [];
    let cursor = 0;
    let usedLine = false;
    for (const r of runs) {
      const isEdge = r.a === 0 || r.b === length;
      const gutter = r.bg >= minGutter || (r.bg >= 2 && r.line === 0 && solidNear(r.a, -1) && solidNear(r.b - 1, 1));
      const drawn = !gutter && r.line > 0;
      if (!isEdge && !gutter && !drawn) continue;
      if (!isEdge && drawn) usedLine = true;
      if (r.a > cursor) segments.push({ s: cursor, e: r.a });
      cursor = r.b;
    }
    if (cursor < length) segments.push({ s: cursor, e: length });

    // Merge undersized segments into a neighbour, then shrink every segment to its
    // content so swallowed separators do not pollute the next projection.
    const need = usedLine ? Math.max(minPart, Math.round(pageDim * 0.08)) : minPart;
    const merged = [];
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last && (seg.e - seg.s < need || last.e - last.s < need)) last.e = seg.e;
      else merged.push({ ...seg });
    }
    // Shrink every segment past separators and past its own border lines (near-solid
    // rows/cols), so they do not leak ink into the projection on the other axis.
    const solid = (i) => proj[i] >= breadth * 0.55;
    for (const seg of merged) {
      let guard = 0;
      while (seg.s < seg.e && (cls[seg.s] || (solid(seg.s) && guard++ < 12))) seg.s++;
      guard = 0;
      while (seg.e > seg.s && (cls[seg.e - 1] || (solid(seg.e - 1) && guard++ < 12))) seg.e--;
    }
    const kept = merged.filter((seg) => seg.e - seg.s >= minPart);
    if (kept.length < 2) {
      const one = kept[0] || merged[0];
      if (one && (one.s > 0 || one.e < length)) return { trimmed: toRegion(region, axis, one) };
      return null;
    }
    return { parts: kept.map((seg) => toRegion(region, axis, seg)), byLine: usedLine };
  }

  function toRegion(region, axis, { s, e }) {
    return axis === "rows"
      ? { x0: region.x0, y0: region.y0 + s, x1: region.x1, y1: region.y0 + e }
      : { x0: region.x0 + s, y0: region.y0, x1: region.x0 + e, y1: region.y1 };
  }

  function orderParts(parts, axis) {
    if (axis === "rows") return parts;
    return direction === "rtl" ? [...parts].reverse() : parts;
  }

  // `lineMode`: drawn lines count as separators at page level only (inside a tier they
  // would cut on black hair and other solid art).
  function recurse(region, axis, depth, lineMode) {
    if (depth > 8) { leaves.push(region); return; }
    const other = axis === "rows" ? "cols" : "rows";
    const first = split(region, axis, depth, lineMode);
    if (first?.parts) {
      for (const part of orderParts(first.parts, axis)) recurse(part, other, depth + 1, false);
      return;
    }
    const trimmedRegion = first?.trimmed || region;
    const second = split(trimmedRegion, other, depth, lineMode);
    if (second?.parts) {
      for (const part of orderParts(second.parts, other)) recurse(part, axis, depth + 1, false);
      return;
    }
    leaves.push(second?.trimmed || trimmedRegion);
  }

  /* ---- strip scan borders / blank margins / title bands around the page ---- */
  function trimFrame() {
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    const maxTrim = 0.14;
    const rowInk = (y, a, b) => { let c = 0; const base = y * w; for (let x = a; x < b; x++) c += ink[base + x]; return c / Math.max(1, b - a); };
    const colInk = (x, a, b) => { let c = 0; for (let y = a; y < b; y++) c += ink[y * w + x]; return c / Math.max(1, b - a); };
    // Only near-solid lines count as frame (scan borders, title bands); dark artwork
    // that bleeds to the page edge (0.7-0.95 ink) must stay part of its panel.
    const isFrame = (r) => r >= 0.96 || r <= 0.012;
    const scan = (limit, at) => {
      let i = 0, bursts = 0;
      const maxSolid = Math.max(3, Math.round(limit / maxTrim * 0.025));
      while (i < limit) {
        const r = at(i);
        if (r <= 0.012) { i++; continue; } // blank margin
        if (r >= 0.96) {
          // solid band: thin ones are scan borders; thick ones are only frame when a
          // blank margin follows (title band), otherwise it is black art bleeding to the edge
          let j = i;
          while (j < limit && at(j) >= 0.96) j++;
          if (j - i > maxSolid && (j >= limit || at(j) > 0.012)) break;
          i = j;
          continue;
        }
        let j = i;
        while (j < limit && !isFrame(at(j))) j++;
        // a short burst of "content" inside a solid band (white title on black) is still frame
        if (j - i > Math.max(4, limit * 0.25) || j >= limit || at(j) < 0.96 || bursts++ > 3) break;
        i = j;
      }
      return i;
    };
    y0 = scan(Math.floor(h * maxTrim), (i) => rowInk(i, x0, x1));
    y1 = h - scan(Math.floor(h * maxTrim), (i) => rowInk(h - 1 - i, x0, x1));
    x0 = scan(Math.floor(w * maxTrim), (i) => colInk(i, y0, y1));
    x1 = w - scan(Math.floor(w * maxTrim), (i) => colInk(w - 1 - i, y0, y1));
    if (x1 - x0 < w * 0.5 || y1 - y0 < h * 0.5) return { x0: 0, y0: 0, x1: w, y1: h };
    return { x0, y0, x1, y1 };
  }

  recurse(trimFrame(), "rows", 0, true);

  /* ---- tight-crop leaves to their ink, drop tiny ones ---- */
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

  /* ---- pad, convert to natural coordinates, split very tall wide panels into shots ---- */
  const pad = Math.round(w * 0.012);
  const out = [];
  for (const r of rects) {
    const x = Math.max(0, r.x - pad);
    const y = Math.max(0, r.y - pad);
    const rw = Math.min(w, r.x + r.w + pad) - x;
    const rh = Math.min(h, r.y + r.h + pad) - y;
    const natural = { x: x / scale, y: y / scale, w: rw / scale, h: rh / scale };
    if (natural.h > natural.w * maxAspect && rw >= w * 0.25) {
      const shotH = natural.w * 1.5;
      const n = Math.ceil(natural.h / shotH);
      const step = (natural.h - shotH) / Math.max(1, n - 1);
      for (let k = 0; k < n; k++) out.push({ x: natural.x, y: natural.y + k * step, w: natural.w, h: shotH, shot: true });
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
  return { w: Math.max(Math.ceil(w / 32) * 32, 32), h: Math.max(Math.ceil(h / 32) * 32, 32) };
}

/**
 * Assign OCR paragraphs (natural coords, `{x,y,w,h,text}`) to panels and order
 * them in reading order inside each panel. Returns one ordered array per panel.
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
        if (d < best) { best = d; idx = i; }
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
