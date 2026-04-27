#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

// ===========================
// Select camera model
// ===========================
#include "board_config.h"

// ===========================
// WiFi credentials
// ===========================
const char *ssid = "ESP32";
const char *password = "12345678";

// ===========================
// SENTINEL alert config
// ===========================
// AI-Thinker ESP32-CAM has TWO onboard LEDs you can use without any wiring:
//   GPIO 4  -> bright WHITE FLASH LED (the big one next to the lens)
//   GPIO 33 -> small RED status LED on the back of the board (active LOW!)
//
// We use GPIO 4 (flash LED) as the "unauthorized alert" because it's
// highly visible. It will BLINK rapidly when an unauthorized vehicle
// is detected, then auto-turn-off after a few seconds.
//
// If you wire an external red LED later, just change ALERT_PIN below.
#define ALERT_PIN          4      // GPIO 4 = onboard flash LED
#define ALERT_ACTIVE_HIGH  true   // GPIO 4 is active HIGH; if you switch to GPIO 33 set this to false

// Alert behavior
#define ALERT_BLINK_COUNT     10     // number of blinks per alert
#define ALERT_BLINK_INTERVAL  150    // ms between toggles (lower = faster blink)

WebServer alertServer(82);   // separate tiny server on port 82 for /alert and /ok
volatile bool alertRequested = false;
volatile uint32_t alertBlinksRemaining = 0;
volatile uint32_t lastBlinkMs = 0;
volatile bool alertLedState = false;

void startCameraServer();
void setupLedFlash();

// ===========================
// LED helpers
// ===========================
void writeAlertLed(bool on) {
  if (ALERT_ACTIVE_HIGH) {
    digitalWrite(ALERT_PIN, on ? HIGH : LOW);
  } else {
    digitalWrite(ALERT_PIN, on ? LOW : HIGH);
  }
  alertLedState = on;
}

void triggerAlert() {
  alertRequested = true;
  alertBlinksRemaining = ALERT_BLINK_COUNT * 2;  // 2 toggles per blink (on+off)
  lastBlinkMs = millis();
  Serial.println("[ALERT] unauthorized vehicle - blinking");
}

void clearAlert() {
  alertRequested = false;
  alertBlinksRemaining = 0;
  writeAlertLed(false);
  Serial.println("[ALERT] cleared");
}

// ===========================
// Alert HTTP handlers
// ===========================
void handleAlert() {
  triggerAlert();
  alertServer.sendHeader("Access-Control-Allow-Origin", "*");
  alertServer.send(200, "application/json", "{\"ok\":true,\"state\":\"alerting\"}");
}

void handleOk() {
  clearAlert();
  alertServer.sendHeader("Access-Control-Allow-Origin", "*");
  alertServer.send(200, "application/json", "{\"ok\":true,\"state\":\"clear\"}");
}

void handleStatus() {
  alertServer.sendHeader("Access-Control-Allow-Origin", "*");
  String json = "{\"alerting\":";
  json += (alertRequested ? "true" : "false");
  json += ",\"blinks_left\":";
  json += alertBlinksRemaining;
  json += "}";
  alertServer.send(200, "application/json", json);
}

void handleAlertRoot() {
  alertServer.sendHeader("Access-Control-Allow-Origin", "*");
  alertServer.send(200, "text/html",
    "<html><body style='font-family:monospace;background:#111;color:#0f0;padding:20px;'>"
    "<h2>SENTINEL Alert Endpoint</h2>"
    "<p><a style='color:#0f0' href='/alert'>/alert</a> - trigger unauthorized blink</p>"
    "<p><a style='color:#0f0' href='/ok'>/ok</a> - clear alert</p>"
    "<p><a style='color:#0f0' href='/status'>/status</a> - current state</p>"
    "</body></html>");
}

// ===========================
// Setup
// ===========================
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  // Alert LED pin
  pinMode(ALERT_PIN, OUTPUT);
  writeAlertLed(false);

  // ===========================
  // WiFi SCAN
  // ===========================
  Serial.println("Scanning WiFi...");
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.println("Available WiFi:");
    for (int i = 0; i < n; i++) {
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.println(WiFi.SSID(i));
    }
  }

  // ===========================
  // Camera Configuration
  // ===========================
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_UXGA;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 10;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  } else {
    config.frame_size = FRAMESIZE_240X240;
  }

  // ===========================
  // Camera Init
  // ===========================
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_QVGA);
  }

#if defined(LED_GPIO_NUM)
  setupLedFlash();
#endif

  // ===========================
  // WiFi Connection
  // ===========================
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);
  Serial.print("WiFi connecting");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    Serial.print(" Heap: ");
    Serial.println(ESP.getFreeHeap());
    attempts++;
    if (attempts > 20) {
      Serial.println("\nFailed to connect WiFi");
      Serial.println("Check hotspot settings (2.4GHz, WPA2)");
      break;
    }
  }

  // ===========================
  // If Connected
  // ===========================
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("");
    Serial.println("WiFi connected");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());

    startCameraServer();
    Serial.print("Camera Ready! Open: http://");
    Serial.println(WiFi.localIP());

    // Start alert server on port 82
    alertServer.on("/",       handleAlertRoot);
    alertServer.on("/alert",  handleAlert);
    alertServer.on("/ok",     handleOk);
    alertServer.on("/status", handleStatus);
    alertServer.begin();
    Serial.print("Alert endpoint ready: http://");
    Serial.print(WiFi.localIP());
    Serial.println(":82/alert");

    // Boot confirmation: quick double-blink so you know the alert LED works
    writeAlertLed(true);  delay(120);
    writeAlertLed(false); delay(120);
    writeAlertLed(true);  delay(120);
    writeAlertLed(false);
  }
}

// ===========================
// Loop - non-blocking blink + serve HTTP
// ===========================
void loop() {
  // Service the alert HTTP server
  alertServer.handleClient();

  // Non-blocking blink for active alert
  if (alertRequested && alertBlinksRemaining > 0) {
    uint32_t now = millis();
    if (now - lastBlinkMs >= ALERT_BLINK_INTERVAL) {
      writeAlertLed(!alertLedState);
      lastBlinkMs = now;
      alertBlinksRemaining--;
      if (alertBlinksRemaining == 0) {
        // finished blinking - leave LED off, but mark alert state cleared
        writeAlertLed(false);
        alertRequested = false;
      }
    }
  }

  delay(2);  // be friendly to other tasks
}
