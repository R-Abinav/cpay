#include "camera.h"

#include "camera_maps.h"
#include "config.h"
#include "img_converters.h"

namespace camera {

static const CamPinMap &MAP = CAM_MAPS[CAM_MAP_INDEX];
static bool ok = false;

bool begin() {
  bool psram = psramFound();
  camera_config_t c = camConfigFor(MAP);
  c.pixel_format = PIXFORMAT_RGB565;  // GC2145 has no hardware JPEG
  c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = 12;  // unused for RGB565
  if (psram) {
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.fb_count = 2;
    c.grab_mode = CAMERA_GRAB_LATEST;  // always the newest frame, never a backlog
  } else {
    c.fb_location = CAMERA_FB_IN_DRAM;
    c.fb_count = 1;
    c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[cam] init failed 0x%x (map %s, psram %d)\n", err, MAP.name, psram);
    ok = false;
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
#ifdef CAM_VFLIP
  if (s && s->set_vflip) s->set_vflip(s, 1);
#endif
#ifdef CAM_HMIRROR
  if (s && s->set_hmirror) s->set_hmirror(s, 1);
#endif
  Serial.printf("[cam] ready map=%s pid=0x%x psram=%d q=%d\n", MAP.name, s ? s->id.PID : 0, psram,
                CAM_JPEG_QUALITY);
  ok = true;
  return true;
}

bool ready() { return ok; }

size_t captureJpeg(bool (*send)(uint8_t *jpg, size_t len)) {
  if (!ok) return 0;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[cam] no frame");
    return 0;
  }
  uint8_t *jpg = nullptr;
  size_t len = 0;
  bool enc = frame2jpg(fb, CAM_JPEG_QUALITY, &jpg, &len);
  esp_camera_fb_return(fb);  // release the raw frame before the (slow) network send
  if (!enc || !jpg || len < 4 || jpg[0] != 0xFF || jpg[1] != 0xD8) {
    if (jpg) free(jpg);
    Serial.println("[cam] jpeg encode failed");
    return 0;
  }
  bool sent = send(jpg, len);
  free(jpg);
  return sent ? len : 0;
}

}  // namespace camera
