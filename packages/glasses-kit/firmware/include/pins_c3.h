// ESP32-C3 SuperMini pins. ALL UNCONFIRMED until verified on the real board (see WIRING.md).
// Override any of them with -D flags in platformio.ini ([c3] build_flags).
#pragma once

// OLED (4-pin I2C: GND VCC SCL SDA). GPIO8/9 are the Arduino defaults for the C3 and the
// most common SuperMini OLED wiring. Run `c3-i2c-scan` to find the real pair.
#ifndef PIN_OLED_SDA
#define PIN_OLED_SDA 8
#endif
#ifndef PIN_OLED_SCL
#define PIN_OLED_SCL 9
#endif
#ifndef OLED_I2C_ADDR
#define OLED_I2C_ADDR 0x3C  // 7-bit; some modules use 0x3D
#endif

// Buttons: momentary, one leg to the GPIO, other leg to GND. Internal pull-ups, active LOW.
// Avoids strapping pins (2, 8, 9), USB (18, 19) and UART0 (20, 21).
#ifndef PIN_BTN_CAPTURE
#define PIN_BTN_CAPTURE 5
#endif
#ifndef PIN_BTN_CONFIRM
#define PIN_BTN_CONFIRM 6
#endif
#ifndef PIN_BTN_CANCEL
#define PIN_BTN_CANCEL 7
#endif

// Many SuperMini boards have a badly matched antenna and fail to join Wi-Fi at full TX power.
// Dropping to 8.5 dBm is the well-known fix. Set to 0 to disable.
#ifndef C3_WIFI_LOW_TX_POWER
#define C3_WIFI_LOW_TX_POWER 1
#endif
