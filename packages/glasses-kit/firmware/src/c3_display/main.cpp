// CPay glasses: ESP32-C3 SuperMini with the OLED and the 3 buttons.
//
// - Buttons (debounced) -> {"t":"btn","e":"capture_down|capture_up|confirm|cancel"} to the bridge.
// - Bridge -> {"t":"oled","lines":["..",".."]} -> shown on the OLED (big font for short states).
// - Local states: NO WIFI / NO BRIDGE. Auto-reconnects. Holds no keys, stores nothing.
// - Events pressed while offline are dropped (no retries, by design).

#include <Arduino.h>
#include <ArduinoJson.h>
#include <U8g2lib.h>
#include <Wire.h>

#include "net_common.h"
#include "pins_c3.h"

#ifdef OLED_SH1106
U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
#else
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
#endif

WebSocketsClient ws;
cpaynet::BridgeLink bridgeLink(ws, "c3", "cpay-c3");

// ------------------------------------------------------------------ display state
static const int MAX_LINES = 6;
static const int MAX_CHARS = 21;
static char lines[MAX_LINES][MAX_CHARS + 1];
static int lineCount = 0;
static bool dirty = true;
static bool captureHeld = false;

static void setLines(const char *const *src, int n) {
  lineCount = n > MAX_LINES ? MAX_LINES : n;
  for (int i = 0; i < lineCount; i++) {
    strncpy(lines[i], src[i], MAX_CHARS);
    lines[i][MAX_CHARS] = '\0';
  }
  dirty = true;
}

static void drawCentered(const char *const *ls, int n) {
  // Big font (10x20, 12 chars/line, up to 3 lines) when everything fits; else 6x10 (21 chars, 6 lines).
  bool big = n <= 3;
  for (int i = 0; i < n && big; i++)
    if (strlen(ls[i]) > 12) big = false;
  if (big) {
    oled.setFont(u8g2_font_10x20_tf);
  } else {
    oled.setFont(u8g2_font_6x10_tf);
  }
  int lh = big ? 21 : 10;
  int asc = big ? 15 : 8;
  int top = (64 - n * lh) / 2;
  for (int i = 0; i < n; i++) {
    int w = oled.getStrWidth(ls[i]);
    int x = (128 - w) / 2;
    if (x < 0) x = 0;
    oled.drawStr(x, top + i * lh + asc, ls[i]);
  }
}

static void render() {
  oled.clearBuffer();
  const char *buf[MAX_LINES];
  if (WiFi.status() != WL_CONNECTED) {
    const char *l[] = {"NO WIFI", WIFI_SSID};
    drawCentered(l, 2);
  } else if (!bridgeLink.connected()) {
    const char *l[] = {"NO BRIDGE", BRIDGE_HOST};
    drawCentered(l, 2);
  } else {
    for (int i = 0; i < lineCount; i++) buf[i] = lines[i];
    drawCentered(buf, lineCount);
  }
  if (captureHeld) oled.drawDisc(123, 4, 3);  // small "mic open" dot while CAPTURE is held
  oled.sendBuffer();
}

// ------------------------------------------------------------------ buttons
struct Button {
  uint8_t pin;
  const char *downEvent;  // sent on press
  const char *upEvent;    // sent on release (nullptr = none)
  bool stable;            // true = pressed
  bool lastRead;
  uint32_t changedAt;
};

static Button buttons[] = {
    {PIN_BTN_CAPTURE, "capture_down", "capture_up", false, false, 0},
    {PIN_BTN_CONFIRM, "confirm", nullptr, false, false, 0},
    {PIN_BTN_CANCEL, "cancel", nullptr, false, false, 0},
};
static const uint32_t DEBOUNCE_MS = 25;

static void sendEvent(const char *e) {
  if (!bridgeLink.connected()) {
    Serial.printf("[btn] %s dropped (bridge offline)\n", e);
    return;
  }
  char msg[64];
  snprintf(msg, sizeof msg, "{\"t\":\"btn\",\"e\":\"%s\"}", e);
  ws.sendTXT(msg);
  Serial.printf("[btn] %s\n", e);
}

