import io
import os
import re
import sys
import logging
import warnings
import json

os.environ['GLOG_minloglevel'] = '3'
os.environ['FLAGS_call_stack_level'] = '0'
os.environ['PPOCR_LOG_LEVEL'] = 'ERROR'
os.environ['FLAGS_logtostderr'] = '0'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
warnings.filterwarnings('ignore')

import logging as _stdlogging
_stdlogging.getLogger('werkzeug').setLevel(_stdlogging.ERROR)

from flask import Flask, request, jsonify
from PIL import Image, ImageEnhance
import numpy as np

logging.basicConfig(level=logging.INFO, format='[python-ocr] %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

PLATE_REGEX = re.compile(r'[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}')

LETTER_TO_DIGIT = {'O':'0','D':'0','Q':'0','I':'1','L':'1','Z':'2','B':'8','S':'5','G':'6','T':'7'}
DIGIT_TO_LETTER = {'0':'O','1':'I','2':'Z','5':'S','6':'G','8':'B','7':'T'}

_ocr = None
_ocr_version = None  # '2' or '3'

def get_ocr():
    global _ocr, _ocr_version
    if _ocr is None:
        log.info("Loading PaddleOCR...")
        from paddleocr import PaddleOCR
        # Try 3.x API first, then 2.x
        for args in [
            dict(use_textline_orientation=True, lang='en'),
            dict(use_angle_cls=True, lang='en'),
            dict(lang='en'),
        ]:
            try:
                _ocr = PaddleOCR(**args)
                # Detect version by checking for predict method
                _ocr_version = '3' if hasattr(_ocr, 'predict') else '2'
                log.info(f"PaddleOCR ready (detected version ~{_ocr_version}.x, args={list(args.keys())})")
                return _ocr
            except (TypeError, Exception) as e:
                log.info(f"  init with {list(args.keys())} failed: {e}")
                continue
        raise RuntimeError("Could not initialize PaddleOCR with any known argument set")
    return _ocr


def preprocess_variants(pil_img):
    variants = []
    w, h = pil_img.size
    # Upscale small images
    if w < 800:
        scale = 1200 / w
        pil_img = pil_img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    sharp = ImageEnhance.Sharpness(pil_img).enhance(2.0)
    variants.append(np.array(sharp))
    contrast = ImageEnhance.Contrast(sharp.convert('L').convert('RGB')).enhance(1.8)
    variants.append(np.array(contrast))
    return variants


def normalize_bbox(quad):
    try:
        if hasattr(quad, 'tolist'):
            quad = quad.tolist()
        pts = [(float(p[0]), float(p[1])) for p in quad]
    except:
        return [0, 0, 0, 0]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


def slot_fix(text):
    if len(text) == 10:
        out = []
        for i, ch in enumerate(text):
            if i in (0, 1, 4, 5):
                out.append(ch if ch.isalpha() else DIGIT_TO_LETTER.get(ch, ch))
            else:
                out.append(ch if ch.isdigit() else LETTER_TO_DIGIT.get(ch, ch))
        joined = ''.join(out)
        m = PLATE_REGEX.search(joined)
        if m: return m.group(0)
    if len(text) == 9:
        out = []
        for i, ch in enumerate(text):
            if i in (0, 1, 4):
                out.append(ch if ch.isalpha() else DIGIT_TO_LETTER.get(ch, ch))
            else:
                out.append(ch if ch.isdigit() else LETTER_TO_DIGIT.get(ch, ch))
        joined = ''.join(out)
        m = PLATE_REGEX.search(joined)
        if m: return m.group(0)
    return None


def extract_plate(text):
    cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
    m = PLATE_REGEX.search(cleaned)
    if m: return m.group(0)
    return slot_fix(cleaned)


def merge_detections(detections):
    if not detections: return []
    candidates = []
    for d in detections:
        plate = extract_plate(d['text'])
        if plate:
            candidates.append({'plate': plate, 'confidence': d['confidence'], 'bbox': d['bbox']})
    sorted_dets = sorted(detections, key=lambda d: (d['bbox'][0] + d['bbox'][2]) / 2)
    for i in range(len(sorted_dets) - 1):
        a, b = sorted_dets[i], sorted_dets[i + 1]
        plate = extract_plate(a['text'] + b['text'])
        if plate:
            ax1, ay1, ax2, ay2 = a['bbox']
            bx1, by1, bx2, by2 = b['bbox']
            candidates.append({
                'plate': plate,
                'confidence': (a['confidence'] + b['confidence']) / 2,
                'bbox': [min(ax1, bx1), min(ay1, by1), max(ax2, bx2), max(ay2, by2)],
            })
    return candidates


def _safe_json(obj):
    """Convert numpy types to Python types for JSON serialization."""
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.float32, np.float64)):
        return float(obj)
    if isinstance(obj, (np.int32, np.int64)):
        return int(obj)
    return obj


