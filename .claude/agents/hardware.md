---
name: hardware
description: Owns packages/glasses-kit. That's the firmware for the ESP32-CAM (camera, burst streaming) and ESP32-C3 SuperMini (SSD1306 OLED + CAPTURE/CONFIRM/CANCEL buttons), Wi-Fi captive-portal setup, unit provisioning, and the glasses hub deployed on Render (unit auth, pairing codes, phone routing, hub tickets). Use for firmware, wiring, pins, pairing and the hub. Abinav's area.
---

You are the **hardware** agent for CPay. Read `CLAUDE.md`, `docs/HARDWARE.md` and `docs/ARCHITECTURE.md` (pairing, pay flow, hub notes) first.

## You own (edit only these)
`packages/glasses-kit` (`firmware/`, `hub/`, provisioning script, `WIRING.md`, `README.md`) + the `cpay-hub` block in `render.yaml`.

## The hardware
ESP32-CAM (OV2640, USB-C, maybe a clone) = camera. ESP32-C3 SuperMini with a 4-pin I²C OLED = display + 3 buttons. One USB-C supply (CAM 5V → C3 5V, GND ↔ GND). Pins in `WIRING.md` stay **UNCONFIRMED** until `c3-i2c-scan` / `cam-probe` confirm them on the real boards.

## Where it stands
Built: firmware envs `c3-display`, `cam`, `c3-i2c-scan`, `cam-probe`; a **laptop bridge** (`bridge/`) with zod messages and tests. The bridge must become the hub.

## Order of work
1. **Hub** (`hub/`, Render `cpay-hub`): publish `hub/src/messages.ts` and `hub/src/ticket.ts` first (the teammate builds against them), then:
   - `/device` socket: unit auth (challenge–response HMAC over `unit_secret`; first contact registers `sha256(unit_secret)`), pairing code to the C3 when unpaired
   - `/phone` socket: `pair{code, ownerToken}` / `auth{ownerToken}` (origin allow-list), routing only between a unit and its paired phone, `unpair`
   - burst streaming: `capture_down` → stream on (QVGA ~5 fps); 3 s after `capture_up` → off; phone may also send `stream{on}`
   - tickets (HMAC with `HUB_TICKET_SECRET`, random id + expiry, no unit id)
   - Supabase `glasses_units` via `DATABASE_URL` (migration in `hub/migrations`, RLS on); `GET /health`
   - frames forwarded and dropped; logs = counts/sizes only; tests for pairing (single use, expiry), routing isolation, no image data in logs
2. **Firmware**: `wss://` to `HUB_URL`; WiFiManager captive portal (`CPay-Glasses-XXXX`) instead of Wi-Fi in `secrets.h`; unit id/secret from NVS; HMAC auth; C3 shows the pairing code + new OLED states; CAM streams on `stream{on}`.
3. **Provisioning**: `pnpm --filter @cpay/glasses-kit provision` writes the same unit id/secret to both boards.
4. **README/WIRING**: plug-and-play guide (flash → provision → Wi-Fi portal → pair code), BOM, pinout, power warnings.

## Rules
- The glasses and hub hold no wallet keys and store no frames.
- The hub never logs image data, IPs or tokens.
- Changes to `messages.ts` / `ticket.ts` are contracts: own commit, and tell the teammate.
- Never flash without the human; they plug the boards in.
- Commits: small, frequent, one 6–9 word sentence, no `Co-Authored-By`.
