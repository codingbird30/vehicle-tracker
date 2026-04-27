# ESP32-CAM Setup Guide

This project uses your **existing** ESP32-CAM camera-server sketch (the one based on the standard CameraWebServer example, with `app_httpd.cpp` and `board_config.h`). On top of that, `sentinel_cam.ino` adds a **second tiny HTTP server on port 82** that exposes alert endpoints — your camera, capture, and stream code stay untouched.

## What the indicator does

The AI-Thinker ESP32-CAM has **two onboard LEDs**, no wiring needed:

| LED | GPIO | Notes |
|---|---|---|
| **White flash LED** (big, next to the lens) | **4** | bright, very visible — what we use by default |
| Small red status LED (back of board) | 33 | dim, active LOW |

**Default behavior:** when an unauthorized vehicle is detected, the **flash LED blinks rapidly** ~10 times, then auto-turns-off. Authorized vehicles produce no LED activity (silence = OK).

If you want to switch to the small red status LED instead, edit two lines at the top of `sentinel_cam.ino`:

```cpp
#define ALERT_PIN          33      // was 4
#define ALERT_ACTIVE_HIGH  false   // was true (GPIO 33 is active LOW)
```

If later you wire an external red LED on a different GPIO, just change `ALERT_PIN` to that GPIO number and set `ALERT_ACTIVE_HIGH` based on your wiring.

---

## Sketch files you need in your Arduino IDE folder

Your sketch folder must contain **all three** of these (the first two come from the standard CameraWebServer example you already have):

```
sentinel_cam/
├── sentinel_cam.ino       ← from this project (replaces your old .ino)
├── app_httpd.cpp          ← from your existing sketch (don't change)
├── board_config.h         ← from your existing sketch (don't change)
└── camera_index.h         ← from your existing sketch (don't change)
```

The `sentinel_cam.ino` from this project calls `startCameraServer()`, which is defined in `app_httpd.cpp` — exactly like your current setup. We just added the alert server alongside.

---

## Flashing

1. Open the folder in Arduino IDE.
2. Edit Wi-Fi creds at the top of `sentinel_cam.ino`:
   ```cpp
   const char *ssid = "YourWiFi";
   const char *password = "YourPassword";
   ```
3. **Tools** menu:
   - Board: **AI Thinker ESP32-CAM**
   - Partition Scheme: **Huge APP (3MB No OTA / 1MB SPIFFS)**
4. Hold GPIO 0 → GND, press RST, click Upload. Release GPIO 0 when upload finishes, press RST again.
5. Open Serial Monitor at 115200 baud. You should see:
   ```
   WiFi connected
   IP Address: 192.168.x.y
   Camera Ready! Open: http://192.168.x.y
   Alert endpoint ready: http://192.168.x.y:82/alert
   ```
6. The flash LED will **double-blink** at boot — that confirms the alert pin is working.

---

## Verifying the endpoints

| URL | Expected |
|---|---|
| `http://<ip>/` | your existing camera control panel |
| `http://<ip>/capture` | one JPEG snapshot |
| `http://<ip>:81/stream` | live MJPEG video |
| `http://<ip>:82/` | alert server status page |
| `http://<ip>:82/alert` | flash LED blinks ~10 times |
| `http://<ip>:82/ok` | clears any active blink |
| `http://<ip>:82/status` | JSON `{alerting, blinks_left}` |

If `http://<ip>:82/alert` makes the white flash LED blink, hardware side is done. ✅

---

## Backend setup

```bash
cd vehicle-tracker
npm install
cp .env.example .env
```

Edit `.env`:
```env
MONGO_URI=mongodb://127.0.0.1:27017/vehicle_tracker
ESP32_CAM_IP=192.168.x.y           # the IP from Serial Monitor
RTO_API_KEY=YOUR_RTO_API_KEY_HERE  # leave as-is for mock mode
PORT=3000
```

Then:
```bash
npm start
```

**Important:** open `http://localhost:3000` in your browser. Don't double-click `index.html` — the page needs to be served by Express to talk to the API and the camera.

---

## How the full pipeline runs

1. Browser loads dashboard → MJPEG feed from `http://<ip>:81/stream` shows live.
2. Click **TRIGGER SCAN**:
   - Backend hits `http://<ip>/capture` → JPEG.
   - `sharp` preprocesses → `tesseract.js` OCR → Indian plate regex.
3. Backend calls RTO API (or mock):
   - No data → `isAuthorized: false`, reason `not_found`.
   - Registration > 15 yrs old → `isAuthorized: false`, reason `expired`.
   - Otherwise → `isAuthorized: true` with full vehicle details.
4. Record saved to MongoDB.
5. **If unauthorized:** backend hits `http://<ip>:82/alert` → flash LED blinks. **If authorized:** backend hits `http://<ip>:82/ok` (no-op if nothing was blinking).
6. Frontend re-renders the result card and refreshes the event log.

---

## Mock mode (no RTO API key needed)

Leave `RTO_API_KEY=YOUR_RTO_API_KEY_HERE` and:
- plates ending in **odd digit** → ✅ authorized
- plates ending in **even digit** → ❌ unauthorized (`expired`, 18-year-old reg)
- plates containing `NOTFOUND` → ❌ unauthorized (`not_found`)

Lets you test the whole pipeline including the LED blink before paying for an API.

---

## Switching to a real RTO API

Open `backend/services/rtoService.js` and adjust the `normalize()` function to match your provider's response field names (Surepass, Signzy, RapidAPI vendors are all similar but field names vary). Then set `RTO_API_KEY` and `RTO_API_URL` in `.env`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Page loads with no styling | You opened `index.html` directly. Use `http://localhost:3000` instead. |
| `Brownout detector triggered` | underpowered — use a separate 5V/2A supply, not FTDI's 5V |
| `:82/alert` returns nothing | sketch didn't compile or `alertServer.begin()` didn't run; check Serial Monitor |
| Flash LED is too bright in your eyes | switch `ALERT_PIN` to `33` and `ALERT_ACTIVE_HIGH` to `false` (uses dim red status LED instead) |
| Mongo connection refused | start MongoDB or use Atlas (`mongodb+srv://...` URI) |
| Stream not loading in dashboard | open `http://<ip>:81/stream` directly in browser to confirm camera is up |
