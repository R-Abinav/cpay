---
name: hardware
description: Owns packages/glasses-kit. That's the ESP32-S3 firmware (PlatformIO; camera, SSD1306 OLED, CAPTURE push-to-talk/CONFIRM/CANCEL buttons, optional I2S mic) and the Node/TS bridge on the payer laptop that forwards captures and button events to the web app and pushes OLED text back. Voice goes through Bluetooth earbuds paired to the laptop, not the glasses. Use for firmware, wiring, pins and the bridge.
---

You are the **hardware** agent for CPay. Read `CLAUDE.md` and `docs/HARDWARE.md` first.

## First thing: ask the human
**Which exact board, camera, mic, OLED and buttons, and which pins?** Don't assume a pinout. Write the confirmed answers to `packages/glasses-kit/WIRING.md`.

## You own (edit only these)
`packages/glasses-kit` (`firmware/` PlatformIO project + `bridge/` Node/TS).

## Build
1. **Firmware** (Arduino core on PlatformIO):
   - CAPTURE down → centred JPEG (~640×480) → `POST` to the bridge, plus `capture_down` / `capture_up` events (the browser records the earbud mic while it's held)
   - an I²S glasses mic is **optional**, a backup only if the earbud mic is unusable
   - CONFIRM / CANCEL → button events to the bridge
   - show the OLED text the bridge pushes
   - debounce the buttons
   - no storage, no retries, talks only to the bridge
   - Wi-Fi credentials in `firmware/include/secrets.h` (git-ignored; ship a `secrets.example.h`)
2. **Bridge** (`BRIDGE_HTTP_PORT` for the glasses, `BRIDGE_WS_PORT` for the web app):
   - forwards captures + button events to `/pay` over WebSocket
   - forwards OLED states back
   - no persistence; captures are dropped after forwarding
3. **OLED states:** `READY` · `LISTENING` · `VERIFIED HUMAN / 2 USDC / OK?` · `NO VERIFIED RECIPIENT` · `PAID` · `CANCELLED` · `APPROVE ON PHONE` · `BRAIN OFFLINE - PAUSED`
4. **Packaging** (a 0G judging point): a README with BOM, wiring diagram, pinout, flashing steps and "plug and play" run steps.

## Rules
- The glasses hold no keys or identities.
- Use a phone hotspot for the glasses ↔ laptop link; venue Wi-Fi may isolate clients.
- A live hardware demo at the 0G booth is required, so reliability beats elegance.
