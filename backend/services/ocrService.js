const axios = require('axios');
const FormData = require('form-data');

const PYTHON_OCR_URL = process.env.PYTHON_OCR_URL || 'http://127.0.0.1:5001';

// Indian plate format
const PLATE_REGEX = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/;

/**
 * Calls the Python PaddleOCR sidecar.
 * Returns:
 *   {
 *     plateNumber: 'MH12AB1234' | null,
 *     confidence: 0..100,
 *     bbox: [x1, y1, x2, y2] | null,   (in original image coords)
 *     imageWidth, imageHeight,
 *     allDetections: [{text, confidence, bbox}, ...],
 *     source: 'paddleocr'
 *   }
 */
async function extractPlate(imageBuffer) {
  const form = new FormData();
  form.append('image', imageBuffer, { filename: 'plate.jpg', contentType: 'image/jpeg' });

  try {
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
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('[OCR] Python service not reachable at', PYTHON_OCR_URL);
      console.error('[OCR] Start it: cd python-ocr && python app.py');
    } else {
      console.error('[OCR] Python service error:', err.message);
    }
    throw new Error(`Python OCR unreachable: ${err.message}`);
  }
}

/** Quick check used by the auto-scan loop. */
function isPlausiblePlate(plate) {
  if (!plate) return false;
  if (plate.length < 8 || plate.length > 11) return false;
  return PLATE_REGEX.test(plate);
}

/** Health check — used at server startup to log a warning if Python isn't running. */
async function checkHealth() {
  try {
    const resp = await axios.get(`${PYTHON_OCR_URL}/health`, { timeout: 2000 });
    return resp.data?.ok === true;
  } catch {
    return false;
  }
}

module.exports = { extractPlate, isPlausiblePlate, checkHealth, PLATE_REGEX };
