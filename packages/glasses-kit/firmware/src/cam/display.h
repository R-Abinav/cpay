// OLED (SSD1306 128x64 @ 0x3C). Redraws only when the content changes.
#pragma once
#include <Arduino.h>

namespace display {

void begin();
// Up to 4 lines. <= 2 lines of <= 10 chars use a big font, otherwise 6x10.
void show(const char *const *lines, int n);
inline void show1(const char *a) { show(&a, 1); }
inline void show2(const char *a, const char *b) {
  const char *l[] = {a, b};
  show(l, 2);
}
// "PAIR CODE" label + the 6-char code in a large font.
void showPairCode(const char *code);
// Small dot in the top-right corner while the camera is streaming (a recording light).
void setStreaming(bool on);

}  // namespace display
