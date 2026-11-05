// DIAGNOSTIC for the display DevKit (ESP32-WROOM-32): OLED on SDA=GPIO21, SCL=GPIO22.
// Scans the I2C bus, then alternates the SSD1306 and SH1106 drivers every 5 s.
// Whichever screen looks clean (no shifted text / noise column) is the right controller.

#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>

#ifndef PIN_OLED_SDA
#define PIN_OLED_SDA 21
#endif
#ifndef PIN_OLED_SCL
#define PIN_OLED_SCL 22
#endif

static uint8_t oledAddr = 0;

static void scan() {
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL, 100000);
  Serial.printf("\n=== CPay DevKit OLED test (SDA=GPIO%d SCL=GPIO%d) ===\nI2C devices:", PIN_OLED_SDA,
                PIN_OLED_SCL);
  oledAddr = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", a);
      if ((a == 0x3C || a == 0x3D) && !oledAddr) oledAddr = a;
    }
  }
  Serial.println();
  if (oledAddr) Serial.printf("RESULT: OLED found at 0x%02X\n", oledAddr);
  else Serial.println("RESULT: no OLED at 0x3C/0x3D. Check VCC->3V3, GND, SDA->21, SCL->22.");
  Wire.end();
}

template <typename T>
static void draw(T &oled, const char *name) {
  oled.setI2CAddress(oledAddr * 2);
  oled.begin();
  oled.clearBuffer();
  oled.drawFrame(0, 0, 128, 64);
  oled.setFont(u8g2_font_6x10_tf);
  oled.drawStr(4, 14, "CPAY OLED TEST");
  oled.drawStr(4, 30, "driver:");
  oled.setFont(u8g2_font_logisoso16_tf);
  oled.drawStr(4, 56, name);
  oled.sendBuffer();
  Serial.printf("showing %s driver (frame should touch all 4 edges cleanly)\n", name);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
}

void loop() {
  scan();
  if (!oledAddr) {
    delay(5000);
    return;
  }
  {
    U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
    draw(oled, "SSD1306");
  }
  delay(5000);
  {
    U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
    draw(oled, "SH1106");
  }
  delay(5000);
}
