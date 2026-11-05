// CPay glasses: ESP32-CAM (OV2640), camera node only.
//
// Bridge -> {"t":"capture","id":N}
// CAM    -> binary frame: [4-byte big-endian id][JPEG bytes]   (VGA 640x480, full sensor FOV, centred)
//        or {"t":"capture_error","id":N,"reason":"..."}
// No storage: the frame buffer is returned to the driver right after sending. No retries.

#include <Arduino.h>
#include <ArduinoJson.h>

#include "camera_maps.h"
#include "net_common.h"

#if CAM_DISABLE_BROWNOUT
#include "soc/rtc_cntl_reg.h"
#include "soc/soc.h"
#endif

#ifndef CAM_JPEG_QUALITY
#define CAM_JPEG_QUALITY 12  // 0-63, lower = better/larger. 12 gives ~25-60 KB at VGA.
#endif

WebSocketsClient ws;
cpaynet::BridgeLink bridgeLink(ws, "cam", "cpay-cam");

static const CamPinMap &MAP = CAM_MAPS[CAM_MAP_INDEX];
static bool camReady = false;
static bool hasPsram = false;
static int32_t pendingId = -1;  // capture requested, handled in loop()

static bool cameraInit() {
  camera_config_t c = camConfigFor(MAP);
  c.frame_size = FRAMESIZE_VGA;
  c.jpeg_quality = CAM_JPEG_QUALITY;
  if (hasPsram) {
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.fb_count = 2;
    c.grab_mode = CAMERA_GRAB_LATEST;  // always hand out the newest frame
  } else {
    c.fb_location = CAMERA_FB_IN_DRAM;
    c.fb_count = 1;
    c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[cam] init FAILED with map %s: 0x%x (run the cam-probe env)\n", MAP.name, err);
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
#ifdef CAM_VFLIP
  s->set_vflip(s, 1);
#endif
#ifdef CAM_HMIRROR
  s->set_hmirror(s, 1);
#endif
  Serial.printf("[cam] ready: map %s, sensor PID 0x%02x, psram %s\n", MAP.name, s->id.PID,
                hasPsram ? "yes" : "no");
  return true;
}

static void sendError(int32_t id, const char *reason) {
  char msg[96];
  snprintf(msg, sizeof msg, "{\"t\":\"capture_error\",\"id\":%ld,\"reason\":\"%s\"}", (long)id, reason);
  ws.sendTXT(msg);
  Serial.printf("[cam] capture %ld error: %s\n", (long)id, reason);
}

static void doCapture(int32_t id) {
  if (!camReady) camReady = cameraInit();  // one more try
  if (!camReady) {
    sendError(id, "camera_init_failed");
    return;
  }
  if (!hasPsram) {
    // single buffer in GRAB_WHEN_EMPTY mode holds a stale frame: drop it first
    camera_fb_t *old = esp_camera_fb_get();
    if (old) esp_camera_fb_return(old);
  }
  uint32_t t0 = millis();
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    sendError(id, "fb_get_failed");
    return;
  }
  if (fb->format != PIXFORMAT_JPEG || fb->len < 4) {
    esp_camera_fb_return(fb);
    sendError(id, "not_jpeg");
    return;
  }
  size_t total = fb->len + 4;
  uint8_t *out = (uint8_t *)(hasPsram ? ps_malloc(total) : malloc(total));
  if (!out) {
    esp_camera_fb_return(fb);
    sendError(id, "oom");
    return;
  }
  out[0] = (id >> 24) & 0xff;
  out[1] = (id >> 16) & 0xff;
  out[2] = (id >> 8) & 0xff;
  out[3] = id & 0xff;
  memcpy(out + 4, fb->buf, fb->len);
  size_t w = fb->width, h = fb->height, len = fb->len;
  esp_camera_fb_return(fb);
  bool ok = ws.sendBIN(out, total);
  free(out);
  Serial.printf("[cam] capture %ld: %ux%u %u bytes in %lu ms, sent=%d\n", (long)id, (unsigned)w,
                (unsigned)h, (unsigned)len, (unsigned long)(millis() - t0), ok);
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED: {
      Serial.println("[bridge] connected");
      bridgeLink.setConnected(true);
      char hello[160];
      snprintf(hello, sizeof hello,
               "{\"t\":\"hello\",\"role\":\"cam\",\"fw\":\"%s\",\"map\":\"%s\",\"camera\":%s,\"psram\":%s}",
               CPAY_FW_VERSION, MAP.name, camReady ? "true" : "false", hasPsram ? "true" : "false");
      ws.sendTXT(hello);
      break;
    }
    case WStype_DISCONNECTED:
      if (bridgeLink.connected()) Serial.println("[bridge] disconnected");
      bridgeLink.setConnected(false);
      pendingId = -1;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, len)) return;
      const char *t = doc["t"] | "";
      if (strcmp(t, "capture") == 0) pendingId = doc["id"] | 0;
      break;
    }
    default:
      break;
  }
}

void setup() {
#if CAM_DISABLE_BROWNOUT
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
#endif
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nCPay CAM fw %s, pin map #%d %s (UNCONFIRMED)\n", CPAY_FW_VERSION, CAM_MAP_INDEX,
                MAP.name);
  if (MAP.flashLed >= 0) {  // make sure the bright flash LED stays off
    pinMode(MAP.flashLed, OUTPUT);
    digitalWrite(MAP.flashLed, LOW);
  }
  hasPsram = psramFound();
  camReady = cameraInit();
  cpaynet::wifiStart("cpay-cam");
  ws.onEvent(onWsEvent);
}

void loop() {
  static bool lastWifi = false;
  cpaynet::wifiMaintain();
  bool wifi = WiFi.status() == WL_CONNECTED;
  if (wifi != lastWifi) {
    lastWifi = wifi;
    if (wifi) {
      Serial.printf("[wifi] connected, ip %s, rssi %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
      Serial.println("[wifi] down");
      bridgeLink.setConnected(false);
    }
  }
  bridgeLink.loop();
  if (pendingId >= 0 && bridgeLink.connected()) {
    int32_t id = pendingId;
    pendingId = -1;
    doCapture(id);
  }
  delay(2);
}