def _run_ocr_on_image(ocr, img_np):
    """Run PaddleOCR and return a flat list of {text, confidence, bbox} dicts."""
    detections = []
    seen = set()

    # --- Call the OCR ---
    if _ocr_version == '3':
        try:
            raw = ocr.predict(img_np)
            results = list(raw) if raw else []
        except Exception as e:
            log.warning(f"predict() failed: {e}, trying ocr()")
            try:
                results = ocr.ocr(img_np, cls=True) or []
            except TypeError:
                results = ocr.ocr(img_np) or []
    else:
        try:
            results = ocr.ocr(img_np, cls=True) or []
        except TypeError:
            results = ocr.ocr(img_np) or []

    if not results:
        return detections

    # --- Parse results ---
    for entry_idx, entry in enumerate(results):
        # --- 3.x dict shape ---
        if isinstance(entry, dict):
            # Try every known key pattern
            texts = None
            scores = None
            polys = None
            for tkey in ('rec_texts', 'rec_text', 'texts', 'text'):
                v = entry.get(tkey)
                if v is not None:
                    texts = [v] if isinstance(v, str) else list(v) if hasattr(v, '__iter__') else None
                    if texts: break
            for skey in ('rec_scores', 'rec_score', 'scores', 'score'):
                v = entry.get(skey)
                if v is not None:
                    if isinstance(v, (int, float, np.float32, np.float64)):
                        scores = [float(v)]
                    elif hasattr(v, '__iter__'):
                        scores = [float(x) for x in v]
                    if scores: break
            for pkey in ('rec_polys', 'dt_polys', 'rec_boxes', 'dt_boxes', 'polys', 'boxes'):
                v = entry.get(pkey)
                if v is not None:
                    polys = v if hasattr(v, '__len__') else None
                    if polys is not None and len(polys) > 0: break

            if not texts:
                log.info(f"  entry {entry_idx} keys={list(entry.keys())}, no text found")
                # Last resort: dump all values to find text
                for k, v in entry.items():
                    log.info(f"    {k}: type={type(v).__name__}, sample={str(v)[:120]}")
                continue

            for i, t in enumerate(texts):
                ts = str(t).strip()
                if not ts or ts in seen: continue
                seen.add(ts)
                conf = scores[i] if scores and i < len(scores) else 0.5
                if conf <= 1.0: conf *= 100
                poly = polys[i] if polys is not None and i < len(polys) else None
                bbox = normalize_bbox(poly) if poly is not None else [0,0,0,0]
                detections.append({'text': ts, 'confidence': round(float(conf), 1), 'bbox': bbox})
            continue

        # --- 2.x nested list shape ---
        if isinstance(entry, (list, tuple)):
            for line in entry:
                try:
                    if isinstance(line, (list, tuple)) and len(line) >= 2:
                        quad = line[0]
                        text_conf = line[1]
                        if isinstance(text_conf, (list, tuple)) and len(text_conf) >= 2:
                            text, conf = str(text_conf[0]).strip(), float(text_conf[1])
                        else:
                            continue
                    else:
                        continue
                except:
                    continue
                if not text or text in seen: continue
                seen.add(text)
                if conf <= 1.0: conf *= 100
                detections.append({
                    'text': text,
                    'confidence': round(conf, 1),
                    'bbox': normalize_bbox(quad),
                })

    return detections


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'service': 'paddleocr', 'version': _ocr_version})


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

    for vi, variant_img in enumerate(variants):
        dets = _run_ocr_on_image(ocr, variant_img)
        log.info(f"variant {vi}: {len(dets)} detections -> {[d['text'] for d in dets]}")
        for d in dets:
            if d['text'] not in {x['text'] for x in all_detections}:
                all_detections.append(d)

    candidates = merge_detections(all_detections)
    if candidates:
        best = max(candidates, key=lambda c: c['confidence'])
        log.info(f"PLATE: {best['plate']} ({best['confidence']}%)")
        return jsonify({
            'plate': best['plate'],
            'confidence': round(best['confidence'], 1),
            'bbox': best['bbox'],
            'image_width': img_w,
            'image_height': img_h,
            'all_detections': all_detections,
        })

    if all_detections:
        sample = ', '.join(repr(d['text']) for d in all_detections[:5])
        log.info(f"no plate regex match | {len(all_detections)} text(s): {sample}")
    else:
        log.info("no text detected at all")

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
    try:
        get_ocr()
    except Exception as e:
        log.error(f"Failed to load PaddleOCR: {e}")
        log.error("Install: pip install paddleocr paddlepaddle flask pillow numpy")
        sys.exit(1)
    app.run(host='127.0.0.1', port=port, threaded=True)
