# @cpay/glasses-kit

The CPay glasses: two cheap ESP32 boards, three buttons and a tiny OLED, plus a small Node bridge on the payer's
Mac. Anyone with the parts below can flash it and plug it into the CPay web app.

- **ESP32-CAM** takes a centred JPEG when you press CAPTURE.
- **ESP32-C3** shows the payment state on the OLED and sends the button presses.
- **Bridge** (Node/TS) links both boards to the `/pay` web app over WebSockets. It forwards frames and button
  events, pushes OLED text back, and keeps nothing.

The glasses hold **no keys, no identities and no storage**. Voice goes through Bluetooth earbuds paired to the Mac,
not the glasses.

```
 ESP32-C3 (OLED + buttons) ──┐  Wi-Fi: phone hotspot (2.4 GHz)
                             ├──> ws://<mac>:8790/{c3,cam}   BRIDGE (Mac)   ws://localhost:8791 <── /pay web app
 ESP32-CAM (OV2640)        ──┘
```

## Bill of materials

| Qty | Part | Notes |
|---|---|---|
| 1 | ESP32-CAM with OV2640 camera and USB-C (AI-Thinker or a clone) | camera node; powers the C3 too |
| 1 | ESP32-C3 SuperMini (or similar ESP32-C3 mini board) | OLED + buttons |
| 1 | 0.96" 128×64 I²C OLED, 4-pin (SSD1306, or SH1106) | soldered to the C3 |
| 3 | momentary tactile push buttons | CAPTURE, CONFIRM, CANCEL |
| - | hook-up wire: 2 for power (5V, GND), 3 + a shared GND for the buttons | |
| 1 | USB-C cable + power bank / charger, **≥ 1 A** | one source powers both boards |
| 1 | glasses frame, perfboard, glue / zip ties | reliability over elegance |
| 1 | phone with a 2.4 GHz hotspot | venue Wi-Fi often isolates clients |
| 1 | Bluetooth earbuds paired to the Mac | voice in/out (not part of this kit) |

## Wiring

Full table, warnings and pin rationale: **[WIRING.md](./WIRING.md)**. All pins are **UNCONFIRMED** until checked
on the real boards.

| Connection | Pins (UNCONFIRMED) |
|---|---|
| Power | CAM **5V** → C3 **5V**, CAM **GND** → C3 **GND** (5V to 5V only, never to 3V3) |
| CAPTURE button | C3 **GPIO5** ↔ GND |
| CONFIRM button | C3 **GPIO6** ↔ GND |
| CANCEL button | C3 **GPIO7** ↔ GND |
| OLED | C3 SDA **GPIO8**, SCL **GPIO9**, addr **0x3C** (run `c3-i2c-scan` to confirm) |
| Camera | AI-Thinker pin map (run `cam-probe` to confirm) |

## Transport (how the pieces talk)

**WebSocket, boards dial out.** Each board keeps one WebSocket open to the bridge
(`ws://BRIDGE_HOST:8790/c3` and `/cam`). Why:
- Boards only make outbound connections, so nothing needs the ESP32's IP and there's no discovery to break.
- One socket carries both directions instantly (button up, OLED text down) with no polling.
- The firmware library (`links2004/WebSockets`) reconnects every 2 s and heartbeats every 5 s; the bridge pings
  devices every 5 s and drops dead ones, so both sides notice a dead link within ~10 s.

| Direction | Message |
|---|---|
| C3 → bridge | `{"t":"hello","role":"c3","fw":"0.1.0"}`, `{"t":"btn","e":"capture_down" \| "capture_up" \| "confirm" \| "cancel"}` |
| bridge → C3 | `{"t":"oled","lines":["VERIFIED HUMAN","2 USDC","OK?"]}` |
| bridge → CAM | `{"t":"capture","id":7}` |
| CAM → bridge | binary `[4-byte big-endian id][JPEG]`, or `{"t":"capture_error","id":7,"reason":"..."}` |

Optional shared token: set `BRIDGE_DEVICE_TOKEN` in `secrets.h` and in the bridge's env; devices then connect
with `?token=...` and anything else is rejected.

