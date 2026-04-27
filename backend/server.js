const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const Vehicle = require('./models/Vehicle');
const ocrService = require('./services/ocrService');
const rtoService = require('./services/rtoService');
const esp32Service = require('./services/esp32Service');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Snapshot storage
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `plate_${ts}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---- DB ----
if (!process.env.MONGO_URI) {
  console.error('\n[FATAL] MONGO_URI is not set. cp .env.example .env and edit it.\n');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('[DB] Connected to MongoDB'))
  .catch((err) => console.error('[DB] Connection error:', err.message));

// ============================================
// Recent-scan dedup cache (avoid spamming RTO API for the same plate)
// ============================================
const recentScans = new Map(); // plate -> timestamp
const DEDUP_WINDOW_MS = 30_000; // ignore the same plate within 30s

function isRecentDuplicate(plate) {
  const now = Date.now();
  for (const [p, ts] of recentScans) {
    if (now - ts > DEDUP_WINDOW_MS) recentScans.delete(p);
  }
  return recentScans.has(plate);
}
function rememberPlate(plate) {
  recentScans.set(plate, Date.now());
}

/**
 * Given a known plate number, do the RTO lookup, save to DB, and toggle the
 * ESP32 indicator. Used by both the OCR pipeline and the manual /check-plate
 * endpoint.
 */
async function processKnownPlate(plateNumber, opts = {}) {
  const { imagePathInUploads = null, ocrSource = null, ocrConfidence = null } = opts;

  // RTO lookup
  const rtoResult = await rtoService.fetchRTODetails(plateNumber);
  const decision = rtoService.decideAuthorization(rtoResult);
  const d = rtoResult.data || {};

  // For API errors, override the reason with a descriptive note
  const reason = decision.reason === 'api_error'
    ? `Number plate does not exist: RTO api ${rtoResult.error || 'unknown error'}`
    : decision.reason;

  // Build registrationDate safely — never pass an invalid date to Mongoose
  let regDate = null;
  if (d.registrationDate) {
    const parsed = new Date(d.registrationDate);
    if (!isNaN(parsed.getTime())) regDate = parsed;
  }

  // Build insuranceUpto safely
  let insUpto = null;
  if (d.insuranceUpto) {
    const parsed = new Date(d.insuranceUpto);
    if (!isNaN(parsed.getTime())) insUpto = parsed;
  }

  // Save to DB
  const vehicle = new Vehicle({
    plateNumber,
    isAuthorized: decision.isAuthorized,
    reason,
    ownerName: d.ownerName,
    fatherName: d.fatherName,
    permanentAddress: d.permanentAddress,
    presentAddress: d.presentAddress,
    manufacturer: d.manufacturer,
    model: d.model,
    fuelType: d.fuelType,
    vehicleCategory: d.vehicleCategory,
    cubicCapacity: d.cubicCapacity,
    seatingCapacity: d.seatingCapacity,
    chassisNumber: d.chassisNumber,
    engineNumber: d.engineNumber,
    manufactureYear: d.manufactureYear,
    registrationDate: regDate,
    fitnessUpto: d.fitnessUpto,
    rtoLocation: d.rtoLocation,
    rtoCode: d.rtoCode,
    stateCode: d.stateCode,
    insuranceCompany: d.insuranceCompany,
    insurancePolicyNumber: d.insurancePolicyNumber,
    insuranceUpto: insUpto,
    rawApiResponse: rtoResult.raw,
    capturedImagePath: imagePathInUploads,
    ocrSource,
    ocrConfidence,
  });
  await vehicle.save();

  // Toggle ESP32 indicator (best-effort — don't fail the request if camera is offline)
  try {
    await esp32Service.setIndicator(decision.isAuthorized);
  } catch (err) {
    console.warn('[ESP32] indicator toggle failed:', err.message);
  }

  return { vehicle, decision, rtoResult };
}

// ============================================
// CORE PIPELINE: image -> OCR -> RTO -> DB -> LED
// ============================================
async function runPipeline(imageBuffer, imagePathInUploads) {
  // 1. OCR
  const ocrResult = await ocrService.extractPlate(imageBuffer);
  if (!ocrService.isPlausiblePlate(ocrResult.plateNumber)) {
    return {
      success: false,
      stage: 'ocr',
      message: ocrResult.plateNumber
        ? `Plate "${ocrResult.plateNumber}" doesn't match expected format`
        : 'No license plate detected',
      ocr: ocrResult,
    };
  }

  // 2. Dedup
  if (isRecentDuplicate(ocrResult.plateNumber)) {
    return {
      success: false,
      stage: 'dedup',
      message: `Plate ${ocrResult.plateNumber} was just scanned`,
      ocr: ocrResult,
    };
  }
  rememberPlate(ocrResult.plateNumber);

  // 3-5. RTO + DB + LED
  const result = await processKnownPlate(ocrResult.plateNumber, {
    imagePathInUploads,
    ocrSource: ocrResult.source,
    ocrConfidence: ocrResult.confidence,
  });

  return { success: true, vehicle: result.vehicle, ocr: ocrResult, decision: result.decision };
}

// ============================================
// Helper: write buffer to uploads, return public path
// ============================================
function saveImage(buffer, prefix = 'plate') {
  const filename = `${prefix}_${Date.now()}.jpg`;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return { filepath, publicPath: `/uploads/${filename}` };
}

// ============================================
// ROUTES
// ============================================

