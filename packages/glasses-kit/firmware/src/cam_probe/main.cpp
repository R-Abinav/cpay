// DIAGNOSTIC: tries every known camera pin map (AI-Thinker first) and reports which one
// initialises and returns a JPEG frame. Flash with `pio run -e cam-probe -t upload`, then open
// the serial monitor. Put the winning index in platformio.ini as -DCAM_MAP_INDEX=<n>.
// No Wi-Fi, no storage.

#include <Arduino.h>

#include "camera_maps.h"
#include "img_converters.h"

static int probeAll(bool hasPsram) {
  int firstOk = -1;
  for (int i = 0; i < CAM_MAP_COUNT; i++) {
    const CamPinMap &m = CAM_MAPS[i];
    Serial.printf("[%d] %-22s ", i, m.name);
    if (camMapUnsafe(m, hasPsram)) {
      Serial.println("SKIP (uses flash/PSRAM pins on this board)");
      continue;
    }
    camera_config_t c = camConfigFor(m);
    c.frame_size = FRAMESIZE_QVGA;
    c.jpeg_quality = 12;
    c.fb_count = 1;
    c.fb_location = hasPsram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
    c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    esp_err_t err = esp_camera_init(&c);
    if (err == ESP_ERR_NOT_SUPPORTED) {
      // Sensor answered but can't do JPEG (non-OV2640 clone sensor). Retry raw and report it.
      Serial.printf("no JPEG; retrying RGB565... ");
      c.pixel_format = PIXFORMAT_RGB565;
      err = esp_camera_init(&c);
      if (err == ESP_OK) {
        sensor_t *rs = esp_camera_sensor_get();
        camera_fb_t *rfb = esp_camera_fb_get();
        Serial.printf("sensor PID 0x%02x VER 0x%02x MIDH 0x%02x MIDL 0x%02x, ",
                      rs ? rs->id.PID : 0, rs ? rs->id.VER : 0, rs ? rs->id.MIDH : 0, rs ? rs->id.MIDL : 0);
        if (rfb) {
          uint8_t *jpg = nullptr; size_t jlen = 0;
          uint32_t t0 = millis();
          bool ok = frame2jpg(rfb, 12, &jpg, &jlen);
          Serial.printf("raw frame %ux%u %u bytes; software JPEG %s (%u bytes, %lu ms)\n",
                        (unsigned)rfb->width, (unsigned)rfb->height, (unsigned)rfb->len,
                        ok ? "OK" : "FAILED", (unsigned)jlen, (unsigned long)(millis() - t0));
          if (jpg) free(jpg);
          esp_camera_fb_return(rfb);
          if (ok && firstOk < 0) firstOk = i;
        } else {
          Serial.println("init ok but NO FRAME");
        }
        esp_camera_deinit();
        delay(100);
        continue;
      }
    }
    if (err != ESP_OK) {
      Serial.printf("fail (0x%x)\n", err);
      delay(50);
      continue;
    }
    sensor_t *s = esp_camera_sensor_get();
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      bool jpeg = fb->len > 2 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8;
      Serial.printf("OK  sensor PID 0x%02x, frame %ux%u %u bytes%s\n", s ? s->id.PID : 0,
                    (unsigned)fb->width, (unsigned)fb->height, (unsigned)fb->len,
                    jpeg ? "" : " (not JPEG?)");
      esp_camera_fb_return(fb);
      if (firstOk < 0) firstOk = i;
    } else {
      Serial.printf("init ok (PID 0x%02x) but NO FRAME: check ribbon cable / XCLK\n", s ? s->id.PID : 0);
    }
    esp_camera_deinit();
    delay(100);
  }
  return firstOk;
}

void setup() {
  Serial.begin(115200);
  delay(1500);
}

void loop() {
  bool hasPsram = psramFound();
  Serial.printf("\n=== CPay cam-probe === chip %s rev %d, PSRAM %s (%u bytes)\n", ESP.getChipModel(),
                ESP.getChipRevision(), hasPsram ? "yes" : "NO", (unsigned)ESP.getPsramSize());
  Serial.println("(OV2640 PID = 0x26, OV3660 = 0x36, OV5640 = 0x56)");
  int ok = probeAll(hasPsram);
  if (ok >= 0) {
    Serial.printf("\nRESULT: use -DCAM_MAP_INDEX=%d  (%s)\n", ok, CAM_MAPS[ok].name);
  } else {
    Serial.println("\nRESULT: no map worked. Check: ribbon cable latched and the right way round,"
                   " 5V supply >= 1 A, camera module seated.");
  }
  Serial.println("Repeating in 15 s...");
  delay(15000);
}
