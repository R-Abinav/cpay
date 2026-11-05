# Glasses kit wiring

> **Every pin on this page is UNCONFIRMED** until the human checks it on the real boards
> (with `c3-i2c-scan`, `cam-probe` and a multimeter) and ticks the "Confirmed" column.
> When a pin turns out different, change it in `firmware/platformio.ini` (`-D` flags) **and** here.

## Boards

| Board | What it does | Notes |
|---|---|---|
| ESP32-CAM (AI-Thinker clone, **no USB port**), **GC2145 sensor** (sold as OV2640; no hardware JPEG) | camera only | **powered from the C3's 5V**; flashed through a USB-serial bridge (§5) |
| ESP32-C3 "mini" (probably an ESP32-C3 SuperMini) + 0.96" 4-pin OLED soldered on | OLED + 3 buttons | OLED is almost certainly an SSD1306 128×64 over I²C (SH1106 possible) |

There are **no data wires between the boards**. Each joins the phone hotspot and talks to the bridge on the Mac.

```
                                    USB-C power (power bank, >= 1 A) ──┐
                                                                       │
              ┌────────────────────┐                       ┌───────────┴──────────────┐
              │     ESP32-CAM      │                       │  ESP32-C3 SuperMini      │
              │  (GC2145 camera)   │ 5V <──────────────────│ 5V                       │
              │                    │ GND <─────────────────│ GND ──┬──┬──┐            │
              └────────────────────┘                       │       │  │  │            │
                                                           │ GPIO5 ─┤CAPTURE (hold)    │
                                                           │ GPIO6 ────┤CONFIRM        │
                                                           │ GPIO7 ───────┤CANCEL      │
                                                           │ SDA/SCL ── OLED (soldered)│
                                                           └──────────────────────────┘
               Wi-Fi (2.4 GHz phone hotspot) ───> cpay-hub on Render ───> the paired phone
```

## 1. Power

The ESP32-CAM has **no USB port** (confirmed 6 Nov), so the C3 takes the USB-C power and feeds the CAM.

| From (ESP32-C3) | To (ESP32-CAM) | Confirmed |
|---|---|---|
| **5V** pin (VBUS/5V) | **5V** pin | [ ] |
| **GND** pin | **GND** pin | [ ] |

**Warnings (read before plugging anything in):**

- **5V to 5V only. Never put 5 V on a 3V3 pin** of either board: that kills the chip.
- **Only one USB cable at a time while the 5V wire is connected.** If you plug USB into the C3 *and* the CAM
  with the 5V link in place, two supplies fight through the boards. **When flashing the C3, unplug the 5V
  wire first** (GND can stay). Then put it back.
- Use a supply that gives **at least 1 A**. The ESP32-CAM pulls ~300 mA peaks with Wi-Fi + camera, the C3
  another ~100-350 mA. Weak supplies cause **brownout resets** ("Brownout detector was triggered" in the CAM
  serial log) and boot loops. Short, thick power wires help.
- Check polarity with a multimeter before the first power-up: 5 V between the C3's 5V and GND pins.
- Don't hold the ESP32-CAM's IO0/BOOT button (or tie GPIO0 to GND) at power-up: that's download mode.

## 2. Buttons (on the C3)

Momentary push buttons. One leg to the GPIO, the other leg to **GND**. No resistors: the firmware enables the
internal pull-ups, so a press reads LOW. Debounced in firmware (25 ms).

| Button | C3 GPIO | Behaviour | Confirmed |
|---|---|---|---|
| CAPTURE (push-to-talk, hold) | **GPIO5** (UNCONFIRMED) | `capture_down` on press, `capture_up` on release | [ ] |
| CONFIRM | **GPIO6** (UNCONFIRMED) | `confirm` on press | [ ] |
| CANCEL | **GPIO7** (UNCONFIRMED) | `cancel` on press | [ ] |

Why these pins: on the C3, **GPIO2, GPIO8 and GPIO9 are strapping pins** (a button held at boot can stop the
chip booting; GPIO8 also drives the on-board LED and GPIO9 the BOOT button), **GPIO18/19 are the USB D-/D+**
pins (flashing and serial over USB-C), and **GPIO20/21 are UART0**. GPIO5/6/7 are plain GPIOs that sit next to
each other on the SuperMini header. If the OLED turns out to be on one of them, use GPIO0/1/3/4/10 instead.

## 3. OLED (on the C3, already soldered)

4-pin I²C module: **GND, VCC, SCL, SDA**.

