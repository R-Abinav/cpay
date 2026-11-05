// CPay glasses: production firmware for the ESP32-CAM (GC2145 + SSD1306 OLED). One board, no buttons.
//
//   boot -> NVS unit id/secret (else NOT PROVISIONED + serial console)
//        -> Wi-Fi (WiFiManager captive portal "CPay-Glasses-XXXX" when nothing is saved / saved net fails 30 s)
//        -> wss://HUB_HOST/device: challenge -> auth{mac} (-> register once) -> auth_ok
//        -> pair_code / oled lines on the OLED; stream{on,fps} -> QVGA JPEG binary frames until stream{off}
//
// Wire contract: packages/glasses-kit/hub/src/messages.ts (device side, `t`-keyed JSON + binary JPEG).
// Privacy: no storage, frames are freed right after sending, never queued or retried. Serial logs carry
// metadata only: never the unit secret, the pairing code, OLED text or image data.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiManager.h>

#include "camera.h"
#include "camera_maps.h"
#include "config.h"
#include "display.h"
#include "unit.h"

#if CAM_DISABLE_BROWNOUT
#include "soc/rtc_cntl_reg.h"
#include "soc/soc.h"
#endif

static const size_t FRAME_MAX_BYTES = 64 * 1024;  // = LIMITS.frameMaxBytes

static WiFiManager wm;
static WebSocketsClient ws;

// ---- Wi-Fi state
static bool portalActive = false;
static uint32_t wifiDownSince = 0;
static bool wifiWasUp = false;

// ---- hub state
static bool wsStarted = false;
static bool wsConnected = false;
static bool authed = false;
static bool paired = false;

enum class HubScreen { None, PairCode, Paired, Lines };
static HubScreen hubScreen = HubScreen::None;
static char pairCode[8] = {0};
static char hubLines[4][22] = {};
static int hubLineCount = 0;

// ---- stream state
static bool streaming = false;
static uint32_t frameIntervalMs = 200;
static uint32_t lastFrameAt = 0;
static uint32_t lastStreamOnAt = 0;
static uint32_t winFrames = 0, winBytes = 0, winStart = 0;
static float lastFps = 0;

// ---------------------------------------------------------------- streaming

static void stopStream(const char *why) {
  if (!streaming) return;
  streaming = false;
  display::setStreaming(false);
  Serial.printf("[cam] stream off (%s)\n", why);
}

static void startStream(int fps) {
  if (fps < 1) fps = 1;
  if (fps > 10) fps = 10;
  frameIntervalMs = 1000 / fps;
  lastStreamOnAt = millis();
  if (!camera::ready()) {
    Serial.println("[cam] stream requested but camera not ready");
    return;
  }
  if (!streaming) {
    streaming = true;
    lastFrameAt = 0;
    winFrames = winBytes = 0;
    winStart = millis();
    display::setStreaming(true);
    Serial.printf("[cam] stream on fps=%d\n", fps);
  }
}

static bool sendFrame(uint8_t *jpg, size_t len) {
  if (!streaming || !authed || len > FRAME_MAX_BYTES) return false;  // never queue, never retry
  return ws.sendBIN(jpg, len);
}

static void streamLoop() {
  if (!streaming) return;
  uint32_t now = millis();
  if (!authed) return stopStream("hub down");
  if (now - lastStreamOnAt > STREAM_FAILSAFE_MS) return stopStream("failsafe timeout");
  if (lastFrameAt != 0 && now - lastFrameAt < frameIntervalMs) return;
  lastFrameAt = now;
  size_t n = camera::captureJpeg(sendFrame);
  if (n) {
    winFrames++;
    winBytes += n;
  }
}

// ---------------------------------------------------------------- hub

static void sendJson(JsonDocument &doc) {
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof buf);
  if (n > 0 && n < sizeof buf) ws.sendTXT(buf, n);
}

static void onHubDown() {
  authed = false;
  paired = false;
  hubScreen = HubScreen::None;
  memset(pairCode, 0, sizeof pairCode);
  memset(hubLines, 0, sizeof hubLines);  // last OLED text may hold payment details: drop it
  hubLineCount = 0;
  stopStream("hub down");
}