### Bridge ⇄ web app (`bridge/src/messages.ts`, zod, importable as `@cpay/glasses-kit`)

The bridge listens on `ws://127.0.0.1:8791` and only accepts browser Origins in `BRIDGE_ALLOWED_ORIGINS`
(default `http://localhost:3000`, `:3001`, and the `127.0.0.1` equivalents), so other websites can't read frames.

| Web app → bridge | |
|---|---|
| `{type:"oled", lines: string[]}` | 1-6 lines, ≤ 21 printable ASCII chars each. Use `oledStates.*()` |
| `{type:"capture_request"}` | ask for a frame without a button press |

| Bridge → web app | |
|---|---|
| `{type:"hello", protocol:1, devices:{c3,cam}}` | on connect |
| `{type:"device_status", devices:{c3,cam}}` | when a board connects/disconnects |
| `{type:"button", event, ts}` | `event` = `capture_down` / `capture_up` / `confirm` / `cancel` |
| `{type:"frame", id, mime:"image/jpeg", bytes, dataBase64, ts}` | after each `capture_down` (or `capture_request`) |
| `{type:"frame_error", id, reason, detail?}` | `cam_offline` / `busy` / `timeout` / `camera_error` / `bad_frame` |
| `{type:"error", reason}` | the bridge rejected a message from the web app |

```ts
import { BridgeToWeb, oledStates } from "@cpay/glasses-kit";

const ws = new WebSocket(process.env.NEXT_PUBLIC_BRIDGE_WS_URL ?? "ws://localhost:8791");
ws.onmessage = (ev) => {
  const msg = BridgeToWeb.parse(JSON.parse(ev.data));
  if (msg.type === "button" && msg.event === "capture_down") startRecording();
  if (msg.type === "frame") handleJpeg(msg.dataBase64); // embed locally, then drop it
};
ws.send(JSON.stringify(oledStates.verified("2", "USDC")));
```

When no web app is connected the bridge shows `NO APP` on the OLED.

## OLED states

Set by the web app (helpers in `oledStates`, `messages.ts`):

| State | OLED | Helper |
|---|---|---|
| ready | `READY` | `oledStates.ready()` |
| listening (CAPTURE held) | `LISTENING` | `oledStates.listening()` |
| confirm | `VERIFIED HUMAN / 2 USDC / OK?` | `oledStates.verified("2", "USDC")` |
| no match | `NO VERIFIED / RECIPIENT` | `oledStates.noVerifiedRecipient()` |
| paid | `PAID` | `oledStates.paid()` |
| cancelled | `CANCELLED` | `oledStates.cancelled()` |
| over cap (Agent Pass) | `APPROVE ON / PHONE` | `oledStates.approveOnPhone()` |
| 0G unreachable (safe-stop) | `BRAIN OFFLINE / PAUSED` | `oledStates.brainOffline()` |

Shown locally by the C3 / bridge: `NO WIFI` (C3 not on the hotspot), `NO BRIDGE` (on Wi-Fi but can't reach the
bridge), `NO APP` (bridge up, web app not connected), `CPAY / BOOTING`. A small dot in the top-right corner
means CAPTURE is held. Short states (≤ 3 lines of ≤ 12 chars) use a big font.

## Flashing (VS Code + PlatformIO, USB-C)

1. Install **VS Code** and the **PlatformIO IDE** extension. Open the folder
   `packages/glasses-kit/firmware` (it has its own `platformio.ini`).
   **Apple Silicon Macs:** the ESP32-C3 compiler that PlatformIO uses (riscv GCC 8.4) is Intel-only. Install
   Rosetta 2 once, or the C3 builds fail with `Bad CPU type in executable`:
   `softwareupdate --install-rosetta --agree-to-license`. (The ESP32-CAM compiler is native; no Rosetta needed.)
2. `cp include/secrets.example.h include/secrets.h` and fill in the hotspot SSID/password and the Mac's IP on
   the hotspot (`ipconfig getifaddr en0` on the Mac once it has joined the hotspot; iPhone hotspots use
   `172.20.10.x`). iPhone: turn on **Maximise Compatibility** so the hotspot is 2.4 GHz.
