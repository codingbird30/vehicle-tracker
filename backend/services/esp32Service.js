const axios = require('axios');

const ESP32_CAM_IP = process.env.ESP32_CAM_IP;

// The camera-server endpoints (provided by your existing app_httpd.cpp):
//   http://<ip>/capture       -> one JPEG (port 80)
//   http://<ip>:81/stream     -> MJPEG live stream
//
// The alert endpoints (added by sentinel_cam.ino on a separate server):
//   http://<ip>:82/alert      -> blinks the onboard flash LED (unauthorized)
//   http://<ip>:82/ok         -> clears the alert
//   http://<ip>:82/status     -> JSON state
const ALERT_PORT = 82;

/**
 * Tells the ESP32-CAM to blink the alert LED (unauthorized vehicle).
 * `state` can be 'alert' (start blinking) or 'ok' (clear).
 */
async function setAlert(state) {
  if (!['alert', 'ok'].includes(state)) {
    throw new Error(`Invalid alert state: ${state}`);
  }

  if (!ESP32_CAM_IP) {
    console.warn('[ESP32] ESP32_CAM_IP not set. Skipping alert command.');
    return { ok: false, skipped: true };
  }

  try {
    const url = `http://${ESP32_CAM_IP}:${ALERT_PORT}/${state}`;
    const resp = await axios.get(url, { timeout: 3000 });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    console.error(`[ESP32] alert command failed (${state}):`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Convenience wrapper: turn on alert if unauthorized, clear if authorized. */
async function setIndicator(isAuthorized) {
  return setAlert(isAuthorized ? 'ok' : 'alert');
}

/** Trigger a fresh snapshot from the ESP32-CAM (returns image buffer). */
async function captureSnapshot() {
  if (!ESP32_CAM_IP) throw new Error('ESP32_CAM_IP not set in .env');
  const url = `http://${ESP32_CAM_IP}/capture`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 5000,
  });
  return Buffer.from(resp.data);
}

module.exports = { setAlert, setIndicator, captureSnapshot, ESP32_CAM_IP, ALERT_PORT };
