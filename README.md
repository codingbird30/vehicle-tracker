# Vehicle Entry Tracker

Real-time license plate recognition with RTO verification, automatic continuous scanning, MongoDB storage, and a live dashboard.

## Architecture

Three processes run together:

```
┌─────────────────┐    HTTP     ┌──────────────┐    HTTP     ┌────────────────┐
│ Browser         │◀──────────▶│  Node.js     │◀──────────▶│ Python sidecar │
│ dashboard       │             │  Express     │             │ PaddleOCR      │
│ http://:3000    │             │  http://:3000│             │ http://:5001   │
└─────────────────┘             └───────┬──────┘             └────────────────┘
                                        │
                                  ┌─────┴──────┐         ┌──────────────┐
                                  │  MongoDB   │         │  ESP32-CAM   │
                                  └────────────┘         └──────────────┘
```

- **Node.js (port 3000)** — Express server, dashboard, MongoDB writes, RTO API, ESP32 control
- **Python (port 5001)** — PaddleOCR plate detection sidecar (called by Node)
- **MongoDB** — record storage
- **ESP32-CAM** — camera feed + alert LED

## Features

- **Continuous auto-scan** — every 1.5 seconds the system pulls a snapshot from the ESP32-CAM, runs PaddleOCR on it, and draws green bounding boxes over any detected text in the live feed.
- **PaddleOCR** — significantly more accurate than Tesseract on real-world Indian plates, handles modest blur, low light, and angle.
- **FireAPI RTO integration** — looks up owner, vehicle, registration, and insurance details.
- **Bounding box overlay** — green boxes show every detected text region; thicker green box highlights the actual matched plate.
- **Snapshot storage** — every successful scan saves the image. Click any thumbnail to view full size.
- **Manual plate input** — type a plate number directly to look it up without the camera.
- **ESP32-CAM alert LED** — onboard flash LED blinks when an unauthorized vehicle is detected.
- **Dark / light theme toggle.**
- **API errors are not logged to the event log** — only successful lookups (whether authorized or not authorized) get DB records.

## Quick start

```bash
# 1. one-time setup (installs Node deps + creates Python venv + installs PaddleOCR)
npm run setup

# 2. configure
cp .env.example .env
# edit .env with your MONGO_URI, RTO_API_KEY, ESP32_CAM_IP

# 3. flash the ESP32-CAM (one-time)
#    see docs/ESP32_SETUP.md

# 4. start everything (Node + Python sidecar in one terminal)
npm start

# 5. open http://localhost:3000
```

That's it. `npm start` boots both the Node backend and the Python OCR sidecar with prefixed log output (yellow for Node, cyan for OCR). If either crashes, both shut down so you don't end up with orphan processes.

If you want to run them separately for debugging:

```bash
npm run start:python   # in one terminal
npm run start:node     # in another
```

## How it handles different scan outcomes

| Situation | What happens |
|---|---|
| No text in frame | Silent skip, no green boxes |
| Text detected but not a valid plate | Green boxes drawn, footer shows "N text region(s) — no plate" |
| Valid plate, RTO returns data, ≤15 yrs old | ✅ Authorized, saved to DB, ESP32 LED stays off |
| Valid plate, RTO returns data, >15 yrs old | ❌ not authorized (`expired`), saved to DB, ESP32 LED blinks |
| Valid plate, RTO returns "not found" | ❌ not authorized (`not_found`), saved to DB, ESP32 LED blinks |
| Valid plate, RTO API errors out (network, 500) | **Not saved to DB.** Footer shows error. |
| Same plate scanned within 30 seconds | Skipped (dedup window) |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auto-scan` | Auto-scan tick — runs OCR, only does RTO + DB if plate matches |
| POST | `/api/trigger-scan` | Manual: pull snapshot from ESP32 → full pipeline |
| POST | `/api/scan` | Upload image manually (multipart `image`) |
| POST | `/api/check-plate` | Manual: lookup by plate string, no image needed |
| GET  | `/api/vehicles?limit=N` | Recent records |
| GET  | `/api/stats` | Counts (last 30 days) |
| POST | `/api/alert` `{state}` | Manual alert: `'alert'` or `'ok'` |
| GET  | `/api/config` | Camera + OCR config for the frontend |

## Project structure

```
vehicle-tracker/
├── backend/                    Node.js / Express
│   ├── server.js
│   ├── models/Vehicle.js
│   └── services/
│       ├── ocrService.js       (calls Python sidecar)
│       ├── rtoService.js       (FireAPI)
│       └── esp32Service.js
├── python-ocr/                 PaddleOCR sidecar
│   ├── app.py
│   ├── requirements.txt
│   └── README.md
├── public/                     Frontend (HTML/CSS/JS)
├── esp32/sentinel_cam.ino
├── docs/ESP32_SETUP.md
├── uploads/                    Snapshots saved here at runtime
├── .env.example
└── package.json
```