static void pollButtons() {
  uint32_t now = millis();
  for (auto &b : buttons) {
    bool pressed = digitalRead(b.pin) == LOW;
    if (pressed != b.lastRead) {
      b.lastRead = pressed;
      b.changedAt = now;
    }
    if (pressed != b.stable && now - b.changedAt >= DEBOUNCE_MS) {
      b.stable = pressed;
      if (b.pin == PIN_BTN_CAPTURE) {
        captureHeld = pressed;
        dirty = true;
      }
      if (pressed) {
        sendEvent(b.downEvent);
      } else if (b.upEvent) {
        sendEvent(b.upEvent);
      }
    }
  }
}

// ------------------------------------------------------------------ bridge messages
static void onMessage(uint8_t *payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("[bridge] bad json");
    return;
  }
  const char *t = doc["t"] | "";
  if (strcmp(t, "oled") == 0) {
    JsonArray arr = doc["lines"].as<JsonArray>();
    const char *src[MAX_LINES];
    int n = 0;
    for (JsonVariant v : arr) {
      if (n >= MAX_LINES) break;
      src[n++] = v.as<const char *>() ? v.as<const char *>() : "";
    }
    setLines(src, n);
    Serial.printf("[oled] %d line(s): %s\n", n, n ? src[0] : "");
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED: {
      Serial.println("[bridge] connected");
      bridgeLink.setConnected(true);
      char hello[96];
      snprintf(hello, sizeof hello, "{\"t\":\"hello\",\"role\":\"c3\",\"fw\":\"%s\"}", CPAY_FW_VERSION);
      ws.sendTXT(hello);
      dirty = true;
      break;
    }
    case WStype_DISCONNECTED:
      if (bridgeLink.connected()) Serial.println("[bridge] disconnected");
      bridgeLink.setConnected(false);
      dirty = true;
      break;
    case WStype_TEXT:
      onMessage(payload, len);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ main
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nCPay C3 display fw %s\n", CPAY_FW_VERSION);
  Serial.printf("OLED SDA=%d SCL=%d addr=0x%02X | BTN capture=%d confirm=%d cancel=%d (UNCONFIRMED pins)\n",
                PIN_OLED_SDA, PIN_OLED_SCL, OLED_I2C_ADDR, PIN_BTN_CAPTURE, PIN_BTN_CONFIRM,
                PIN_BTN_CANCEL);

  for (auto &b : buttons) pinMode(b.pin, INPUT_PULLUP);

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  oled.setI2CAddress(OLED_I2C_ADDR * 2);
  oled.setBusClock(400000);
  oled.begin();
  const char *boot[] = {"CPAY", "BOOTING"};
  setLines(boot, 2);
  render();

  cpaynet::wifiStart("cpay-c3");
#if C3_WIFI_LOW_TX_POWER
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
#endif
  ws.onEvent(onWsEvent);

  const char *waiting[] = {"NO APP"};  // replaced by the bridge as soon as it connects
  setLines(waiting, 1);
}

void loop() {
  static bool lastWifi = false;
  static uint32_t lastRender = 0;

  cpaynet::wifiMaintain();
  bool wifi = WiFi.status() == WL_CONNECTED;
  if (wifi != lastWifi) {
    lastWifi = wifi;
    dirty = true;
    if (wifi) {
      Serial.printf("[wifi] connected, ip %s\n", WiFi.localIP().toString().c_str());
    } else {
      Serial.println("[wifi] down");
      bridgeLink.setConnected(false);
    }
  }
  bridgeLink.loop();
  pollButtons();

  uint32_t now = millis();
  // render on change, and at most every 40 ms
  if (dirty && now - lastRender >= 40) {
    dirty = false;
    lastRender = now;
    render();
  }
  delay(2);
}
