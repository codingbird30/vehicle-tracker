"""
PaddleOCR plate detection service.
Runs as a small Flask server. Node.js POSTs an image and gets back
the detected plate text + bounding box coordinates.

Endpoints:
  GET  /health           - readiness probe
  POST /detect           - multipart 'image' field, returns JSON

Response shape:
  {
    "plate": "MH12AB1234" | null,
    "confidence": 0..100,
    "bbox": [x1, y1, x2, y2] | null,    # in original image coords
    "all_detections": [
      { "text": "...", "confidence": 0..100, "bbox": [x1,y1,x2,y2] },
      ...
    ],
    "image_width": 800,
    "image_height": 600
  }
"""
import io
import os
import re
import sys
import logging
import warnings

# Silence PaddleOCR's noisy startup output BEFORE any paddle imports
os.environ['GLOG_minloglevel'] = '3'                 # suppress GLOG INFO/WARNING
os.environ['FLAGS_call_stack_level'] = '0'
os.environ['PPOCR_LOG_LEVEL'] = 'ERROR'
os.environ['FLAGS_logtostderr'] = '0'
warnings.filterwarnings('ignore')

# Suppress Flask's "development server" warning (it's fine, this is a sidecar)
import logging as _stdlogging
_stdlogging.getLogger('werkzeug').setLevel(_stdlogging.ERROR)

from flask import Flask, request, jsonify
from PIL import Image, ImageEnhance, ImageFilter
import numpy as np

logging.basicConfig(level=logging.INFO, format='[python-ocr] %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

# Indian plate regex: 2 letters + 1-2 digits + 1-3 letters + 4 digits
PLATE_REGEX = re.compile(r'[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}')

# Common OCR character confusions on plates (used for slot-aware correction)
LETTER_TO_DIGIT = {'O': '0', 'D': '0', 'Q': '0', 'I': '1', 'L': '1',
                   'Z': '2', 'B': '8', 'S': '5', 'G': '6', 'T': '7'}
DIGIT_TO_LETTER = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S',
                   '6': 'G', '8': 'B', '7': 'T'}

# ---------- Lazy-load PaddleOCR (heavy import) ----------
_ocr = None

def get_ocr():
    global _ocr
    if _ocr is None:
        log.info("Loading PaddleOCR (first request only, ~10s)...")
        from paddleocr import PaddleOCR
        # PaddleOCR's constructor changed across versions. Try the new API first
        # (3.x — uses use_textline_orientation), then fall back to old (2.x).
        try:
            _ocr = PaddleOCR(use_textline_orientation=True, lang='en')
        except TypeError:
            try:
                _ocr = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
            except TypeError:
                _ocr = PaddleOCR(use_angle_cls=True, lang='en')
        log.info("PaddleOCR ready.")
    return _ocr


# ---------- Image preprocessing ----------
def preprocess_variants(pil_img):
    """
    Return multiple preprocessed variants. PaddleOCR is robust enough that
    we only need 2-3 versions; running too many slows things down.
    """
    variants = []

    # 1) Upscale + sharpen (best for blurry plates)
    w, h = pil_img.size
    target_w = max(1280, w)
    scale = target_w / w if w < target_w else 1.0
    if scale > 1.0:
        upscaled = pil_img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    else:
        upscaled = pil_img
    sharp = ImageEnhance.Sharpness(upscaled).enhance(2.0)
    variants.append(np.array(sharp))

    # 2) High-contrast grayscale (helps when lighting is bad)
    gray = sharp.convert('L')
    contrast = ImageEnhance.Contrast(gray).enhance(1.8)
    rgb = contrast.convert('RGB')
    variants.append(np.array(rgb))

    return variants


def slot_fix(text):
    """Fix common letter/digit confusions assuming standard 10-char Indian plate layout."""
    if len(text) == 10:
        out = []
        # slots 0,1,4,5 = letters; 2,3,6,7,8,9 = digits
        for i, ch in enumerate(text):
            if i in (0, 1, 4, 5):
                out.append(ch if ch.isalpha() else DIGIT_TO_LETTER.get(ch, ch))
            else:
                out.append(ch if ch.isdigit() else LETTER_TO_DIGIT.get(ch, ch))
        joined = ''.join(out)
        m = PLATE_REGEX.search(joined)
        if m:
            return m.group(0)

    if len(text) == 9:
        out = []
        # slots 0,1,4 = letters; 2,3,5,6,7,8 = digits
        for i, ch in enumerate(text):
            if i in (0, 1, 4):
                out.append(ch if ch.isalpha() else DIGIT_TO_LETTER.get(ch, ch))
            else:
                out.append(ch if ch.isdigit() else LETTER_TO_DIGIT.get(ch, ch))
        joined = ''.join(out)
        m = PLATE_REGEX.search(joined)
        if m:
            return m.group(0)

    return None


def extract_plate(text):
    """Try to extract a valid plate string from raw OCR text."""
    cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
    m = PLATE_REGEX.search(cleaned)
    if m:
        return m.group(0)
    return slot_fix(cleaned)


