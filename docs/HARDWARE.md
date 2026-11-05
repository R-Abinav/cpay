# Hardware (glasses)

The actual parts (confirmed Thu 5 Nov). Owner: Abinav. Code: `packages/glasses-kit`.

## Bill of materials
| Part | What it is | Role |
|---|---|---|
| **ESP32-CAM** with OV2640 | Wi-Fi + BT, **own USB-C** (flash directly). Not labelled AI-Thinker (maybe a clone); `cam-probe` finds the camera pin map | camera: streams JPEG frames to the hub while scanning |
| **ESP32-C3 SuperMini** with a **4-pin 0.96" I²C OLED** (SSD1306 128×64; SH1106 possible), already soldered, USB-C | reflashable | display + the **3 buttons** |
| 3 tactile buttons | CAPTURE (hold = scan + talk), CONFIRM, CANCEL | wired to the C3 (pin to GND, internal pull-up) |
| Plain ESP32 module, USB-C | spare | backup |
| Breadboard + jumpers | | prototyping, power link |
| Bluetooth earbuds | paired to **the user's phone** | voice in and out |

Pins are in `packages/glasses-kit/WIRING.md`, marked UNCONFIRMED until the diagnostics confirm them on the real boards.

## Power: one USB-C source
Power the **ESP32-CAM over USB-C** (power bank). Feed the C3 from it: **CAM 5V → C3 5V, GND → GND**. Never 5V into a 3V3 pin; never two USB sources while the 5V jumper is in. Resets when Wi-Fi starts = brownout: use a better cable/power bank.

## Network: phone hotspot → internet → hub on Render
- Both boards join the **user's phone hotspot** (2.4 GHz; on iPhone turn on "Maximise Compatibility") and connect out to `wss://<cpay-hub>/device`. No laptop, no data wires between boards.
- **Wi-Fi setup (product, no hard-coded passwords):** on first boot, or when the saved network fails for 30 s, each board opens a captive portal AP `CPay-Glasses-XXXX` (WiFiManager). Connect with the phone, pick the hotspot, enter its password. Saved in NVS.
- **Unit provisioning (once, at flash time):** `pnpm --filter @cpay/glasses-kit provision` generates a `unit_id` + random `unit_secret` and writes the same pair into both boards (NVS), so they act as one unit. The hub URL is baked into the firmware config (`HUB_URL`).
- **Pairing to a phone:** unpaired, the OLED shows a 6-character code; type it in the PWA (Settings → Pair glasses). Details: `docs/ARCHITECTURE.md` (1).
- Boards reconnect automatically (2 s backoff) after hub restarts or Wi-Fi drops.

## Responsibilities
- **C3 firmware:** buttons (debounced) → `btn` events; OLED shows hub-pushed lines; shows the pairing code when unpaired; local states `WIFI SETUP` (portal open), `NO WIFI`, `NO HUB`.
- **CAM firmware:** on `stream{on}`, send JPEG frames (QVGA 320×240, ~5 fps, quality tuned for QR) until `stream{off}`; on `capture`, one VGA frame (face path). No storage, no retries.
- **Hub** (`packages/glasses-kit/hub`, Render `cpay-hub`): device + phone sockets, unit auth, pairing, routing, tickets. **On `capture_down` it starts the stream; 3 s after `capture_up` it stops it.** Frames are forwarded to the paired phone and dropped; logs carry counts/sizes only.

## OLED states
`WIFI SETUP` · `NO WIFI` · `NO HUB` · `PAIR: AB3K9Q` · `READY` · `SCANNING` · `NO QR FOUND` · `VERIFIED HUMAN / 2 USDC / OK?` · `PUBLIC ADDR / 2 USDC / OK?` · `NO VERIFIED RECIPIENT` · `APPROVE ON PHONE` · `PAID` · `CANCELLED` · `BRAIN OFFLINE - PAUSED`

## Toolchain notes
- VS Code + PlatformIO; open `packages/glasses-kit/firmware` as its own project.
- **Apple Silicon:** the C3 toolchain is x86-only; install Rosetta once (`softwareupdate --install-rosetta --agree-to-license`) or C3 builds fail with "Bad CPU type in executable".
- Flash one board at a time with the 5V jumper removed. ESP32-CAM upload fails → hold BOOT/IO0 and press RST.

## Packaging (0G judging point)
`@cpay/glasses-kit` ships firmware + hub + provisioning with a BOM, wiring diagram, pinout, flashing steps and a "plug and play" guide: flash → provision → Wi-Fi portal → pair code → done.
