// Minimal PDF writer: one JPEG image per page, no external dependencies.
(function (global) {
  'use strict';
  const enc = new TextEncoder();

  function concat(...arrs) {
    const len = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  // pages: [{ jpeg: Uint8Array, width, height }] -> Blob
  function buildPdf(pages) {
    const objects = [];
    const add = (body) => { objects.push(body instanceof Uint8Array ? body : enc.encode(body)); return objects.length; };

    const catalogId = add('');
    const pagesId = add('');
    const pageIds = [];

    for (const p of pages) {
      // Fit to A4 width (595pt), keep the image aspect ratio.
      const pw = 595, ph = Math.round(pw * p.height / p.width);
      const imgId = add(concat(
        enc.encode('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n'),
        p.jpeg,
        enc.encode('\nendstream')));
      const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
      const contentId = add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      const pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pw + ' ' + ph + ']' +
        ' /Resources << /XObject << /Im0 ' + imgId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
      pageIds.push(pageId);
    }

    objects[catalogId - 1] = enc.encode('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
    objects[pagesId - 1] = enc.encode('<< /Type /Pages /Count ' + pageIds.length +
      ' /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') + '] >>');

    const header = enc.encode('%PDF-1.4\n%âãÏÓ\n');
    const parts = [header];
    const offsets = [];
    let pos = header.length;
    objects.forEach((body, i) => {
      offsets.push(pos);
      const head = enc.encode((i + 1) + ' 0 obj\n'), tail = enc.encode('\nendobj\n');
      parts.push(head, body, tail);
      pos += head.length + body.length + tail.length;
    });
    let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    xref += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + pos + '\n%%EOF\n';
    parts.push(enc.encode(xref));
    return new Blob(parts, { type: 'application/pdf' });
  }

  global.MiniPdf = { buildPdf };
})(window);
