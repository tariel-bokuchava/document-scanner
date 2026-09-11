// Perspective warp and scan post-processing.
(function (global) {
  'use strict';

  // Solve the 8x8 linear system for the homography mapping dst -> src.
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dst[i], [u, v] = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      const d = A[c][c] || 1e-12;
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / d;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hm = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * hm[k];
      hm[r] = s / (A[r][r] || 1e-12);
    }
    return hm;
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Estimate the real-world height/width ratio of the rectangle seen as `corners`
  // (Zhang & He, "Whiteboard scanning and image enhancement"). Falls back to the
  // measured ratio when the geometry is degenerate (near-parallel edges).
  function estimateAspect(corners, imgW, imgH) {
    const [tl, tr, br, bl] = corners;
    const cx = imgW / 2, cy = imgH / 2;
    const m1 = [tl[0] - cx, tl[1] - cy, 1], m2 = [tr[0] - cx, tr[1] - cy, 1];
    const m3 = [bl[0] - cx, bl[1] - cy, 1], m4 = [br[0] - cx, br[1] - cy, 1];
    const c3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const d3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const k2 = d3(c3(m1, m4), m3) / d3(c3(m2, m4), m3);
    const k3 = d3(c3(m1, m4), m2) / d3(c3(m3, m4), m2);
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    const measured = Math.max(dist(tl, bl), dist(tr, br)) / Math.max(dist(tl, tr), dist(bl, br));
    let f2;
    if (Math.abs(n2[2]) > 1e-6 && Math.abs(n3[2]) > 1e-6) {
      f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    }
    if (!(f2 > 0)) f2 = Math.pow(0.8 * Math.max(imgW, imgH), 2); // typical webcam field of view
    const ratio = Math.sqrt((n3[0] * n3[0] + n3[1] * n3[1] + n3[2] * n3[2] * f2) /
                            (n2[0] * n2[0] + n2[1] * n2[1] + n2[2] * n2[2] * f2));
    if (!isFinite(ratio) || ratio <= 0) return measured;
    // Sanity: do not trust a wildly different estimate.
    if (ratio / measured > 1.6 || measured / ratio > 1.6) return measured;
    return ratio;
  }

  function snapAspect(r) {
    const known = [1.4142, 1 / 1.4142, 1.2941, 1 / 1.2941]; // A-series portrait/landscape, US Letter
    for (const k of known) if (Math.abs(r / k - 1) < 0.08) return k;
    return r;
  }

  // corners: [TL, TR, BR, BL] in source pixel coords. Returns ImageData.
  // fixedAspect: height/width of the real page (portrait), or null to estimate.
  function warp(srcImg, corners, fixedAspect = null, maxSide = 3000) {
    const [tl, tr, br, bl] = corners;
    const measW = Math.max(dist(tl, tr), dist(bl, br));
    const measH = Math.max(dist(tl, bl), dist(tr, br));
    let aspect;
    if (fixedAspect) {
      // Known page ratio; orientation (portrait/landscape) follows the measured shape.
      aspect = measH >= measW ? fixedAspect : 1 / fixedAspect;
    } else {
      aspect = snapAspect(estimateAspect(corners, srcImg.width, srcImg.height));
    }
    // Keep the larger measured dimension as resolution, derive the other from aspect.
    let outW, outH;
    if (measH / measW > aspect) { outH = measH; outW = measH / aspect; } else { outW = measW; outH = measW * aspect; }
    const scale = Math.min(1, maxSide / Math.max(outW, outH));
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));

    const [h0, h1, h2, h3, h4, h5, h6, h7] =
      homography(corners, [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]]);
    const sw = srcImg.width, sh = srcImg.height, sd = srcImg.data;
    const out = new ImageData(outW, outH);
    const od = out.data;

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const den = h6 * x + h7 * y + 1;
        const sx = (h0 * x + h1 * y + h2) / den;
        const sy = (h3 * x + h4 * y + h5) / den;
        const o = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
          od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue;
        }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o]     = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
      }
    }
    return out;
  }

  // ---- Enhancement --------------------------------------------------------

  function luminance(img) {
    const d = img.data, n = img.width * img.height, L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return L;
  }

  // Separable box blur on a Float32 plane, radius r, edge-clamped.
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / k;
        s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / k;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  // Estimate the paper's background illumination: downscale, take local maxima
  // (paper is the brightest local surface), blur heavily, upscale bilinear.
  function backgroundField(L, w, h) {
    const f = 8, sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      const x0 = Math.floor(x * w / sw), x1 = Math.min(w, Math.floor((x + 1) * w / sw)) || x0 + 1;
      const y0 = Math.floor(y * h / sh), y1 = Math.min(h, Math.floor((y + 1) * h / sh)) || y0 + 1;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) m = Math.max(m, L[yy * w + xx]);
      small[y * sw + x] = m;
    }
    // Grey-closing-ish: local max over 3x3 then two large blurs to fill text regions.
    const mx = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy));
        m = Math.max(m, small[yy * sw + xx]);
      }
      mx[y * sw + x] = m;
    }
    const r = Math.max(2, Math.round(Math.min(sw, sh) / 12));
    const bl = boxBlur(boxBlur(mx, sw, sh, r), sw, sh, r);
    // Upscale
    const bg = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, (y + 0.5) * sh / h - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, (x + 0.5) * sw / w - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        bg[y * w + x] = (bl[y0 * sw + x0] * (1 - tx) + bl[y0 * sw + x1] * tx) * (1 - ty) +
                        (bl[y1 * sw + x0] * (1 - tx) + bl[y1 * sw + x1] * tx) * ty;
      }
    }
    return bg;
  }

  // mode: 'color' | 'gray' | 'bw'
  function enhance(img, mode = 'color') {
    const w = img.width, h = img.height, d = img.data, n = w * h;
    const L = luminance(img);
    const bg = backgroundField(L, w, h);

    // Flat-field: normalise every pixel by local paper brightness, so shadows
    // and hot spots flatten out and paper becomes uniformly white.
    const target = 245;
    const gain = new Float32Array(n);
    for (let i = 0; i < n; i++) gain[i] = target / Math.max(40, bg[i]);

    // Unsharp mask on luminance for crisper text.
    const blurred = boxBlur(L, w, h, 2);
    const amount = 1.0;

    if (mode === 'color') {
      // Automatic white balance: the paper is white, so normalise each channel
      // by its own local paper brightness. This removes colour casts from the
      // camera's white balance and room lighting along with the shading.
      const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) { R[i] = d[j]; G[i] = d[j + 1]; B[i] = d[j + 2]; }
      const bgR = backgroundField(R, w, h), bgG = backgroundField(G, w, h), bgB = backgroundField(B, w, h);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const sharp = 1 + amount * (L[i] - blurred[i]) / Math.max(1, L[i]);
        d[j]     = Math.min(255, d[j]     * (target / Math.max(40, bgR[i])) * sharp);
        d[j + 1] = Math.min(255, d[j + 1] * (target / Math.max(40, bgG[i])) * sharp);
        d[j + 2] = Math.min(255, d[j + 2] * (target / Math.max(40, bgB[i])) * sharp);
      }
      return contrastStretch(img);
    }

    const G = new Float32Array(n);
    for (let i = 0; i < n; i++) G[i] = Math.min(255, (L[i] + amount * (L[i] - blurred[i])) * gain[i]);

    if (mode === 'gray') {
      for (let i = 0, j = 0; i < n; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = G[i];
      return contrastStretch(img);
    }

    // Black & white: soft threshold relative to the (already flattened) paper.
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = G[i] < 150 ? 0 : G[i] > 205 ? 255 : ((G[i] - 150) / 55) * 255;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
    return img;
  }

  // Percentile stretch: dark 0.5% -> black, top 2% -> white.
  function contrastStretch(img) {
    const d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8]++;
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.005) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    if (hi - lo < 40) return img;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = ((i - lo) * 255) / (hi - lo);
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    return img;
  }

  global.Warp = { warp, enhance, estimateAspect };
})(window);
