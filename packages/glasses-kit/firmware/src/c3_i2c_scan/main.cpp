// DIAGNOSTIC: finds which GPIO pair the soldered OLED is on.
// Tries every (SDA, SCL) pair of the usable SuperMini GPIOs, looks for a device at 0x3C/0x3D,
// prints a full I2C address scan for each hit, and draws the result on the display itself.
// USB pins 18/19 are never touched, so the serial monitor stays alive.
// Put the result in platformio.ini as -DPIN_OLED_SDA=.. -DPIN_OLED_SCL=.. (and OLED_I2C_ADDR).

#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>

static const uint8_t CANDIDATES[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21};
static const int N = sizeof(CANDIDATES);

static bool probe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static void showOnOled(uint8_t sda, uint8_t scl, uint8_t addr) {
  // Drawn with the SSD1306 driver. If the text looks shifted or has a noise column at the edge,
  // the controller is an SH1106: build c3-display with -DOLED_SH1106=1.
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, scl, sda);
  oled.setI2CAddress(addr * 2);
  oled.begin();
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tf);
  char l1[24], l2[24];
  snprintf(l1, sizeof l1, "SDA=GPIO%u", sda);
  snprintf(l2, sizeof l2, "SCL=GPIO%u", scl);
  oled.drawStr(0, 12, "CPAY I2C SCAN OK");
  oled.drawStr(0, 28, l1);
  oled.drawStr(0, 40, l2);
  char l3[24];
  snprintf(l3, sizeof l3, "ADDR=0x%02X", addr);
  oled.drawStr(0, 52, l3);
  oled.sendBuffer();
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // give the USB serial monitor time to attach
}

void loop() {
  Serial.println("\n=== CPay C3 I2C scan (OLED is usually 0x3C, sometimes 0x3D) ===");
  int hits = 0;
  uint8_t lastSda = 0, lastScl = 0, lastAddr = 0;
  for (int i = 0; i < N; i++) {
    for (int j = 0; j < N; j++) {
      if (i == j) continue;
      uint8_t sda = CANDIDATES[i], scl = CANDIDATES[j];
      Wire.begin(sda, scl, 100000);
      Wire.setTimeOut(20);
      uint8_t found = 0;
      if (probe(0x3C)) found = 0x3C;
      else if (probe(0x3D)) found = 0x3D;
      if (found) {
        hits++;
        Serial.printf("FOUND display-like device 0x%02X on SDA=GPIO%u SCL=GPIO%u. All addresses:", found,
                      sda, scl);
        for (uint8_t a = 1; a < 127; a++)
          if (probe(a)) Serial.printf(" 0x%02X", a);
        Serial.println();
        lastSda = sda;
        lastScl = scl;
        lastAddr = found;
      }
      Wire.end();
      pinMode(sda, INPUT);
      pinMode(scl, INPUT);
    }
  }
  if (hits == 0) {
    Serial.println("No device at 0x3C/0x3D on any pair. Check VCC/GND to the display and solder joints.");
  } else {
    Serial.printf("RESULT: -DPIN_OLED_SDA=%u -DPIN_OLED_SCL=%u -DOLED_I2C_ADDR=0x%02X\n", lastSda, lastScl,
                  lastAddr);
    showOnOled(lastSda, lastScl, lastAddr);
  }
  Serial.println("Repeating in 10 s...");
  delay(10000);
}
