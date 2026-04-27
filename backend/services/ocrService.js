const axios = require('axios');
const FormData = require('form-data');

const PYTHON_OCR_URL = process.env.PYTHON_OCR_URL || 'http://127.0.0.1:5001';
const PLATE_RECOGNIZER_TOKEN = process.env.PLATE_RECOGNIZER_TOKEN;
const PLATE_RECOGNIZER_URL = 'https://api.platerecognizer.com/v1/plate-reader/';
const PLATE_RECOGNIZER_REGIONS = process.env.PLATE_RECOGNIZER_REGIONS || 'in';

const PLATE_REGEX = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/;

function hasPlateRecognizerToken() {
  return PLATE_RECOGNIZER_TOKEN
    && PLATE_RECOGNIZER_TOKEN !== 'YOUR_PLATE_RECOGNIZER_TOKEN_HERE'
    && PLATE_RECOGNIZER_TOKEN.length > 10;
}

// ---- PaddleOCR (local Python sidecar) ----
async function extractWithPaddleOCR(imageBuffer) {
  const form = new FormData();
  form.append('image', imageBuffer, { filename: 'plate.jpg', contentType: 'image/jpeg' });

  const response = await axios.post(`${PYTHON_OCR_URL}/detect`, form, {
    headers: form.getHeaders(),
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const d = response.data;
  return {
    plateNumber: d.plate || null,
    confidence: d.confidence || 0,
    bbox: d.bbox || null,
    imageWidth: d.image_width || null,
    imageHeight: d.image_height || null,
    allDetections: d.all_detections || [],
    candidates: (d.all_detections || []).map(x => x.text),
    source: 'paddleocr',
  };
}

// ---- Plate Recognizer (cloud fallback) ----
async function extractWithPlateRecognizer(imageBuffer) {
  const form = new FormData();
  form.append('upload', imageBuffer, { filename: 'plate.jpg', contentType: 'image/jpeg' });
  form.append('regions', PLATE_RECOGNIZER_REGIONS);

  const response = await axios.post(PLATE_RECOGNIZER_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Token ${PLATE_RECOGNIZER_TOKEN}`,
    },
    timeout: 15000,
  });

  const results = response.data?.results || [];
  if (results.length === 0) {
    return { plateNumber: null, confidence: 0, source: 'plate-recognizer', candidates: [], allDetections: [] };
  }

  const best = results.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const plate = (best.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bbox = best.box
    ? [best.box.xmin, best.box.ymin, best.box.xmax, best.box.ymax]
    : null;

  return {
    plateNumber: plate || null,
    confidence: Math.round((best.score || 0) * 100),
    bbox,
    imageWidth: null,
    imageHeight: null,
    allDetections: results.map(r => ({
      text: (r.plate || '').toUpperCase(),
      confidence: Math.round((r.score || 0) * 100),
      bbox: r.box ? [r.box.xmin, r.box.ymin, r.box.xmax, r.box.ymax] : [0,0,0,0],
    })),
    candidates: results.map(r => (r.plate || '').toUpperCase()),
    source: 'plate-recognizer',
  };
}

// ---- Public API: try PaddleOCR, fall back to Plate Recognizer ----
async function extractPlate(imageBuffer) {
  // 1. Try PaddleOCR (local)
  try {
    const result = await extractWithPaddleOCR(imageBuffer);
    if (result.plateNumber) {
      return result; // success — done
    }
    // PaddleOCR ran but didn't find a plate. If Plate Recognizer is available, try that.
    if (hasPlateRecognizerToken()) {
      console.log('[OCR] PaddleOCR found no plate, trying Plate Recognizer fallback...');
      try {
        const prResult = await extractWithPlateRecognizer(imageBuffer);
        if (prResult.plateNumber) return prResult;
      } catch (prErr) {
        console.warn('[OCR] Plate Recognizer fallback failed:', prErr.message);
      }
    }
    // Return PaddleOCR's result (with allDetections for the UI)
    return result;
  } catch (err) {
    // PaddleOCR is completely unreachable
    if (hasPlateRecognizerToken()) {
      console.log('[OCR] PaddleOCR unreachable, using Plate Recognizer...');
      return await extractWithPlateRecognizer(imageBuffer);
    }
    throw err; // nothing available
  }
}

function isPlausiblePlate(plate) {
  if (!plate) return false;
  if (plate.length < 8 || plate.length > 11) return false;
  return PLATE_REGEX.test(plate);
}

async function checkHealth() {
  try {
    const resp = await axios.get(`${PYTHON_OCR_URL}/health`, { timeout: 2000 });
    return resp.data?.ok === true;
  } catch { return false; }
}

module.exports = { extractPlate, isPlausiblePlate, checkHealth, PLATE_REGEX };
