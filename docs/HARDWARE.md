# Hardware

The team's actual parts (confirmed by the human, Thu 5 Nov). Build for these, not the original plan.

## Bill of materials (actual)
| Part | What it is | Role |
|---|---|---|
| **ESP32-CAM** with OV2640 | Wi-Fi + BT, **has its own USB-C** (flash directly, no FTDI). Not labelled AI-Thinker, so it may be a clone; **identify the camera pin map by trying the common ones** (AI-Thinker first) | camera node: takes a JPEG when asked, sends it to the bridge |
| **ESP32-C3 "mini"** (likely an ESP32-C3 SuperMini) with a **0.96" display already soldered on, working** | USB-C, reflashable. The display has **4 pins**, so it's almost certainly an **I²C SSD1306 128×64 OLED** (could be SH1106; try SSD1306 first) | display + buttons node |
| 3 tactile buttons | CAPTURE (push-to-talk), CONFIRM, CANCEL | wired to the **C3** (the ESP32-CAM has almost no free pins once the camera runs) |
| Plain ESP32 module, USB-C | spare | backup if a board dies; not in the build |
| Breadboard + jumper wires | | prototyping and power link |
| Bluetooth earbuds | paired to the payer laptop | voice in and out (unchanged) |

Only **one camera**. A second one doesn't help with identification.

## Power: one USB-C source for both boards
Only one board gets USB-C power (power bank or laptop). Power the **ESP32-CAM over USB-C** (it draws the most: camera + Wi-Fi spikes), then feed the C3 from it:
- ESP32-CAM **5V pin → C3 5V pin**, and **GND → GND** (common ground is mandatory).
- Never connect 3.3 V to 5 V, and never power the same board from two sources at once (unplug the C3's USB when it's fed from the jumper).
- If the CAM browns out (resets when Wi-Fi starts), use a better cable or power bank before anything else.

## Link between boards: Wi-Fi, no data wires
Both boards join the same **2.4 GHz phone hotspot** and talk to the laptop bridge directly:
- ESP32-CAM ⇄ bridge: the bridge asks for a frame; the CAM replies with a JPEG.
- C3 ⇄ bridge: the bridge pushes OLED text; the C3 sends button events (`capture_down`, `capture_up`, `confirm`, `cancel`).
- **Fallback only if Wi-Fi is unreliable at the venue:** UART from C3 to CAM (C3 TX → CAM RX, plus GND). Not built unless needed.

## Responsibilities
- **C3 firmware (display + buttons):** buttons → events to the bridge (`capture_down` / `capture_up` / `confirm` / `cancel`, debounced); show the OLED text the bridge pushes; show `NO WIFI` / `NO BRIDGE` locally when disconnected.
- **ESP32-CAM firmware (camera):** on request from the bridge, take a centred JPEG (~640×480) and send it. No storage, no retries, talks only to the bridge.
- The browser records the earbud mic while CAPTURE is held.
- **Bridge (Node/TS on the payer's laptop):** receives captures, forwards them to the payer web app over WebSocket, pushes OLED text back, and relays button events.
- **Earbuds:** paired to the laptop (not the glasses). Pick the earbud as the browser's input and output device. Test the mic quality early; Bluetooth headset mode drops audio quality.

## OLED states
`READY` · `LISTENING` · `VERIFIED HUMAN / 2 USDC / OK?` · `NO VERIFIED RECIPIENT` · `PAID` · `CANCELLED` · `APPROVE ON PHONE` (Agent Pass) · `BRAIN OFFLINE - PAUSED`

## Packaging (0G judging point)
Ship it as the open-source package `@cpay/glasses-kit` (`firmware/` PlatformIO + `bridge/`) with a wiring diagram, pinout, BOM and flashing steps. Anyone with the parts should be able to plug it in and use it.