// Manual upload from browser
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const buf = fs.readFileSync(req.file.path);
    const result = await runPipeline(buf, `/uploads/${req.file.filename}`);
    res.json(result);
  } catch (err) {
    console.error('[/api/scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual ESP32 trigger
app.post('/api/trigger-scan', async (_req, res) => {
  try {
    const buf = await esp32Service.captureSnapshot();
    const { publicPath } = saveImage(buf);
    const result = await runPipeline(buf, publicPath);
    res.json(result);
  } catch (err) {
    console.error('[/api/trigger-scan]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-scan tick — called periodically by the frontend (every 2-3s).
 * Pulls a snapshot from ESP32, runs OCR. Only proceeds to RTO + DB save
 * if a plausible plate is detected.
 *
 * Returns lightweight payloads:
 *   { skip: true, reason: '...' }                        - nothing to report
 *   { detected: false, ocrText: '...' }                  - OCR ran, no plate
 *   { detected: true, vehicle, decision, ... }           - full result
 */
app.post('/api/auto-scan', async (_req, res) => {
  try {
    // Capture from ESP32
    let buf;
    try {
      buf = await esp32Service.captureSnapshot();
    } catch (err) {
      return res.json({ skip: true, reason: 'camera_unreachable', detail: err.message });
    }

    // OCR
    let ocrResult;
    try {
      ocrResult = await ocrService.extractPlate(buf);
    } catch (err) {
      return res.json({ skip: true, reason: 'ocr_unreachable', detail: err.message });
    }

    // Build a snippet of detection info that the frontend can use to draw boxes
    const detectionInfo = {
      bbox: ocrResult.bbox,
      imageWidth: ocrResult.imageWidth,
      imageHeight: ocrResult.imageHeight,
      allDetections: ocrResult.allDetections || [],
    };

    if (!ocrService.isPlausiblePlate(ocrResult.plateNumber)) {
      return res.json({
        detected: false,
        ocrText: ocrResult.plateNumber || ocrResult.candidates?.[0] || null,
        confidence: ocrResult.confidence,
        ...detectionInfo,
      });
    }

    // Dedup before doing the expensive RTO call
    if (isRecentDuplicate(ocrResult.plateNumber)) {
      return res.json({
        skip: true,
        reason: 'recent_duplicate',
        plateNumber: ocrResult.plateNumber,
        ...detectionInfo,
      });
    }

    // Save snapshot only when we're committing to a real scan
    const { publicPath } = saveImage(buf);
    const result = await runPipeline(buf, publicPath);

    if (result.success) {
      res.json({ detected: true, ...result, ...detectionInfo });
    } else {
      res.json({ detected: false, ...result, ...detectionInfo });
    }
  } catch (err) {
    console.error('[/api/auto-scan]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual plate lookup — no camera needed.
 * Body: { plateNumber: 'MH12XQ4412' }
 * Runs the same RTO + DB + LED pipeline.
 * Bypasses the dedup window (manual checks should always run).
 */
app.post('/api/check-plate', async (req, res) => {
  try {
    const raw = (req.body?.plateNumber || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!raw) {
      return res.status(400).json({ success: false, stage: 'input', message: 'plateNumber is required' });
    }
    if (raw.length < 8 || raw.length > 11) {
      return res.json({
        success: false,
        stage: 'input',
        message: `Plate "${raw}" is ${raw.length} chars — expected 8–11`,
      });
    }
    if (!ocrService.PLATE_REGEX.test(raw)) {
      return res.json({
        success: false,
        stage: 'input',
        message: `Plate "${raw}" doesn't match expected format (e.g. MH12AB1234)`,
      });
    }

    const result = await processKnownPlate(raw, {
      ocrSource: 'manual',
      ocrConfidence: 100,
    });
    res.json({ success: true, vehicle: result.vehicle, decision: result.decision });
  } catch (err) {
    console.error('[/api/check-plate]', err);
    res.status(500).json({ success: false, stage: 'server', error: err.message });
  }
});

app.get('/api/vehicles', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const list = await Vehicle.find().sort({ createdAt: -1 }).limit(limit);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vehicles/:id', async (req, res) => {
  try {
    const v = await Vehicle.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    // Only count records from the last 30 days.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const window = { createdAt: { $gte: cutoff } };

    const [total, authorized, unauthorized] = await Promise.all([
      Vehicle.countDocuments(window),
      Vehicle.countDocuments({ ...window, isAuthorized: true }),
      Vehicle.countDocuments({ ...window, isAuthorized: false }),
    ]);
    res.json({ total, authorized, unauthorized, windowDays: 30 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alert', async (req, res) => {
  const { state } = req.body;
  const result = await esp32Service.setAlert(state);
  res.json(result);
});

app.get('/api/config', (_req, res) => {
  res.json({
    esp32StreamUrl: process.env.ESP32_CAM_IP ? `http://${process.env.ESP32_CAM_IP}:81/stream` : null,
    esp32CaptureUrl: process.env.ESP32_CAM_IP ? `http://${process.env.ESP32_CAM_IP}/capture` : null,
    ocrSource: 'paddleocr',
  });
});

app.listen(PORT, async () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  // Check Python OCR service
  const pyOk = await ocrService.checkHealth();
  if (pyOk) {
    console.log('[OCR] Python PaddleOCR service is reachable.');
  } else {
    console.warn('[OCR] ⚠ Python PaddleOCR service not reachable.');
    console.warn('[OCR]   Start it: cd python-ocr && source venv/bin/activate && python app.py');
  }
});

