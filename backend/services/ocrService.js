const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        tessedit_pageseg_mode: '7', // single text line
      });
      return worker;
    })();
  }
  return workerPromise;
}

/** Multiple preprocessing variants — Tesseract does better on different ones. */
async function preprocessVariants(imageBuffer) {
  const base = sharp(imageBuffer)
    .resize({ width: 1200, withoutEnlargement: false })
    .grayscale()
    .normalize();

  const v1 = await base.clone().sharpen().threshold(150).toBuffer();
  const v2 = await base.clone().sharpen({ sigma: 1.5 }).toBuffer();
  const v3 = await base.clone().median(2).sharpen().threshold(135).toBuffer();
  return [v1, v2, v3];
}

// Indian plate format: 2 letters + 1-2 digits + 1-3 letters + 4 digits.
const PLATE_REGEX = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/;

const LETTER_TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', B: '8', S: '5', G: '6', T: '7' };
const DIGIT_TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B', '7': 'T' };

/**
 * Slot-aware character correction for digit/letter confusions.
 * Tries the standard 2-2-2-4 layout (10 chars) and 2-2-1-4 layout (9 chars).
 */
function slotFix(text) {
  const tryLayout = (length, letterSlots) => {
    if (text.length !== length) return null;
    const out = [];
    for (let i = 0; i < length; i++) {
      const ch = text[i];
      if (letterSlots.has(i)) {
        out.push(/[A-Z]/.test(ch) ? ch : (DIGIT_TO_LETTER[ch] || ch));
      } else {
        out.push(/[0-9]/.test(ch) ? ch : (LETTER_TO_DIGIT[ch] || ch));
      }
    }
    const joined = out.join('');
    return PLATE_REGEX.test(joined) ? joined.match(PLATE_REGEX)[0] : null;
  };

  return (
    tryLayout(10, new Set([0, 1, 4, 5])) ||  // standard 2-2-2-4
    tryLayout(9,  new Set([0, 1, 4]))    ||  // 2-2-1-4
    null
  );
}

/** Returns first plate candidate found in `text` (after cleanup), or null. */
function tryExtractPlate(text) {
  const cleaned = (text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // 1) Direct regex match
  const direct = cleaned.match(PLATE_REGEX);
  if (direct) return { plate: direct[0], cleaned };

  // 2) Slot-fix attempt
  const fixed = slotFix(cleaned);
  if (fixed) return { plate: fixed, cleaned };

  return { plate: null, cleaned };
}

/**
 * Run OCR on multiple preprocessed variants. Return the best plate + all candidates.
 * If no variant produces a regex-valid plate, the cleaned OCR text is still returned
 * so the user can review/correct it on the dashboard.
 */
async function extractPlate(imageBuffer) {
  const variants = await preprocessVariants(imageBuffer);
  const worker = await getWorker();

  const attempts = [];
  for (const buf of variants) {
    const { data } = await worker.recognize(buf);
    const { plate, cleaned } = tryExtractPlate(data.text);
    attempts.push({
      plate,
      cleaned,
      confidence: data.confidence || 0,
      rawText: data.text,
    });
  }

  // Best successful match (highest confidence among attempts that produced a plate)
  const successful = attempts
    .filter((a) => a.plate)
    .sort((a, b) => b.confidence - a.confidence);

  // All distinct candidate strings the user can pick from / edit
  const candidates = Array.from(
    new Set(attempts.map((a) => a.plate || a.cleaned).filter(Boolean))
  );

  if (successful.length > 0) {
    const best = successful[0];
    return {
      plateNumber: best.plate,
      confidence: best.confidence,
      rawText: best.rawText,
      cleanedText: best.cleaned,
      candidates,
    };
  }

  const best = attempts.sort((a, b) => b.confidence - a.confidence)[0];
  return {
    plateNumber: null,
    confidence: best.confidence,
    rawText: best.rawText,
    cleanedText: best.cleaned,
    candidates,
  };
}

async function shutdown() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { extractPlate, shutdown, tryExtractPlate, PLATE_REGEX };