static void handleHubText(uint8_t *payload, size_t len) {
  if (len > 4096) return;  // = LIMITS.jsonMaxBytes
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("[hub] bad json");
    return;
  }
  const char *t = doc["t"] | "";

  if (strcmp(t, "challenge") == 0) {
    const char *nonce = doc["nonce"] | "";
    char mac[65];
    if (!unit::authMac(nonce, mac)) {
      Serial.println("[hub] bad challenge");
      return;
    }
    JsonDocument out;
    out["t"] = "auth";
    out["unitId"] = unit::id();
    out["fw"] = CPAY_FW_VERSION;
    out["mac"] = mac;
    sendJson(out);
    Serial.println("[hub] auth sent");
  } else if (strcmp(t, "register") == 0) {
    // Unknown unit on the hub: send the secret once (TLS) so it can store sha256(secret).
    JsonDocument out;
    out["t"] = "register";
    out["unitId"] = unit::id();
    out["secret"] = unit::secretHex();
    char buf[200];
    size_t n = serializeJson(out, buf, sizeof buf);
    if (n > 0 && n < sizeof buf) ws.sendTXT(buf, n);
    memset(buf, 0, sizeof buf);
    Serial.println("[hub] register sent");
  } else if (strcmp(t, "auth_ok") == 0) {
    authed = true;
    paired = doc["paired"] | false;
    Serial.printf("[hub] auth ok paired=%d\n", paired);
  } else if (strcmp(t, "pair_code") == 0) {
    const char *code = doc["code"] | "";
    if (strlen(code) == 6) {
      strlcpy(pairCode, code, sizeof pairCode);
      hubScreen = HubScreen::PairCode;
      paired = false;
      Serial.println("[hub] pair code received");
    }
  } else if (strcmp(t, "paired") == 0) {
    paired = true;
    memset(pairCode, 0, sizeof pairCode);
    hubScreen = HubScreen::Paired;
    Serial.println("[hub] paired");
  } else if (strcmp(t, "oled") == 0) {
    JsonArray lines = doc["lines"].as<JsonArray>();
    int n = 0;
    for (JsonVariant v : lines) {
      if (n >= 4) break;
      strlcpy(hubLines[n], v.as<const char *>() ? v.as<const char *>() : "", sizeof hubLines[n]);
      n++;
    }
    if (n > 0) {
      hubLineCount = n;
      hubScreen = HubScreen::Lines;
    }
    Serial.printf("[hub] oled lines=%d\n", n);
  } else if (strcmp(t, "stream") == 0) {
    bool on = doc["on"] | false;
    int fps = doc["fps"] | 5;
    if (on) startStream(fps);
    else stopStream("hub");
  } else {
    Serial.printf("[hub] ignored t=%.16s\n", t);
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("[hub] connected, awaiting challenge");
      break;
    case WStype_DISCONNECTED:
      if (wsConnected) Serial.println("[hub] disconnected");
      wsConnected = false;
      onHubDown();
      break;
    case WStype_TEXT:
      handleHubText(payload, len);
      break;
    case WStype_ERROR:
      Serial.println("[hub] ws error");
      break;
    default:
      break;
  }
}

static void hubStart() {
#if HUB_TLS
  // TODO(post-hackathon): pin the hub's CA (beginSslWithCA) instead of skipping certificate checks.
  ws.beginSSL(HUB_HOST, HUB_PORT, HUB_PATH);
  Serial.printf("[hub] dialing wss://%s:%d%s\n", HUB_HOST, HUB_PORT, HUB_PATH);
#else
  ws.begin(HUB_HOST, HUB_PORT, HUB_PATH);
  Serial.printf("[hub] dialing ws://%s:%d%s\n", HUB_HOST, HUB_PORT, HUB_PATH);
#endif
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(HUB_RECONNECT_MS);
  ws.enableHeartbeat(15000, 5000, 2);
  wsStarted = true;
}

static void hubStop() {
  if (!wsStarted) return;
  ws.disconnect();
  wsStarted = false;
  wsConnected = false;
  onHubDown();
}

static void statusLoop() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < STATUS_EVERY_MS) return;
  last = now;
  uint32_t el = now - winStart;
  lastFps = (streaming && el > 0) ? winFrames * 1000.0f / el : 0;
  if (streaming) {
    Serial.printf("[cam] fps=%.1f avg=%uB heap=%u\n", lastFps, winFrames ? (unsigned)(winBytes / winFrames) : 0,
                  (unsigned)ESP.getFreeHeap());
  }
  winFrames = winBytes = 0;
  winStart = now;
  if (!authed) return;
  JsonDocument doc;
  doc["t"] = "status";
  doc["rssi"] = WiFi.RSSI();
  doc["heap"] = ESP.getFreeHeap();
  doc["fps"] = roundf(lastFps * 10) / 10;
  sendJson(doc);
}

// ---------------------------------------------------------------- Wi-Fi

