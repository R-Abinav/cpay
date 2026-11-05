#include "display.h"

#include <U8g2lib.h>
#include <Wire.h>

#include "config.h"

namespace display {

#if OLED_SW_I2C
// Fallback: bit-banged I2C, never touches the hardware I2C controllers.
static U8G2_SSD1306_128X64_NONAME_F_SW_I2C oled(U8G2_R0, PIN_OLED_SCL, PIN_OLED_SDA, U8X8_PIN_NONE);
#else
// Hardware I2C on Wire (port 0). The camera's SCCB uses I2C port 1 (CONFIG_SCCB_HARDWARE_I2C_PORT1).
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
#endif

static const int MAX_LINES = 4;
static const int MAX_CHARS = 21;

enum class Kind { Lines, PairCode };
struct Screen {
  Kind kind = Kind::Lines;
  int n = 0;
  char lines[MAX_LINES][MAX_CHARS + 1] = {};
  bool streaming = false;
  bool operator==(const Screen &o) const {
    if (kind != o.kind || n != o.n || streaming != o.streaming) return false;
    for (int i = 0; i < n; i++)
      if (strcmp(lines[i], o.lines[i]) != 0) return false;
    return true;
  }
};

static Screen want, drawn;
static bool ready = false, everDrawn = false;

static void centered(int y, const char *s) {
  int w = oled.getStrWidth(s);
  oled.drawStr(w >= 128 ? 0 : (128 - w) / 2, y, s);
}

static void render() {
  if (!ready || (everDrawn && want == drawn)) return;
  oled.clearBuffer();
  if (want.kind == Kind::PairCode) {
    oled.setFont(u8g2_font_6x10_tr);
    centered(12, want.lines[0]);
    oled.setFont(u8g2_font_logisoso24_tr);
    centered(52, want.lines[1]);
  } else {
    bool big = want.n <= 2;
    for (int i = 0; i < want.n && big; i++) big = strlen(want.lines[i]) <= 10;
    if (big) {
      oled.setFont(u8g2_font_logisoso16_tr);
      if (want.n == 1) centered(40, want.lines[0]);
      else {
        centered(27, want.lines[0]);
        centered(54, want.lines[1]);
      }
    } else {
      oled.setFont(u8g2_font_6x10_tr);
      // 4 rows at 14 px pitch, block vertically centred
      int top = (64 - want.n * 14) / 2 + 11;
      for (int i = 0; i < want.n; i++) centered(top + i * 14, want.lines[i]);
    }
  }
  if (want.streaming) oled.drawDisc(124, 3, 2);
  oled.sendBuffer();
  drawn = want;
  everDrawn = true;
}

void begin() {
  ready = oled.begin();
  if (!ready) Serial.println("[oled] init failed");
  render();
}

static void setLines(Kind kind, const char *const *lines, int n) {
  if (n > MAX_LINES) n = MAX_LINES;
  want.kind = kind;
  want.n = n;
  for (int i = 0; i < n; i++) {
    // printable ASCII only, max 21 chars
    int j = 0;
    for (const char *p = lines[i]; *p && j < MAX_CHARS; p++)
      want.lines[i][j++] = (*p >= 0x20 && *p <= 0x7E) ? *p : '?';
    want.lines[i][j] = 0;
  }
  render();
}

void show(const char *const *lines, int n) { setLines(Kind::Lines, lines, n); }

void showPairCode(const char *code) {
  const char *l[] = {"PAIR CODE", code};
  setLines(Kind::PairCode, l, 2);
}

void setStreaming(bool on) {
  want.streaming = on;
  render();
}

}  // namespace display
