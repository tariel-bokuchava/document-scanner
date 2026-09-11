// Pure-JS document detector. Works on a downscaled frame.
// Strategy: the paper is assumed to be the largest bright region in view
// (typical for white paper on a desk). Otsu threshold -> largest connected
// bright component -> convex hull -> greedy reduction to a quadrilateral.
// Returns 4 ordered corners [TL, TR, BR, BL] in the coordinates of the input
// image, or null when nothing plausible is found.
(function (global) {
  'use strict';

  function toGray(img) {
    const { width: w, height: h, data } = img;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
    }
    return g;
  }

  function boxBlur3(src, w, h) {
    const tmp = new Uint16Array(w * h);
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        tmp[r + x] = src[r + Math.max(0, x - 1)] + src[r + x] + src[r + Math.min(w - 1, x + 1)];
      }
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w, mid = y * w, dn = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) out[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 9;
    }
    return out;
  }

  function otsu(g) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Largest 4-connected component of mask; returns its boundary pixels and area.
  function largestComponent(mask, w, h) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestArea = 0, bestLabel = 0, label = 0;
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || labels[s]) continue;
      label++;
      let sp = 0, area = 0;
      stack[sp++] = s; labels[s] = label;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = label; }
    }
    if (!bestLabel) return null;
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (labels[p] !== bestLabel) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            labels[p - 1] !== bestLabel || labels[p + 1] !== bestLabel ||
            labels[p - w] !== bestLabel || labels[p + w] !== bestLabel) {
          pts.push([x, y]);
        }
      }
    }
    return { area: bestArea, boundary: pts };
  }

  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

  function convexHull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function polyArea(poly) {
    let a = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  // Reduce hull to the 4 vertices forming the maximum-area quadrilateral.
  // The hull is first thinned greedily to a small candidate set (this rarely
  // removes true corners), then all 4-subsets are evaluated exactly.
  function reduceToQuad(hull) {
    const cand = thinHull(hull, 20);
    const n = cand.length;
    if (n === 4) return cand;
    let best = null, bestArea = -1;
    for (let a = 0; a < n - 3; a++)
      for (let b = a + 1; b < n - 2; b++)
        for (let c = b + 1; c < n - 1; c++)
          for (let d = c + 1; d < n; d++) {
            const q = [cand[a], cand[b], cand[c], cand[d]];
            const area = polyArea(q);
            if (area > bestArea) { bestArea = area; best = q; }
          }
    return best;
  }

  // Greedily drop the vertex whose removal loses the least area until `target` remain.
  function thinHull(hull, target) {
    const poly = hull.slice();
    while (poly.length > target) {
      let bestIdx = -1, bestLoss = Infinity;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const loss = Math.abs(cross(poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n])) / 2;
        if (loss < bestLoss) { bestLoss = loss; bestIdx = i; }
      }
      poly.splice(bestIdx, 1);
    }
    return poly;
  }

  function orderCorners(q) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
    const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const sorted = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // sorted is clockwise in screen coordinates; rotate so the first is top-left
    let start = 0, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = sorted[i][0] + sorted[i][1];
      if (s < best) { best = s; start = i; }
    }
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  }

  function minAngleDeg(q) {
    let min = 180;
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const ax = p[0] - c[0], ay = p[1] - c[1], bx = n[0] - c[0], by = n[1] - c[1];
      const cosA = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      min = Math.min(min, Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI);
    }
    return min;
  }

  function detect(img, opts = {}) {
    const w = img.width, h = img.height;
    const minAreaFrac = opts.minAreaFrac ?? 0.05;
    const g = boxBlur3(boxBlur3(toGray(img), w, h), w, h);
    const thr = otsu(g);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = g[i] > thr ? 1 : 0;

    const comp = largestComponent(mask, w, h);
    if (!comp || comp.area < minAreaFrac * w * h) return null;
    if (comp.boundary.length < 4) return null;

    const hull = convexHull(comp.boundary);
    if (hull.length < 4) return null;
    const hullArea = polyArea(hull);
    if (comp.area / hullArea < 0.7) return null;           // not a solid convex blob

    const quad = orderCorners(reduceToQuad(hull));
    const quadArea = polyArea(quad);
    if (quadArea / hullArea < 0.85) return null;            // hull is not quad-like
    if (minAngleDeg(quad) < 40) return null;

    // Reject when the page fills the frame: edges are not visible, warp would be meaningless.
    const margin = 2;
    const onBorder = quad.filter(([x, y]) => x <= margin || y <= margin || x >= w - 1 - margin || y >= h - 1 - margin).length;
    if (onBorder >= 3) return null;

    return { corners: quad, area: quadArea, threshold: thr };
  }

  // ---- Full-resolution corner refinement ---------------------------------
  // For each edge of the coarse quad, sample along the edge and search along
  // the normal for the strongest luminance transition; fit a line robustly to
  // those points; intersect adjacent lines. Corners come out sub-pixel accurate.
  function refineCorners(img, corners) {
    const w = img.width, h = img.height;
    const g = boxBlur3(toGray(img), w, h);
    const diag = Math.hypot(w, h);
    const R = Math.max(6, Math.round(diag * 0.025));
    const N = 48;
    const lines = [];

    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
      const nx = -ey / len, ny = ex / len; // normal (points outward for a clockwise quad? sign is irrelevant)
      const pts = [];
      for (let k = 0; k < N; k++) {
        const t = 0.08 + 0.84 * (k / (N - 1)); // avoid the very corners
        const px = a[0] + ex * t, py = a[1] + ey * t;
        let best = 0, bestS = 0;
        for (let s = -R + 1; s < R; s++) {
          const x1 = Math.round(px + nx * (s - 1)), y1 = Math.round(py + ny * (s - 1));
          const x2 = Math.round(px + nx * (s + 1)), y2 = Math.round(py + ny * (s + 1));
          if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 || x1 >= w || x2 >= w || y1 >= h || y2 >= h) continue;
          const d = Math.abs(g[y1 * w + x1] - g[y2 * w + x2]);
          if (d > best) { best = d; bestS = s; }
        }
        if (best > 12) pts.push([px + nx * bestS, py + ny * bestS]);
      }
      if (pts.length < 8) return corners; // give up: keep coarse corners
      lines.push(fitLine(pts));
    }

    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4], lines[i]);
      if (!p || Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1]) > R * 2) return corners;
      out.push(p);
    }
    return out;
  }

  // Robust total-least-squares line fit: fit, drop outliers, refit. Returns {x0,y0,dx,dy}.
  function fitLine(pts) {
    let set = pts;
    let line = tls(set);
    for (let iter = 0; iter < 3; iter++) {
      const resid = set.map(p => Math.abs((p[0] - line.x0) * -line.dy + (p[1] - line.y0) * line.dx));
      const sorted = resid.slice().sort((a, b) => a - b);
      const thr = Math.max(1.5, sorted[Math.floor(sorted.length / 2)] * 2.5);
      const keep = set.filter((_, i) => resid[i] <= thr);
      if (keep.length < 5 || keep.length === set.length) break;
      set = keep; line = tls(set);
    }
    return line;
  }

  function tls(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x0: mx, y0: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  }

  function intersect(l1, l2) {
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((l2.x0 - l1.x0) * l2.dy - (l2.y0 - l1.y0) * l2.dx) / den;
    return [l1.x0 + l1.dx * t, l1.y0 + l1.dy * t];
  }

  global.DocDetector = { detect, refineCorners };
})(window);
