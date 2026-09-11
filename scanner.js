(function () {
  'use strict';

  // ---- Tunables -----------------------------------------------------------
  const DETECT_WIDTH = 400;        // downscaled width used for detection
  const DETECT_INTERVAL_MS = 80;   // ~12 fps detection
  const STABLE_FRAMES = 10;        // consecutive stable frames before capture (~0.8s)
  const STABLE_TOLERANCE = 0.015;  // corner movement allowed, fraction of frame diagonal
  const CLEAR_FRAMES = 6;          // frames with no page (or a moved page) before re-arming
  const MIN_CAPTURE_GAP_MS = 1500;

  // ---- DOM ----------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
  const statusEl = $('status'), flash = $('flash'), gallery = $('gallery');
  const cameraSelect = $('cameraSelect'), autoCapture = $('autoCapture'), mirror = $('mirror');
  const outputMode = $('outputMode'), pageSize = $('pageSize');
  const compression = $('compression'), customBox = $('customBox'), customKB = $('customKB'), customPx = $('customPx');
  const captureBtn = $('captureBtn'), downloadPdf = $('downloadPdf'), downloadJpgs = $('downloadJpgs'), clearAll = $('clearAll');
  const pageCount = $('pageCount');

  const detectCanvas = document.createElement('canvas');
  const dctx = detectCanvas.getContext('2d', { willReadFrequently: true });
  const fullCanvas = document.createElement('canvas');
  const fctx = fullCanvas.getContext('2d', { willReadFrequently: true });

  // ---- State --------------------------------------------------------------
  let stream = null;
  let pages = [];          // { blob, url, width, height }
  let phase = 'searching'; // searching | tracking | armedOff (waiting for page removal)
  let stableCount = 0, clearCount = 0;
  let lastCorners = null, capturedCorners = null, lastCaptureAt = 0;
  let busy = false;
  let imageCapture = null;
  let lastCaptureInfo = ''; // ImageCapture for full-sensor stills when supported

  function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = 'status ' + cls; }

  // ---- Audio --------------------------------------------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep() {
    try {
      ensureAudio();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(1040, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.2);
    } catch (e) { console.warn('beep failed', e); }
  }
  document.addEventListener('click', ensureAudio, { once: true });
  document.addEventListener('keydown', ensureAudio, { once: true });

  // ---- Camera -------------------------------------------------------------
  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const current = cameraSelect.value;
    cameraSelect.innerHTML = '';
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId; o.textContent = c.label || ('Camera ' + (i + 1));
      cameraSelect.appendChild(o);
    });
    if (current && cams.some(c => c.deviceId === current)) cameraSelect.value = current;
  }

  async function startCamera(deviceId) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 4096 }, height: { ideal: 2160 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' })
      }
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e.name === 'NotAllowedError') { setStatus('Camera permission denied. Allow camera access for this extension and reload.', 'warn'); return; }
      // Fallback to whatever camera is available.
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch (e2) { setStatus('No camera available: ' + e2.message, 'warn'); return; }
    }
    const track0 = stream.getVideoTracks()[0];
    await maximiseTrack(track0);
    imageCapture = (window.ImageCapture && typeof ImageCapture === 'function') ? new ImageCapture(track0) : null;
    video.srcObject = stream;
    await video.play();
    await listCameras();
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    if (s.deviceId) cameraSelect.value = s.deviceId;
    resetPhase('searching');
    setStatus('Camera ' + (s.width || '?') + '×' + (s.height || '?') + (imageCapture ? ' (still capture available)' : '') + '. Looking for a page…');
  }

  // Ask the camera for its largest frame size and continuous focus/exposure.
  async function maximiseTrack(track) {
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const c = {};
      if (caps.width?.max && caps.height?.max) { c.width = caps.width.max; c.height = caps.height.max; }
      const adv = [];
      if (caps.focusMode?.includes('continuous')) adv.push({ focusMode: 'continuous' });
      if (caps.exposureMode?.includes('continuous')) adv.push({ exposureMode: 'continuous' });
      if (caps.whiteBalanceMode?.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
      if (adv.length) c.advanced = adv;
      if (Object.keys(c).length) await track.applyConstraints(c);
    } catch (e) { console.warn('applyConstraints failed', e); }
  }

  cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));
  navigator.mediaDevices.addEventListener('devicechange', listCameras);
  mirror.addEventListener('change', () => document.body.classList.toggle('mirrored', mirror.checked));

  // ---- Detection loop -----------------------------------------------------
  function pagePxWarn() { return lastCaptureInfo.includes('low'); }
  function resetPhase(p) { phase = p; stableCount = 0; clearCount = 0; lastCorners = null; }

  function cornerDistance(a, b, diag) {
    let max = 0;
    for (let i = 0; i < 4; i++) max = Math.max(max, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
    return max / diag;
  }

  function drawOverlay(corners, color, progress) {
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;
    octx.lineWidth = Math.max(2, overlay.width / 300);
    octx.strokeStyle = color; octx.fillStyle = color.replace('1)', '0.15)');
    octx.beginPath();
    corners.forEach(([x, y], i) => i ? octx.lineTo(x, y) : octx.moveTo(x, y));
    octx.closePath(); octx.fill(); octx.stroke();
    corners.forEach(([x, y]) => { octx.beginPath(); octx.arc(x, y, octx.lineWidth * 2.5, 0, Math.PI * 2); octx.fill(); });
    if (progress > 0) {
      const cx = corners.reduce((s, c) => s + c[0], 0) / 4, cy = corners.reduce((s, c) => s + c[1], 0) / 4;
      const r = overlay.width / 25;
      octx.beginPath(); octx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      octx.lineWidth = r / 3; octx.stroke();
    }
  }

  async function tick() {
    if (!stream || video.readyState < 2 || busy) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const scale = DETECT_WIDTH / vw;
    detectCanvas.width = DETECT_WIDTH; detectCanvas.height = Math.round(vh * scale);
    dctx.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);
    const small = dctx.getImageData(0, 0, detectCanvas.width, detectCanvas.height);

    const res = DocDetector.detect(small);
    const corners = res ? res.corners.map(([x, y]) => [x / scale, y / scale]) : null;
    const diag = Math.hypot(vw, vh);

    if (!autoCapture.checked) {
      drawOverlay(corners, corners ? 'rgba(80,180,255,1)' : null, 0);
      setStatus(corners ? 'Page detected. Press Capture or Space.' : 'Looking for a page…');
      lastCorners = corners;
      return;
    }

    if (phase === 'armedOff') {
      // Wait until the captured page is removed or clearly replaced.
      const gone = !corners || cornerDistance(corners, capturedCorners, diag) > 0.12;
      clearCount = gone ? clearCount + 1 : 0;
      drawOverlay(corners, 'rgba(120,120,120,1)', 0);
      setStatus('Scanned (' + lastCaptureInfo + ', ' + fmtKB(pages[pages.length - 1].blob.size) + '). Remove the page and place the next one.', pagePxWarn() ? 'warn' : 'ok');
      if (clearCount >= CLEAR_FRAMES) { resetPhase('searching'); }
      return;
    }

    if (!corners) {
      resetPhase('searching');
      drawOverlay(null); setStatus('Looking for a page…');
      return;
    }

    if (lastCorners && cornerDistance(corners, lastCorners, diag) < STABLE_TOLERANCE) stableCount++;
    else stableCount = 0;
    lastCorners = corners;
    phase = 'tracking';

    const progress = Math.min(1, stableCount / STABLE_FRAMES);
    drawOverlay(corners, progress >= 1 ? 'rgba(80,220,80,1)' : 'rgba(255,200,0,1)', progress);
    setStatus(stableCount ? 'Hold still…' : 'Page found. Hold still.');

    if (stableCount >= STABLE_FRAMES && Date.now() - lastCaptureAt > MIN_CAPTURE_GAP_MS) {
      await capture(corners);
    }
  }

  // ---- Capture ------------------------------------------------------------
  async function capture(corners) {
    if (busy || !corners) return;
    busy = true;
    try {
      setStatus('Capturing…');
      const full = await grabFullFrame();
      // Corners were found on the preview frame; scale to the still's resolution, then refine on real pixels.
      const sx = full.width / video.videoWidth, sy = full.height / video.videoHeight;
      let c = corners.map(([x, y]) => [x * sx, y * sy]);
      c = DocDetector.refineCorners(full, c);
      const fixed = pageSize.value === 'auto' ? null : parseFloat(pageSize.value);
      const warped = Warp.enhance(Warp.warp(full, c, fixed), outputMode.value);
      const pagePx = Math.round(Math.max(Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1])));
      lastCaptureInfo = 'Still ' + full.width + '×' + full.height + ', page spans ' + pagePx + ' px' + (pagePx < 1000 ? ' — low: move the page closer / fill the frame' : '');
      const out = document.createElement('canvas');
      out.width = warped.width; out.height = warped.height;
      out.getContext('2d').putImageData(warped, 0, 0);
      const enc = await encodeToTarget(out, compressionSettings());
      const bytes = new Uint8Array(await enc.blob.arrayBuffer()); // kept so sharing/PDF can run synchronously inside a tap
      addPage({ blob: enc.blob, bytes, url: URL.createObjectURL(enc.blob), width: enc.width, height: enc.height, quality: enc.quality });

      beep();
      flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
      lastCaptureAt = Date.now();
      capturedCorners = corners;
      resetPhase('armedOff');
    } finally { busy = false; }
  }

  // ---- Compression --------------------------------------------------------
  // Presets: target file size in KB and maximum long side in pixels.
  const COMPRESSION_PRESETS = {
    small:  { targetKB: 150, maxPx: 1500 },
    medium: { targetKB: 300, maxPx: 2200 },
    large:  { targetKB: 600, maxPx: 2800 },
    max:    { targetKB: 0,   maxPx: 3000 },   // 0 = no size limit
  };
  function compressionSettings() {
    if (compression.value === 'custom') {
      return { targetKB: Math.max(0, parseInt(customKB.value, 10) || 0), maxPx: Math.max(300, parseInt(customPx.value, 10) || 2200) };
    }
    return COMPRESSION_PRESETS[compression.value] || COMPRESSION_PRESETS.medium;
  }
  compression.addEventListener('change', () => { customBox.hidden = compression.value !== 'custom'; });

  const toJpeg = (canvas, q) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
  function scaleCanvas(src, f) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * f)); c.height = Math.max(1, Math.round(src.height * f));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  // Encode as JPEG under targetKB: first cap the pixel size, then lower quality in steps,
  // then shrink the image and repeat. Returns { blob, width, height, quality }.
  async function encodeToTarget(canvas, { targetKB, maxPx }) {
    let c = canvas;
    const long = Math.max(c.width, c.height);
    if (long > maxPx) c = scaleCanvas(c, maxPx / long);
    if (!targetKB) { const blob = await toJpeg(c, 0.93); return { blob, width: c.width, height: c.height, quality: 0.93 }; }
    const limit = targetKB * 1024;
    const qualities = [0.85, 0.78, 0.7, 0.62, 0.55, 0.48, 0.42];
    for (let round = 0; round < 6; round++) {
      let blob = null, q = 0;
      for (q of qualities) { blob = await toJpeg(c, q); if (blob.size <= limit) return { blob, width: c.width, height: c.height, quality: q }; }
      if (Math.max(c.width, c.height) <= 600) return { blob, width: c.width, height: c.height, quality: q };
      c = scaleCanvas(c, 0.85);
    }
    const blob = await toJpeg(c, 0.42);
    return { blob, width: c.width, height: c.height, quality: 0.42 };
  }

  // Prefer a full-sensor still (sharper, higher resolution than the video stream); fall back to the video frame.
  async function grabFullFrame() {
    if (imageCapture) {
      try {
        const blob = await imageCapture.takePhoto();
        const bmp = await createImageBitmap(blob);
        fullCanvas.width = bmp.width; fullCanvas.height = bmp.height;
        fctx.drawImage(bmp, 0, 0); bmp.close();
        return fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
      } catch (e) { console.warn('takePhoto failed, using video frame', e); }
    }
    fullCanvas.width = video.videoWidth; fullCanvas.height = video.videoHeight;
    fctx.drawImage(video, 0, 0);
    return fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
  }

  // ---- Gallery ------------------------------------------------------------
  function addPage(p) { pages.push(p); renderGallery(); }
  function removePage(i) { URL.revokeObjectURL(pages[i].url); pages.splice(i, 1); renderGallery(); }
  function renderGallery() {
    gallery.innerHTML = '';
    pages.forEach((p, i) => {
      const div = document.createElement('div'); div.className = 'page';
      const img = document.createElement('img'); img.src = p.url; img.alt = 'Page ' + (i + 1);
      const num = document.createElement('span'); num.className = 'num'; num.textContent = (i + 1) + ' · ' + fmtKB(p.blob.size);
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Remove page';
      del.addEventListener('click', () => removePage(i));
      div.append(img, num, del); gallery.appendChild(div);
    });
    gallery.scrollTop = gallery.scrollHeight;
    pageCount.textContent = pages.length;
    downloadPdf.disabled = downloadJpgs.disabled = clearAll.disabled = pages.length === 0;
    if (sharePdf) sharePdf.disabled = shareJpgs.disabled = pages.length === 0;
  }

  function fmtKB(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }
  function stamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function buildPdfBlob() {
    const blob = MiniPdf.buildPdf(pages.map(p => ({ jpeg: p.bytes, width: p.width, height: p.height })));
    setStatus('PDF ready: ' + pages.length + ' page(s), ' + fmtKB(blob.size));
    return blob;
  }
  downloadPdf.addEventListener('click', () => {
    try { download(buildPdfBlob(), 'scan-' + stamp() + '.pdf'); }
    catch (e) { setStatus('PDF failed: ' + e.message, 'warn'); }
  });

  // ---- Share (Web Share API: iOS/Android share sheet, no file saved first) --
  const canShareFiles = !!(navigator.share && navigator.canShare &&
    navigator.canShare({ files: [new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 't.jpg', { type: 'image/jpeg' })] }));
  function shareFiles(files, title) {
    // Must be called synchronously from the tap; no awaits before navigator.share.
    try {
      navigator.share({ files, title }).then(() => setStatus('Shared.', 'ok'))
        .catch(e => { if (e.name !== 'AbortError') setStatus('Share failed: ' + e.name + ' ' + e.message, 'warn'); });
    } catch (e) { setStatus('Share failed: ' + e.message, 'warn'); }
  }
  const sharePdf = $('sharePdf'), shareJpgs = $('shareJpgs');
  if (sharePdf) sharePdf.addEventListener('click', () => {
    try { shareFiles([new File([buildPdfBlob()], 'scan-' + stamp() + '.pdf', { type: 'application/pdf' })], 'Scanned document'); }
    catch (e) { setStatus('PDF failed: ' + e.message, 'warn'); }
  });
  if (shareJpgs) shareJpgs.addEventListener('click', () => {
    const s = stamp();
    shareFiles(pages.map((p, i) => new File([p.blob], 'scan-' + s + '-p' + String(i + 1).padStart(3, '0') + '.jpg', { type: 'image/jpeg' })), 'Scanned pages');
  });
  function sharePage(i) {
    const p = pages[i];
    shareFiles([new File([p.blob], 'scan-' + stamp() + '-p' + String(i + 1).padStart(3, '0') + '.jpg', { type: 'image/jpeg' })], 'Scanned page ' + (i + 1));
  }
  document.querySelectorAll('.share-only').forEach(el => { el.hidden = !canShareFiles; });
  downloadJpgs.addEventListener('click', () => {
    pages.forEach((p, i) => setTimeout(() => download(p.blob, 'scan-' + stamp() + '-p' + String(i + 1).padStart(3, '0') + '.jpg'), i * 150));
  });
  clearAll.addEventListener('click', () => {
    if (pages.length && confirm('Remove all ' + pages.length + ' scanned pages?')) { pages.forEach(p => URL.revokeObjectURL(p.url)); pages = []; renderGallery(); }
  });

  captureBtn.addEventListener('click', () => capture(lastCorners));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); capture(lastCorners); }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (pages.length) removePage(pages.length - 1); }
  });

  window.addEventListener('error', e => setStatus('Error: ' + e.message, 'warn'));
  window.addEventListener('unhandledrejection', e => setStatus('Error: ' + (e.reason && e.reason.message || e.reason), 'warn'));

  // ---- Boot ---------------------------------------------------------------
  (async function boot() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('getUserMedia is not available in this browser.', 'warn'); return; }
    await startCamera();
    setInterval(() => { tick().catch(err => { console.error(err); setStatus('Error: ' + err.message, 'warn'); }); }, DETECT_INTERVAL_MS);
  })();
})();
