# Hardware

Components were bought in Bengaluru before the event. **Confirm the exact board and modules with the human before assuming pins.**

## Bill of materials (planned)
| Part | Choice | Notes |
|---|---|---|
| MCU + camera | ESP32-S3 dev board with camera, ideally Seeed XIAO ESP32-S3 Sense (OV2640/OV3660, PSRAM, battery charging) | Alternatives: LILYGO T-Camera (has an OLED), or ESP32-CAM (harder to work with) |
| Display | 0.96" SSD1306 128×64 I²C OLED | on a hacked **hinge** so it can be flipped into or out of view |
| Voice in + out | **Bluetooth earbuds paired to the payer laptop** | the browser records the earbud mic; the 0G TTS reply plays in the earbuds |
| Microphone on glasses | *optional* I²S MEMS mic (e.g. INMP441) | backup only if the earbud mic is unreliable |
| Buttons | 3 tactile: CAPTURE (push-to-talk), CONFIRM, CANCEL | debounce in firmware |
| Power | 3.7 V protected LiPo 500–1000 mAh, plus a charger if the board lacks one, and an on/off switch | |
| Mechanics | sturdy glasses frame, perfboard, thin wire, zip ties / glue | elegance doesn't matter; reliability does |

Only **one camera**. A second one doesn't help with identification.

## Responsibilities
- **Glasses (firmware):**
  - CAPTURE down → centred JPEG (~640×480) → HTTP POST to the bridge, plus `capture_down` / `capture_up` events (the browser records the earbud mic while it's held)
  - display text the bridge pushes
  - send button events to the bridge
  - no storage, no retries, talks only to the bridge
- **Bridge (Node/TS on the payer's laptop):** receives captures, forwards them to the payer web app over WebSocket, pushes OLED text back, and relays button events.
- **Earbuds:** paired to the laptop (not the glasses). Pick the earbud as the browser's input and output device. Test the mic quality early; Bluetooth headset mode drops audio quality.

## OLED states
`READY` · `LISTENING` · `VERIFIED HUMAN / 2 USDC / OK?` · `NO VERIFIED RECIPIENT` · `PAID` · `CANCELLED` · `APPROVE ON PHONE` (Agent Pass) · `BRAIN OFFLINE - PAUSED`

## Packaging (0G judging point)
Ship it as the open-source package `@cpay/glasses-kit` (`firmware/` PlatformIO + `bridge/`) with a wiring diagram, pinout, BOM and flashing steps. Anyone with the parts should be able to plug it in and use it.
