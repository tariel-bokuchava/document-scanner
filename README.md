# Document Scanner (Chrome extension)

Scan paper documents with a laptop webcam or any attached USB camera.
Pages are detected automatically, perspective-corrected, and collected into a
multi-page PDF. A beep confirms each scan so you can keep feeding pages.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon. The scanner opens in a new tab; allow camera access.

## Usage

- Place a page on a background darker than the paper, within the camera view.
  Keep all four edges visible.
- Hold still. A yellow outline appears; a ring fills up; the page is captured
  with a beep and a flash.
- Remove the page and place the next one. Scanning re-arms automatically.
- **Space** / *Capture now* forces a capture of the current outline.
- **Delete** removes the last page. The ✕ button removes any page.
- *Download PDF* exports all pages, *Download JPEGs* exports individual files.

*Output* chooses Color, Grayscale (default, best for text) or Black & white.
Toggle *Auto-capture* off to capture manually only. *Mirror preview* flips the
view for front-facing cameras (output is never mirrored).

## How it works

- `detector.js` — pure JavaScript, no OpenCV: Otsu threshold on a 400px frame,
  largest bright connected component, convex hull, maximum-area quadrilateral,
  then sub-pixel corner refinement on the full-resolution still (edge sampling
  + robust line fits).
- `warp.js` — true page aspect ratio estimated from the perspective geometry
  (snapped to A4/Letter when close), homography + bilinear warp, flat-field
  illumination correction (removes shadows and hot spots), unsharp mask,
  Color / Grayscale / B&W output.
- Capture uses `ImageCapture.takePhoto()` for a full-sensor still when the
  camera supports it, and asks the camera for its maximum resolution and
  continuous autofocus/exposure.
- `pdf.js` — minimal PDF writer embedding JPEG pages.
- `scanner.js` — camera selection, stability tracking, beep (Web Audio), gallery.

## Tuning

Constants at the top of `scanner.js`: `STABLE_FRAMES` (hold time),
`STABLE_TOLERANCE`, `CLEAR_FRAMES`, `JPEG_QUALITY`. `minAreaFrac` in
`detector.js` sets the minimum page size (fraction of the frame).
