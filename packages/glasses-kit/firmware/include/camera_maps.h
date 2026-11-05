// Known ESP32 camera pin maps, copied from the Arduino-ESP32 CameraWebServer example
// (libraries/ESP32/examples/Camera/CameraWebServer/camera_pins.h, core 2.0.17).
// Index 0 (AI-Thinker) is what almost every "ESP32-CAM" board, clones included, uses.
// `cam-probe` tries them in order; `cam` uses CAM_MAP_INDEX. UNCONFIRMED until cam-probe passes.
#pragma once
#include <stdint.h>

struct CamPinMap {
  const char *name;
  int8_t pwdn, reset, xclk, siod, sioc;
  int8_t y9, y8, y7, y6, y5, y4, y3, y2;
  int8_t vsync, href, pclk;
  int8_t flashLed;  // -1 if none
};

//                          name                pwdn rst xclk siod sioc  y9  y8  y7  y6  y5  y4  y3  y2 vsyn href pclk led
static const CamPinMap CAM_MAPS[] = {
    {"AI_THINKER",            32, -1,   0,  26,  27,  35, 34, 39, 36, 21, 19, 18,  5,  25,  23,  22,  4},
    {"M5STACK_PSRAM",         -1, 15,  27,  25,  23,  19, 36, 18, 39,  5, 34, 35, 32,  22,  26,  21, -1},
    {"M5STACK_V2_PSRAM/WIDE", -1, 15,  27,  22,  23,  19, 36, 18, 39,  5, 34, 35, 32,  25,  26,  21, -1},
    {"M5STACK_ESP32CAM",      -1, 15,  27,  25,  23,  19, 36, 18, 39,  5, 34, 35, 17,  22,  26,  21, -1},
    {"TTGO_T_JOURNAL",         0, 15,  27,  25,  23,  19, 36, 18, 39,  5, 34, 35, 17,  22,  26,  21, -1},
    {"WROVER_KIT",            -1, -1,  21,  26,  27,  35, 34, 39, 36, 19, 18,  5,  4,  25,  23,  22, -1},
    {"ESP_EYE",               -1, -1,   4,  18,  23,  36, 37, 38, 39, 35, 14, 13, 34,   5,  27,  25, -1},
};
static const int CAM_MAP_COUNT = sizeof(CAM_MAPS) / sizeof(CAM_MAPS[0]);

#ifndef CAM_MAP_INDEX
#define CAM_MAP_INDEX 0
#endif

// True if the map drives a pin that this board needs for flash (6-11) or, with PSRAM, for
// PSRAM (16, 17). Driving those would crash the chip instead of failing cleanly.
static inline bool camMapUnsafe(const CamPinMap &m, bool hasPsram) {
  const int8_t pins[] = {m.pwdn, m.reset, m.xclk, m.siod, m.sioc, m.y9, m.y8, m.y7, m.y6,
                         m.y5,   m.y4,    m.y3,   m.y2,   m.vsync, m.href, m.pclk};
  for (int8_t p : pins) {
    if (p >= 6 && p <= 11) return true;
    if (hasPsram && (p == 16 || p == 17)) return true;
  }
  return false;
}

#include "esp_camera.h"

static inline camera_config_t camConfigFor(const CamPinMap &m) {
  camera_config_t c = {};
  c.pin_pwdn = m.pwdn;
  c.pin_reset = m.reset;
  c.pin_xclk = m.xclk;
  c.pin_sccb_sda = m.siod;
  c.pin_sccb_scl = m.sioc;
  c.pin_d7 = m.y9;
  c.pin_d6 = m.y8;
  c.pin_d5 = m.y7;
  c.pin_d4 = m.y6;
  c.pin_d3 = m.y5;
  c.pin_d2 = m.y4;
  c.pin_d1 = m.y3;
  c.pin_d0 = m.y2;
  c.pin_vsync = m.vsync;
  c.pin_href = m.href;
  c.pin_pclk = m.pclk;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  return c;
}
