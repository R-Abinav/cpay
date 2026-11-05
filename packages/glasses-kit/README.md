# @cpay/glasses-kit

The CPay glasses: **one ESP32-CAM** (camera + a tiny OLED, no buttons) that connects over Wi-Fi to the
**glasses hub** (Render), which forwards its frames to the paired phone and the phone's OLED text back.
Anyone with the parts below can build, flash and pair one.

```
 ESP32-CAM (GC2145 + OLED) ── Wi-Fi ──> wss://<hub>/device  ── glasses hub ──  wss://<hub>/phone <── CPay PWA
```

- The glasses hold **no keys, no payment data and no storage**. The only thing in flash is the unit's
  `unit_id` + random `unit_secret` (written once by `provision`), used to authenticate to the hub.
- The camera streams only while the phone asks (`stream{on}`); a dot in the OLED's top-right corner shows it.
  Frames are encoded, sent and freed one at a time: never queued, never retried, never stored.
- Wire contract: [`hub/src/messages.ts`](./hub/src/messages.ts). `bridge/` is the old laptop bridge (legacy).

## Bill of materials

| Qty | Part | Notes |
|---|---|---|
| 1 | ESP32-CAM, AI-Thinker pin map (clones fine), with PSRAM | GC2145 or OV2640 sensor |
| 1 | 0.96" 128×64 I²C OLED, 4-pin, SSD1306 @ 0x3C | |
| 1 | ESP32 DevKit (CP2102, USB-C), EN tied to GND | USB power + USB-serial for flashing/logs |
| - | jumper wires, glasses frame, glue / zip ties | |
| 1 | USB-C supply / power bank, **≥ 1 A** | |
| 1 | phone with a 2.4 GHz hotspot | venue Wi-Fi often isolates clients |

## Plug and play

### 1. Wire it
Full tables, warnings and pin rationale: **[WIRING.md](./WIRING.md)**. In short:

| From | To |
|---|---|
| DevKit 5V / GND / RX0 / TX0 | CAM 5V / GND / U0R / U0T |
| DevKit EN | DevKit GND (holds the DevKit's own ESP32 off) |
| OLED VCC / GND / SDA / SCL | CAM 3V3 / GND / **IO15** / **IO14** |
| CAM IO0 | CAM GND **only while flashing** |

### 2. Flash
Needs PlatformIO (`~/.platformio/penv/bin/pio`, or the VS Code extension). From `firmware/`:

```bash
# IO0 -> GND, press CAM RST, then:
~/.platformio/penv/bin/pio run -e cam -t upload --upload-port /dev/cu.usbserial-0001
# remove IO0 -> GND, press CAM RST
```

The hub address is baked in at build time (`[hub_render]` in `platformio.ini`, default
`wss://cpay-hub.onrender.com/device`). For a hub on your laptop (`pnpm hub`):
`CPAY_HUB_HOST=<laptop-ip> pio run -e cam-local -t upload ...` (plain `ws://<ip>:8790/device`).

### 3. Provision (once per unit)
With the `cam` firmware running (OLED: `NOT PROVISIONED`):

```bash
pnpm --filter @cpay/glasses-kit provision --port /dev/cu.usbserial-0001
# -> provisioned unit cpay-1a2b3c4d (the board reboots now)
```

It generates `cpay-<8 hex>` + a random 32-byte secret, writes both into the board's NVS and prints only the
unit id. The secret is never printed or saved on the computer. Re-running it gives the board a new identity.

Serial console (115200, the same port): `INFO` (unit id + firmware version, never the secret), `WIFIRESET`
(forget the saved Wi-Fi and reboot), `PROVISION <unitId> <secretHex64>`.

### 4. Wi-Fi
On first boot (or when the saved network has failed for 30 s) the OLED shows `WIFI SETUP / CPay-Glasses-XXXX`.
Join that open network from your phone, pick your hotspot and type its password in the captive page. The
portal closes after 180 s and retries the saved network. iPhone hotspot: turn on **Maximise Compatibility**
(2.4 GHz).

### 5. Pair
Once on Wi-Fi the unit connects to the hub. A new unit shows `PAIR CODE` and a 6-character code: type it in
the PWA in **Settings**. The OLED then shows `PAIRED`, and from then on whatever the phone
sends (`READY`, `SCANNING...`, `PAY 2 USDC / SAY CONFIRM 4821`, ...).

## OLED states

| OLED | Meaning |
|---|---|
| `BOOTING` | starting |
| `NOT PROVISIONED` | run step 3 |
| `CAMERA ERROR` (2 s at boot) | camera didn't start; the unit still goes online, streaming won't work |
| `WIFI SETUP / CPay-Glasses-XXXX` | captive portal open (step 4) |
| `NO WIFI` | reconnecting to the saved network |
| `NO HUB` | on Wi-Fi, hub unreachable or not authenticated yet (retries every 2 s) |
| `PAIR CODE / ABC234` | unpaired: type the code on the phone |
| anything else | pushed by the paired phone (`oledStates` in `hub/src/messages.ts`) |
| dot, top-right | the camera is streaming to the hub |

## Firmware notes

| Item | Value |
|---|---|
| Envs | `cam` (production), `cam-local` (laptop hub, no TLS), `cam-probe` (pin-map/sensor diagnostic), `devkit-oled-test` |
| Camera | RGB565 QVGA → software JPEG (`frame2jpg`, quality `CAM_JPEG_QUALITY`=70 on a 1–100 scale), up to the hub's `fps` (default 5) |
| Hub auth | `challenge{nonce}` → `auth{unitId, fw, mac}`, `mac = hex(HMAC-SHA256(sha256(secret_bytes), "cpay/v1/device-auth:" + nonceHex))`; `register{unitId, secret}` once, only when the hub asks |
| Status | `status{rssi, heap, fps}` every 5 s |
| Privacy failsafe | the camera stops on `stream{off}`, on hub disconnect, or 20 s after the last `stream{on}` |
| TLS | server certificate is **not** verified yet (hackathon TODO: pin the hub CA) |
| Brownout loop | better cable/supply; last resort `-DCAM_DISABLE_BROWNOUT=1` |
| Upside-down image | `-DCAM_VFLIP=1` / `-DCAM_HMIRROR=1` |

## Development

```bash
pnpm --filter @cpay/glasses-kit fw:build   # pio run -e cam
pnpm --filter @cpay/glasses-kit test
```
