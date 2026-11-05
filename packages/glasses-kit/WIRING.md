# Glasses kit wiring

**Decided 6 Nov: one board, no buttons.** The ESP32-CAM is the whole glasses unit (camera + OLED).
The phone drives the session (tap Scan, spoken confirm code); see `docs/ARCHITECTURE.md` (2).
The ESP32-C3 SuperMini is abandoned (its USB never enumerated). A second DevKit is a spare.

## Boards

| Board | What it does | Notes |
|---|---|---|
| ESP32-CAM (AI-Thinker clone, **no USB port**), **GC2145 sensor** (no hardware JPEG) | camera + OLED + Wi-Fi to the hub | runs the only glasses firmware (`cam` env) |
| ESP32 DevKit (WROOM-32, CP2102, USB-C), **EN tied to GND** | **USB-C power input + USB-serial** for logs and flashing | runs no firmware: its ESP32 is held in reset |
| 0.96" 4-pin I²C OLED, **SSD1306 128×64 at 0x3C** | display | confirmed 6 Nov with `devkit-oled-test` |

```
  USB-C (power bank / Mac, >= 1 A)
        │
  ┌─────▼──────────────┐                ┌──────────────────────┐
  │ ESP32 DevKit       │ 5V/VIN ───────►│ 5V                   │
  │ (EN -> GND,        │ GND ──────────►│ GND     ESP32-CAM    │
  │  chip held in      │ RX0 ──────────►│ U0R     (GC2145)     │
  │  reset)            │ TX0 ──────────►│ U0T                  │
  └────────────────────┘                │                      │
                                        │ 3V3  ─► OLED VCC     │
                                        │ GND  ─► OLED GND     │
                                        │ IO15 ─► OLED SDA     │
                                        │ IO14 ─► OLED SCL     │
                                        │ (IO0 -> GND only     │
                                        │  while flashing)     │
                                        └──────────────────────┘
   Wi-Fi (2.4 GHz phone hotspot) ───> cpay-hub on Render ───> the paired phone
```

## 1. Power

The CAM has no USB port, so the DevKit takes USB-C and feeds the CAM's **5V** pin.

| From (DevKit) | To (ESP32-CAM) | Confirmed |
|---|---|---|
| **5V / VIN** | **5V** | [x] flashing, 6 Nov |
| **GND** | **GND** (required: without it nothing works) | [x] 6 Nov |
| **EN** | DevKit **GND** (keeps the DevKit's ESP32 off) | [x] 6 Nov |

- **5V to 5V only. Never 5 V on a 3V3 pin.**
- One USB source only.
- Use a supply that gives **at least 1 A**: Wi-Fi + camera peak ~300 mA, plus the OLED and the DevKit's USB chip.
- **Brownout resets** ("Brownout detector was triggered") mean the power is weak: use a shorter or thicker cable, or add a 100–470 µF capacitor across the CAM's 5V and GND.

## 2. OLED (on the CAM)

| OLED pin | ESP32-CAM pin | Confirmed |
|---|---|---|
| GND | GND | [ ] |
| VCC | **3V3** | [ ] |
| SDA | **IO15** | [ ] |
| SCL | **IO14** | [ ] |
| Address / controller | 0x3C, **SSD1306** | [x] on the DevKit, 6 Nov |

Why IO14/IO15:
- They're the SD-card pins, and we don't use the SD card.
- IO15 is a strapping pin, but it's only needed high at boot. The OLED's pull-ups keep it high, which is fine.
- **Avoid IO12** (it sets the flash voltage: pulled high, the board won't boot), **IO0** (boot mode), **IO2** (download mode), **IO4** (flash LED) and **IO16** (PSRAM).
- The camera uses its own I²C bus (SCCB on IO26/27), so the OLED goes on the second I²C controller (`Wire` on 15/14). If the two clash, use `Wire1`.

## 3. Camera (ESP32-CAM)

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

## 4. Flashing and logs (the CAM has no USB port)

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

Because this DevKit stays wired to the CAM on the glasses (§1), you never rewire to flash: add IO0→GND,
press CAM RST, upload; remove IO0→GND, press RST. Logs are always on the same USB cable.
