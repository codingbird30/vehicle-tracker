# ESP32-CAM Setup Guide

This project uses your existing camera-server sketch (the standard CameraWebServer example with `app_httpd.cpp` and `board_config.h`). On top of that, `sentinel_cam.ino` adds a second tiny HTTP server on **port 82** for alert LED control. Your camera, capture, and stream code stays untouched.

## Indicator behavior

- **Authorized vehicle** → LED stays off (silence = OK)
- **Unauthorized vehicle / OCR failure** → onboard flash LED **blinks rapidly** (~3 seconds, 10 blinks)

The default LED pin is **GPIO 4** (the bright white flash LED next to the lens). You can switch to the dim red status LED (GPIO 33) by editing two lines at the top of `sentinel_cam.ino`:

```cpp
#define ALERT_PIN          33      // was 4
#define ALERT_ACTIVE_HIGH  false   // GPIO 33 is active LOW
```

## Sketch folder layout

Your Arduino sketch folder must contain all four files (the last three come from your existing CameraWebServer example):

```
sentinel_cam/
├── sentinel_cam.ino       ← from this project
├── app_httpd.cpp          ← from your existing sketch
├── board_config.h         ← from your existing sketch
└── camera_index.h         ← from your existing sketch
```

## Flashing

1. Open the sketch folder in Arduino IDE.
2. Edit Wi-Fi credentials at the top of `sentinel_cam.ino`:
   ```cpp
   const char *ssid = "YourWiFi";
   const char *password = "YourPassword";
   ```
3. **Tools** menu:
   - Board: **AI Thinker ESP32-CAM**
   - Partition Scheme: **Huge APP (3MB No OTA / 1MB SPIFFS)**
4. Hold GPIO 0 → GND, press RST, click **Upload**. Release GPIO 0 when upload finishes, press RST again.
5. Open Serial Monitor at 115200. You should see:
   ```
   WiFi connected
   IP Address: 192.168.x.y
   Camera Ready! Open: http://192.168.x.y
   Alert endpoint ready: http://192.168.x.y:82/alert
   ```
6. The flash LED double-blinks at boot — confirms the alert pin is wired.

## Verifying the endpoints

| URL | Expected |
|---|---|
| `http://<ip>/` | your camera control panel |
| `http://<ip>/capture` | one JPEG snapshot |
| `http://<ip>:81/stream` | live MJPEG |
| `http://<ip>:82/alert` | flash LED blinks |
| `http://<ip>:82/ok` | clears any active blink |

If `:82/alert` makes the white flash LED blink, hardware is good. ✅

## Backend

```bash
cd vehicle-tracker
npm install
cp .env.example .env
# edit .env with your values
npm start
```

Open **`http://localhost:3000`** (don't double-click `index.html` — it must be served).

## Auto-scan flow

1. Frontend polls `/api/auto-scan` every 3 seconds.
2. Backend pulls a snapshot from `http://<ip>/capture`.
3. OCR runs (Plate Recognizer if token set, otherwise Tesseract).
4. If a plausible 8–10 char plate is detected:
   - Skip if same plate was just scanned (dedup window: 30s).
   - Otherwise: snapshot saved to `uploads/`, FireAPI RTO lookup, MongoDB record created, ESP32 LED toggled.
5. If no plate detected: silent skip, no DB write, no API call.

This means the RTO API and database are only hit when an actual plate is found — efficient on quotas and disk.

## Troubleshooting

| Problem | Fix |
|---|---|
| Page loads with no styling | Use `http://localhost:3000`, not file:// |
| OCR misreads plates | Get a Plate Recognizer free token (2500/month). Tesseract alone often fails on real-world Indian plates. |
| Auto-scan not running | Camera unreachable. Check `ESP32_CAM_IP` in `.env`, test `http://<ip>/capture` directly in browser. |
| Brownout detector triggered | Underpowered. Use 5V/2A supply, not FTDI's 5V. |
| `:82/alert` returns nothing | Sketch didn't compile, or `alertServer.begin()` didn't run. Check Serial Monitor. |
| Flash LED too bright | Switch `ALERT_PIN` to 33 and `ALERT_ACTIVE_HIGH` to false (uses dim red status LED). |
| Mongo connection refused | Start MongoDB or use Atlas (`mongodb+srv://...`). |
| RTO calls fail | Check FireAPI key with the Postman test from your screenshot first. |