static void portalOpen() {
  Serial.printf("[wifi] portal open: %s\n", unit::apName());
  hubStop();
  portalActive = true;
  wm.startConfigPortal(unit::apName());  // non-blocking, open AP
}

static void wifiSetup() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // steadier frame latency
  WiFi.setAutoReconnect(true);
  wm.setDebugOutput(false);  // WiFiManager debug can print network names/passwords
  wm.setConfigPortalBlocking(false);
  wm.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_S);
  wm.setConnectTimeout(20);
  wm.setTitle("CPay Glasses");
  // Wi-Fi setup only: no info page, no firmware-update (OTA) page on an open AP.
  std::vector<const char *> menu = {"wifi", "exit"};
  wm.setMenu(menu);
  wm.setShowInfoUpdate(false);
  wm.setShowInfoErase(false);
  if (wm.getWiFiIsSaved()) {
    Serial.println("[wifi] connecting to saved network");
    WiFi.begin();
    wifiDownSince = millis();
  } else {
    portalOpen();
  }
}

static void wifiLoop() {
  bool up = WiFi.status() == WL_CONNECTED;
  uint32_t now = millis();
  if (portalActive) {
    wm.process();
    if (up) {
      if (wm.getConfigPortalActive()) wm.stopConfigPortal();
      portalActive = false;
      Serial.println("[wifi] portal closed (connected)");
    } else if (!wm.getConfigPortalActive()) {
      portalActive = false;
      Serial.println("[wifi] portal timed out, retrying saved network");
      WiFi.mode(WIFI_STA);
      WiFi.begin();
      wifiDownSince = now;
    }
  } else if (up) {
    wifiDownSince = 0;
  } else {
    if (wifiDownSince == 0) wifiDownSince = now;
    if (now - wifiDownSince > WIFI_FAIL_PORTAL_MS) portalOpen();
  }

  if (up != wifiWasUp) {
    wifiWasUp = up;
    if (up) Serial.printf("[wifi] connected rssi=%d ip=%s\n", WiFi.RSSI(), WiFi.localIP().toString().c_str());
    else Serial.println("[wifi] down");
  }

  // the hub link runs only on a working station connection, never while the portal is up
  if (up && !portalActive && !wsStarted) hubStart();
  if ((!up || portalActive) && wsStarted) hubStop();
}

static void wifiReset() {
  wm.resetSettings();
}

// ---------------------------------------------------------------- OLED

static void screenLoop() {
  if (portalActive) return display::show2("WIFI SETUP", unit::apName());
  if (WiFi.status() != WL_CONNECTED) return display::show1("NO WIFI");
  if (!authed) return display::show1("NO HUB");
  switch (hubScreen) {
    case HubScreen::PairCode:
      return display::showPairCode(pairCode);
    case HubScreen::Lines: {
      const char *l[4] = {hubLines[0], hubLines[1], hubLines[2], hubLines[3]};
      return display::show(l, hubLineCount);
    }
    case HubScreen::Paired:
      return display::show2("PAIRED", "OPEN CPAY APP");
    case HubScreen::None:
    default:
      return paired ? display::show2("PAIRED", "OPEN CPAY APP") : display::show1("CONNECTED");
  }
}

// ---------------------------------------------------------------- main

void setup() {
#if CAM_DISABLE_BROWNOUT
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
#endif
  Serial.begin(115200);
  const CamPinMap &map = CAM_MAPS[CAM_MAP_INDEX];
  if (map.flashLed >= 0) {  // the bright flash LED (IO4) stays off
    pinMode(map.flashLed, OUTPUT);
    digitalWrite(map.flashLed, LOW);
  }
  display::begin();
  display::show1("BOOTING");
  Serial.printf("\n[boot] CPay glasses fw %s\n", CPAY_FW_VERSION);

  if (!unit::load()) {
    Serial.println("[boot] NOT PROVISIONED: send PROVISION <unitId> <secretHex64> (scripts/provision.py)");
    display::show2("NOT", "PROVISIONED");
    return;  // loop() only runs the serial console
  }
  Serial.printf("[boot] unit %s\n", unit::id());

  if (!camera::begin()) {
    display::show2("CAMERA", "ERROR");
    delay(2000);  // let it be read; keep going so the phone still sees the unit online
  }
  wifiSetup();
}

void loop() {
  unit::pollSerial(wifiReset);
  if (!unit::provisioned()) {
    delay(10);
    return;
  }
  wifiLoop();
  if (wsStarted) ws.loop();
  streamLoop();
  statusLoop();
  screenLoop();
  delay(1);
}
