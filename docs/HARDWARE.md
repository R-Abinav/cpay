# Hardware (glasses)

Owner: Abinav. Code: `packages/glasses-kit`. Pins: `packages/glasses-kit/WIRING.md`.
**Decided Fri 6 Nov: one board, no buttons.** The ESP32-CAM is the whole glasses unit (camera + OLED). The phone drives the session: tap **Scan**, speak the amount, speak the confirm code shown on the OLED.

## Bill of materials
| Part | What it is | Role |
|---|---|---|
| **ESP32-CAM** (AI-Thinker clone) with a **GC2145** sensor (sold as OV2640) | Wi-Fi + BT, **no USB port**. The GC2145 has no hardware JPEG, so the firmware encodes JPEG in software (~100 ms per QVGA frame, ~4–6 fps) | the glasses: camera + OLED + Wi-Fi to the hub |
| **0.96" I²C OLED**, SSD1306 128×64 at 0x3C | 4 pins (GND, VCC, SCL, SDA), on the CAM's IO14/IO15 | shows the pairing code, scan state, amount and **the confirm code** |
| **ESP32 DevKit** (WROOM-32, CP2102, USB-C), EN tied to GND | its own chip is held in reset | **USB-C power input** + USB-serial for logs and flashing; stays wired to the CAM |
| Spare ESP32 DevKit | | backup; also used to confirm the OLED (`devkit-oled-test`) |
| Bluetooth earbuds | paired to **the user's phone** | voice in and out |
| ~~ESP32-C3 SuperMini~~ | its USB never enumerated | abandoned |
| ~~3 buttons~~ | | dropped: replaced by tap Scan + the spoken confirm code |

## Power: one USB-C cable
USB-C goes into the DevKit; **DevKit 5V/VIN → CAM 5V, GND → GND**. Never 5V into a 3V3 pin. One USB source only. Resets when Wi-Fi starts = brownout: use a better cable or power bank, or add a 100–470 µF capacitor across the CAM's 5V and GND.

## Network: phone hotspot → internet → hub on Render
- The CAM joins the **user's phone hotspot** (2.4 GHz; on iPhone turn on "Maximise Compatibility") and connects out to `wss://<cpay-hub>/device`. No laptop.
- **Wi-Fi setup (no hard-coded passwords):** on first boot, or when the saved network fails for 30 s, the CAM opens a captive portal AP `CPay-Glasses-XXXX` (WiFiManager). Connect with the phone, pick the hotspot, enter its password. Saved in NVS. The OLED shows `WIFI SETUP / CPay-Glasses-XXXX`.
- **Unit provisioning (once, at flash time):** `pnpm --filter @cpay/glasses-kit provision` generates a `unit_id` + random `unit_secret` and writes them into the CAM's NVS. The hub URL is baked into the firmware config (`HUB_URL`).
- **Pairing to a phone:** unpaired, the OLED shows a 6-character code; type it in the PWA (Settings → Pair glasses). Details: `docs/ARCHITECTURE.md` (1).
- **Pairing lasts one power-on: every power-on shows a fresh code** (firmware 0.3.1+). The device `auth` carries `fresh` (true until the first `auth_ok` of this power-on, RAM only) and a random boot id (`esp_random`, never printed). `fresh: true` always clears `owner_token_hash`, closes the paired phone (`4003 glasses_restarted`; the phone shows "Glasses restarted — enter the new code") and the OLED shows a fresh code, even right after a hub restart. Later reconnects in the same boot send `fresh: false` and keep the pairing (Wi-Fi drop, hub restart). Older firmware without `fresh` falls back to the boot-id compare (in memory only; a hub restart keeps the stored pairing). Nothing new in the database. Phone **Unpair** still works any time.
- **Database blips (flaky hotspot → Supabase pooler):** every hub store call is retried (3 tries, 300 ms / 1 s), then reads fall back to an in-memory cache of the rows already seen (hashes + ids only), so a known unit still authenticates. A failed write (unpair on a fresh boot, a pairing) is never faked: the hub closes the socket `1013 store unavailable` without `auth_ok` / `hello` and the device or phone retries (a fresh boot stays fresh; a pairing code stays valid). Logs carry the error class only, never messages or connection strings.
- **Phone states** (Settings and Pay show the same one): `Glasses offline` (paired, glasses not connected / heartbeat lost) · `Paired` (paired + online) · `Turn on your glasses and enter the code shown on them` (no pairing; code input inline) · `Glasses restarted — enter the new code` (after `4003 glasses_restarted` or an unknown token: the token is dropped and the phone stops reconnecting). An unpaired phone can't see whether the glasses are on (the hub tells only the paired phone).
- **Heartbeat:** the hub pings every device and phone socket every 5 s and terminates one that misses 2 pings (~10 s), so a power cut shows "Glasses not connected" within ~15 s and stops any scan (`device_offline`).
- Reconnects automatically (2 s backoff) after hub restarts or Wi-Fi drops.

## Responsibilities
- **CAM firmware** (`cam` env): Wi-Fi portal, HMAC auth to the hub, OLED (hub-pushed lines + local states), and on `stream{on}` JPEG frames at QVGA 320×240, ~5 fps (RGB565 → software JPEG), until `stream{off}`. No storage, no retries, flash LED off.
- **Hub** (`packages/glasses-kit/hub`, Render `cpay-hub`): device + phone sockets, unit auth, pairing, routing, tickets. **The phone's `scan{on}` starts the stream; `scan{off}` or 15 s without a refresh stops it.** Frames are forwarded to the paired phone and dropped; logs carry counts/sizes only.

## OLED states
Local (firmware): `BOOTING` · `WIFI SETUP / CPay-Glasses-XXXX` · `NO WIFI` · `CONNECTING` (first 10 s of reaching the hub, also after a drop) · `NO HUB` (still not authenticated after 10 s; keeps retrying every 2 s)
From the hub/phone: `PAIR: AB3K9Q` · `READY` · `SCANNING` · `NO QR - TAP TO RETRY` · `NOT A WALLET QR` · `WRONG NETWORK` · `SAY AMOUNT` · `SAY AMOUNT AGAIN` · `VERIFIED HUMAN / 2 USDC` · `PUBLIC ADDR / 0xAB..12 / 2 USDC` · `PAY 2 USDC / SAY CONFIRM 47` · `NO VERIFIED RECIPIENT` · `APPROVE ON PHONE` · `PAYING...` · `PAID` · `CANCELLED` · `BRAIN OFFLINE - PAUSED`
Max 4 lines × 21 characters (6×10 font) or 2 lines in a large font for the code.

## Toolchain notes
- VS Code + PlatformIO; open `packages/glasses-kit/firmware` as its own project. `pio` is at `~/.platformio/penv/bin/pio`.
- Flash the CAM through the DevKit: IO0→GND, press CAM RST, `pio run -e cam -t upload --upload-port /dev/cu.usbserial-0001`; then remove IO0→GND and press RST.

## Packaging (0G judging point)
`@cpay/glasses-kit` ships firmware + hub + provisioning with a BOM, wiring diagram, pinout, flashing steps and a "plug and play" guide: flash → provision → Wi-Fi portal → pair code → done.