def merge_detections(detections):
    """
    PaddleOCR returns one entry per detected text line. License plates often
    get split across two boxes (state code and number). Concatenate adjacent
    boxes and try to extract a plate.
    """
    if not detections:
        return []

    candidates = []

    # Single-box candidates
    for d in detections:
        plate = extract_plate(d['text'])
        if plate:
            candidates.append({
                'plate': plate,
                'confidence': d['confidence'],
                'bbox': d['bbox'],
            })

    # Two-box concatenation candidates (left-to-right by x-center)
    sorted_dets = sorted(detections, key=lambda d: (d['bbox'][0] + d['bbox'][2]) / 2)
    for i in range(len(sorted_dets) - 1):
        a, b = sorted_dets[i], sorted_dets[i + 1]
        combined_text = a['text'] + b['text']
        plate = extract_plate(combined_text)
        if plate:
            # Bbox = union
            ax1, ay1, ax2, ay2 = a['bbox']
            bx1, by1, bx2, by2 = b['bbox']
            bbox = [min(ax1, bx1), min(ay1, by1), max(ax2, bx2), max(ay2, by2)]
            candidates.append({
                'plate': plate,
                'confidence': (a['confidence'] + b['confidence']) / 2,
                'bbox': bbox,
            })

    return candidates


def normalize_bbox(quad):
    """Convert PaddleOCR quad to axis-aligned bbox. Handles list-of-lists and numpy arrays."""
    try:
        # numpy arrays support iteration the same way
        pts = [(float(p[0]), float(p[1])) for p in quad]
    except (TypeError, IndexError):
        return [0, 0, 0, 0]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


# ---------- Routes ----------
@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'service': 'paddleocr'})


@app.route('/detect', methods=['POST'])
def detect():
    if 'image' not in request.files:
        return jsonify({'error': 'no image field'}), 400

    file = request.files['image']
    try:
        pil_img = Image.open(io.BytesIO(file.read())).convert('RGB')
    except Exception as e:
        return jsonify({'error': f'invalid image: {e}'}), 400

    img_w, img_h = pil_img.size
    ocr = get_ocr()

    all_detections = []
    variants = preprocess_variants(pil_img)
    seen_texts = set()

    for variant_img in variants:
        try:
            # PaddleOCR 3.x removed the `cls` arg; older versions need it.
            try:
                result = ocr.predict(variant_img)
            except AttributeError:
                try:
                    result = ocr.ocr(variant_img, cls=True)
                except TypeError:
                    result = ocr.ocr(variant_img)
        except Exception as e:
            log.warning(f"OCR failed on variant: {e}")
            continue

        if not result:
            continue

        # PaddleOCR 3.x returns a list of dicts: [{rec_texts, rec_scores, rec_polys, ...}]
        # PaddleOCR 2.x returns nested lists: [[[quad, (text, conf)], ...]]
        for entry in result:
            # 3.x dict shape
            if isinstance(entry, dict) and 'rec_texts' in entry:
                texts = entry.get('rec_texts', [])
                scores = entry.get('rec_scores', [])
                polys = entry.get('rec_polys', []) or entry.get('dt_polys', [])
                for i, text in enumerate(texts):
                    text_clean = (text or '').strip()
                    if not text_clean or text_clean in seen_texts:
                        continue
                    seen_texts.add(text_clean)
                    conf = float(scores[i]) if i < len(scores) else 0.0
                    poly = polys[i] if i < len(polys) else None
                    bbox = normalize_bbox(poly) if poly is not None else [0, 0, 0, 0]
                    all_detections.append({
                        'text': text_clean,
                        'confidence': conf * 100,
                        'bbox': bbox,
                    })
                continue

            # 2.x nested-list shape
            if not entry:
                continue
            for line in entry:
                try:
                    quad, (text, conf) = line[0], line[1]
                except (TypeError, ValueError, IndexError):
                    continue
                text_clean = (text or '').strip()
                if not text_clean or text_clean in seen_texts:
                    continue
                seen_texts.add(text_clean)
                all_detections.append({
                    'text': text_clean,
                    'confidence': float(conf) * 100,
                    'bbox': normalize_bbox(quad),
                })

    # Find best plate match
    candidates = merge_detections(all_detections)
    if candidates:
        best = max(candidates, key=lambda c: c['confidence'])
        log.info(f"detected: {best['plate']} ({best['confidence']:.1f}%) from {len(all_detections)} text region(s)")
        return jsonify({
            'plate': best['plate'],
            'confidence': round(best['confidence'], 1),
            'bbox': best['bbox'],
            'image_width': img_w,
            'image_height': img_h,
            'all_detections': all_detections,
        })

    # No plate matched the regex, but return raw detections so the UI can
    # show "text seen" and so we can debug
    if all_detections:
        sample = ', '.join(repr(d['text']) for d in all_detections[:5])
        log.info(f"no plate matched | {len(all_detections)} text region(s) seen: {sample}")
    else:
        log.info("no text detected at all (image may be too blurry / no text visible)")
    return jsonify({
        'plate': None,
        'confidence': 0,
        'bbox': None,
        'image_width': img_w,
        'image_height': img_h,
        'all_detections': all_detections,
    })


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    log.info(f"Starting on port {port}")
    # Warm up the model so the first real request is fast
    try:
        get_ocr()
    except Exception as e:
        log.error(f"Failed to load PaddleOCR: {e}")
        log.error("Install with: pip install paddleocr paddlepaddle flask pillow numpy")
        sys.exit(1)
    app.run(host='127.0.0.1', port=port, threaded=True)