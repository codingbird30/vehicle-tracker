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

// Ensure uploads directory exists
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
  console.error('\n[FATAL] MONGO_URI is not set.');
  console.error('  Create a .env file in the project root (same folder as package.json):');
  console.error('  $ cp .env.example .env');
  console.error('  Then edit it and set MONGO_URI, e.g.:');
  console.error('    MONGO_URI=mongodb://127.0.0.1:27017/vehicle_tracker\n');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('[DB] Connected to MongoDB'))
  .catch((err) => console.error('[DB] Connection error:', err.message));

// ============================================
// CORE PIPELINE: image -> OCR -> RTO -> DB -> LED
// ============================================
async function processImage(imageBuffer, savedImagePath) {
  // 1. OCR
  const ocrResult = await ocrService.extractPlate(imageBuffer);
  if (!ocrResult.plateNumber) {
    // Treat unreadable plate as a "not authorized" event - blink the alert LED.
    await esp32Service.setAlert('alert');
    return {
      success: false,
      stage: 'ocr',
      message: 'No license plate detected',
      ocr: ocrResult,
    };
  }

  // 2. RTO lookup
  const rtoResult = await rtoService.fetchRTODetails(ocrResult.plateNumber);
  const decision = rtoService.decideAuthorization(rtoResult);

  // 3. Save to DB
  const vehicle = new Vehicle({
    plateNumber: ocrResult.plateNumber,
    isAuthorized: decision.isAuthorized,
    reason: decision.reason,
    ownerName: rtoResult.data?.ownerName ?? null,
    address: rtoResult.data?.address ?? null,
    model: rtoResult.data?.model ?? null,
    manufacturer: rtoResult.data?.manufacturer ?? null,
    fuelType: rtoResult.data?.fuelType ?? null,
    registrationDate: rtoResult.data?.registrationDate
      ? new Date(rtoResult.data.registrationDate)
      : null,
    rtoLocation: rtoResult.data?.rtoLocation ?? null,
    rawApiResponse: rtoResult.raw,
    capturedImagePath: savedImagePath
      ? `/uploads/${path.basename(savedImagePath)}`
      : null,
  });
  await vehicle.save();

  // 4. Toggle ESP32 indicator: clear alert if authorized, blink if not.
  await esp32Service.setIndicator(decision.isAuthorized);

  return { success: true, vehicle, ocr: ocrResult, rto: rtoResult, decision };
}

// ============================================
// ROUTES
// ============================================

// Browser snapshot upload (e.g. user clicks "Capture" in UI which grabs from MJPEG)
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const buf = fs.readFileSync(req.file.path);
    const result = await processImage(buf, req.file.path);
    res.json(result);
  } catch (err) {
    console.error('[/api/scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// Triggered scan: server pulls a fresh snapshot from ESP32 and processes it
app.post('/api/trigger-scan', async (_req, res) => {
  try {
    const buf = await esp32Service.captureSnapshot();
    const filename = `plate_${Date.now()}.jpg`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, buf);
    const result = await processImage(buf, filepath);
    res.json(result);
  } catch (err) {
    console.error('[/api/trigger-scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// History (most recent first)
app.get('/api/vehicles', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const list = await Vehicle.find().sort({ createdAt: -1 }).limit(limit);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats for dashboard
app.get('/api/stats', async (_req, res) => {
  try {
    const [total, authorized, unauthorized] = await Promise.all([
      Vehicle.countDocuments(),
      Vehicle.countDocuments({ isAuthorized: true }),
      Vehicle.countDocuments({ isAuthorized: false }),
    ]);
    res.json({ total, authorized, unauthorized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual alert control (for testing): { state: 'alert' | 'ok' }
app.post('/api/alert', async (req, res) => {
  const { state } = req.body;
  const result = await esp32Service.setAlert(state);
  res.json(result);
});

// ESP32 stream URL passthrough (frontend reads this to know where to point <img>)
app.get('/api/config', (_req, res) => {
  res.json({
    esp32StreamUrl: process.env.ESP32_CAM_IP
      ? `http://${process.env.ESP32_CAM_IP}:81/stream`
      : null,
    esp32CaptureUrl: process.env.ESP32_CAM_IP
      ? `http://${process.env.ESP32_CAM_IP}/capture`
      : null,
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
});