| OLED pin | C3 pin | Confirmed |
|---|---|---|
| GND | GND | [ ] |
| VCC | 3V3 (most modules also take 5V; check the module) | [ ] |
| SDA | **GPIO8** (UNCONFIRMED, firmware default) | [ ] |
| SCL | **GPIO9** (UNCONFIRMED, firmware default) | [ ] |
| I²C address | **0x3C** (UNCONFIRMED; 0x3D is possible) | [ ] |
| Controller | **SSD1306** (UNCONFIRMED; SH1106 possible) | [ ] |

GPIO8/9 are the Arduino default I²C pins for the C3 and a common SuperMini OLED wiring. But if the display is
soldered straight onto the header (no wires), its four pins land on four *adjacent* header pins, e.g.
`GND, 3V3, GPIO4, GPIO3` → SCL=GPIO4, SDA=GPIO3. **Don't guess: flash `c3-i2c-scan`.** It tries every pin
pair, prints the answer on the serial monitor and draws it on the display. Then set
`-DPIN_OLED_SDA=.. -DPIN_OLED_SCL=.. -DOLED_I2C_ADDR=..` in `[c3] build_flags`.
If the scan's text looks shifted sideways or there is a noisy column at one edge, it's an SH1106: add
`-DOLED_SH1106=1`.

## 4. Camera (ESP32-CAM)

The OV2640 plugs into the board's ribbon connector (latch closed, contacts facing the board). No wiring.
The firmware default is the **AI-Thinker** pin map (UNCONFIRMED), which nearly every "ESP32-CAM" board,
clones included, uses:

| Signal | AI-Thinker GPIO | Signal | AI-Thinker GPIO |
|---|---|---|---|
| PWDN | 32 | Y9 / D7 | 35 |
| RESET | - (not used) | Y8 / D6 | 34 |
| XCLK | 0 | Y7 / D5 | 39 |
| SIOD (SDA) | 26 | Y6 / D4 | 36 |
| SIOC (SCL) | 27 | Y5 / D3 | 21 |
| VSYNC | 25 | Y4 / D2 | 19 |
| HREF | 23 | Y3 / D1 | 18 |
| PCLK | 22 | Y2 / D0 | 5 |
| Flash LED | 4 (kept off) | | |

**Confirm with `cam-probe`.** It tries AI-Thinker first, then M5Stack (PSRAM / V2 / ESP32CAM), TTGO T-Journal,
WROVER-KIT and ESP-EYE maps (taken from the Arduino-ESP32 `CameraWebServer` example), and prints
`RESULT: use -DCAM_MAP_INDEX=<n>`. Put that in `[cam] build_flags`.
Maps that would drive flash/PSRAM pins on this board are skipped so the probe can't crash the chip.

| Item | Value | Confirmed |
|---|---|---|
| Pin map | AI_THINKER (`CAM_MAP_INDEX=0`) | [x] cam-probe, 6 Nov |
| Sensor | **GC2145** (PID 0x2145), no hardware JPEG: firmware captures RGB565 at QVGA and encodes JPEG in software (`frame2jpg`, ~100 ms/frame → ~4–6 fps) | [x] cam-probe, 6 Nov |
| PSRAM present | expected yes (4 MB) | [ ] |
| Image upright | if not, add `-DCAM_VFLIP=1` and/or `-DCAM_HMIRROR=1` | [ ] |

## Sources

- ESP32-C3 SuperMini pinout and strapping pins:
  [Random Nerd Tutorials](https://randomnerdtutorials.com/getting-started-esp32-c3-super-mini),
  [Last Minute Engineers](https://lastminuteengineers.com/esp32-c3-super-mini-pinout-reference/),
  [espboards.dev](https://www.espboards.dev/esp32/esp32-c3-super-mini/)
- Camera pin maps: `framework-arduinoespressif32/libraries/ESP32/examples/Camera/CameraWebServer/camera_pins.h`
  (Arduino-ESP32 2.0.17)

## 5. Flashing the ESP32-CAM (it has no USB port)

Use the spare ESP32 DevKit (USB-C, CP2102) as a USB-serial adapter. **Confirmed working 6 Nov.**

| DevKit | → | ESP32-CAM |
|---|---|---|
| RX0 | → | U0R |
| TX0 | → | U0T |
| GND | → | GND (**required**: without a shared ground nothing gets through) |
| 5V / VIN | → | 5V |
| EN | → | DevKit GND (holds the DevKit's own ESP32 in reset) |
| | | CAM IO0 → CAM GND **only while flashing** |

Same names to same names: with its ESP32 held in reset, the DevKit's RX0/TX0 pins carry the CP2102's TX/RX.
Flash: IO0→GND, press CAM RST, `pio run -e <env> -t upload --upload-port /dev/cu.usbserial-0001`.
Run: remove IO0→GND, press CAM RST, monitor at 115200.
Power from the DevKit is fine for flashing, but Wi-Fi + camera may brown out on thin jumpers.
