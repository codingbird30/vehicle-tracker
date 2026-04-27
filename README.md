# SENTINEL — Real-time Vehicle Access Control

ESP32-CAM based number-plate tracker with RTO verification, MongoDB storage, and a live monitoring dashboard.

## What it does

```
┌────────────┐   stream/capture    ┌────────────┐   OCR   ┌────────────┐
│ ESP32-CAM  │ ──────────────────▶ │  Node.js   │ ──────▶ │ Tesseract  │
│ + flash    │                     │  Express   │         └────────────┘
│ LED alert  │ ◀── /alert or /ok ─ │            │ ──RTO─▶ Placeholder API
└────────────┘                     │            │ ──────▶ MongoDB
                                   └─────┬──────┘
                                         │ stats / history
                                         ▼
                                   ┌────────────┐
                                   │  Browser   │
                                   │ Dashboard  │
                                   └────────────┘
```

**Indicator behavior:**
- ✅ **Authorized** vehicle → LED stays off (silence = OK)
- ❌ **Unauthorized** vehicle → onboard flash LED **blinks rapidly** for ~3 seconds

**Authorization rule:** A vehicle is authorized only if the RTO API returns valid data **and** the registration is within the last **15 years**. Otherwise it's saved with `isAuthorized: false` plus a reason (`expired`, `not_found`, `api_error`, etc.).

---

## Quick start

```bash
# 1. install backend
npm install

# 2. configure
cp .env.example .env
# edit .env: set MONGO_URI and ESP32_CAM_IP

# 3. flash the ESP32-CAM
#    use sentinel_cam.ino from esp32/ folder ALONGSIDE your existing
#    app_httpd.cpp + board_config.h + camera_index.h
#    full instructions in docs/ESP32_SETUP.md

# 4. run server
npm start

# 5. open the dashboard
#    -> http://localhost:3000   (NOT file://...index.html)
```

---

## Project structure

```
vehicle-tracker/
├── backend/
│   ├── server.js              ← Express server, routes, full pipeline
│   ├── models/Vehicle.js      ← Mongoose schema
│   └── services/
│       ├── ocrService.js      ← Tesseract.js + sharp preprocessing
│       ├── rtoService.js      ← RTO API + auth decision (mock mode default)
│       └── esp32Service.js    ← talks to ESP32-CAM (capture + alert)
├── public/
│   ├── index.html             ← dashboard
│   ├── styles.css             ← industrial terminal aesthetic
│   └── app.js                 ← frontend logic
├── esp32/
│   └── sentinel_cam.ino       ← Arduino .ino (drops into existing sketch folder)
├── docs/
│   └── ESP32_SETUP.md         ← full hardware + flashing guide
├── .env.example
├── package.json
└── README.md
```

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/trigger-scan` | server pulls fresh snapshot from ESP32 → full pipeline |
| POST | `/api/scan` | upload an image manually (multipart `image`) |
| GET  | `/api/vehicles?limit=N` | recent records |
| GET  | `/api/stats` | total / authorized / unauthorized counts |
| POST | `/api/alert` `{state}` | manual alert control: `'alert'` or `'ok'` |
| GET  | `/api/config` | returns ESP32 stream/capture URLs for the frontend |

---

See **`docs/ESP32_SETUP.md`** for hardware setup, flashing, alert behavior tweaks, and troubleshooting.