3. **Unplug the 5V wire between the boards** while flashing. Flash one board at a time.

Pick the env in the PlatformIO status bar (or sidebar → *Project Tasks* → env), then **Upload** and **Monitor**
(115200 baud). CLI equivalent: `pio run -e <env> -t upload -t monitor`.

**In this order:**

| # | Board | Env | What to look for |
|---|---|---|---|
| 1 | ESP32-C3 | `c3-i2c-scan` | `RESULT: -DPIN_OLED_SDA=.. -DPIN_OLED_SCL=.. -DOLED_I2C_ADDR=..`, and the same on the OLED. Copy into `[c3] build_flags` if it differs from 8 / 9 / 0x3C. Garbled/shifted text → add `-DOLED_SH1106=1`. |
| 2 | ESP32-CAM | `cam-probe` | `RESULT: use -DCAM_MAP_INDEX=<n>` and `sensor PID 0x26` (OV2640). Copy into `[cam] build_flags` if not 0. |
| 3 | ESP32-C3 | `c3-display` | OLED: `NO WIFI` → `NO BRIDGE` → `NO APP` once the bridge runs. Serial logs button presses. |
| 4 | ESP32-CAM | `cam` | Serial: `[cam] ready`, `[wifi] connected`, `[bridge] connected` |

Update the "Confirmed" boxes in `WIRING.md` as you go.

Upload trouble:
- **C3** "No serial port / failed to connect": hold **BOOT**, tap **RESET**, release BOOT, upload again. If the
  monitor shows nothing, press RESET once (USB CDC re-enumerates).
- **ESP32-CAM** "Failed to connect to ESP32": hold **IO0/BOOT** while pressing **RST** (or while plugging in), then
  upload; press RST afterwards to run. Boot loop with "Brownout detector was triggered" → better USB cable/supply
  (last resort: `-DCAM_DISABLE_BROWNOUT=1`).
- C3 won't join Wi-Fi: the firmware already lowers TX power (a known SuperMini antenna fix). Keep the phone close
  and make sure the hotspot is 2.4 GHz.

## Running the bridge (payer Mac)

```bash
cd packages/glasses-kit
npm install          # or: pnpm install at the repo root once the workspace exists
npm run bridge       # reads BRIDGE_HTTP_PORT (8790) and BRIDGE_WS_PORT (8791)
```

Env vars (all optional): `BRIDGE_HTTP_PORT=8790`, `BRIDGE_WS_PORT=8791`, `BRIDGE_DEVICE_TOKEN=` (must match
`secrets.h`), `BRIDGE_ALLOWED_ORIGINS=http://localhost:3000,...`.

On start it prints `device URL candidate: ws://<ip>:8790`: that `<ip>` goes in `secrets.h` as `BRIDGE_HOST`.
`curl http://localhost:8790/health` shows which boards are online. macOS may ask to allow incoming connections for
`node`: **allow it**, or the boards can't reach the bridge.

Plug-and-play order on demo day: phone hotspot on → Mac joins it → `npm run bridge` → power the glasses (one USB-C)
→ OLED goes `NO APP` → open `/pay` → OLED shows `READY`.

## Development

```bash
npm test             # vitest: message validation + routing with fake device sockets
npm run typecheck
npm run fw:build     # pio run for all envs (needs secrets.h)
npm run sim          # TEST/DEV ONLY: fake C3 + CAM (keys: c = capture, y = confirm, n = cancel)
```

`bridge/src/sim.ts` is a **test/dev-only** fake of both boards. It sends a placeholder JPEG (or `--jpeg file`).
It is never part of the demo path: the demo uses the real glasses.

## Privacy

- The bridge keeps no frames: each JPEG is base64'd into one WebSocket message to the web app and dropped.
- Logs carry metadata only (frame id, byte count, button names). Never image data.
- The only in-memory state is the last OLED lines (so a reconnecting C3 shows the right screen).
- The web side listens on 127.0.0.1 only and checks the browser Origin.
