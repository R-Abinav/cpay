# @cpay/web

One Next.js app (webpack build), three parts:

| Path | Runs on | What |
|---|---|---|
| `/receive` | recipient's phone (HTTPS) | wallet-derived stealth keys, on-device face enrolment, World ID (IDKit, Proof of Human) → BBS card, relay listener, invisible toggle, QR claim |
| `/pay` | payer's laptop, `http://localhost:3000` | glasses bridge, earbud push-to-talk, 0G intent + voice, Agent Pass step-up, probe/claim, proof check, CONFIRM, 0G evidence panel, Privacy X-ray |
| `app/api/*` | payer's laptop (server) | the agent runtime. `app/api/pay` is the only code that reads `AGENT_WALLET_PRIVATE_KEY` (in `app/api/pay/agent-wallet.ts`) |

Env comes from the repo-root `.env` (see `.env.example`); `next.config.ts` loads it. Extra vars this app reads:
`ZG_EPISODE_KEY` (32-byte hex, encrypts 0G Storage episodes), optional `ISSUER_BBS_PUBLIC_KEY` (pins the issuer key; else fetched from `NEXT_PUBLIC_ISSUER_URL/issuer-key`), optional `ISSUER_URL`.

Every dependency that isn't wired or configured shows as **not connected** (badges on `/pay`, banners on `/receive`). 0G failures stop the run with **BRAIN OFFLINE - PAUSED**. Nothing is faked.

## Run (laptop)

```bash
pnpm install
pnpm relay                          # ws://localhost:8787
pnpm --filter @cpay/glasses-kit bridge   # ws://127.0.0.1:8791 (only accepts origin localhost:3000/3001)
pnpm web                            # http://localhost:3000  (copies onnxruntime-web into public/ort first)
```

Open `http://localhost:3000/pay`. Pick the earbuds as microphone and speaker. Without the glasses: hold **Space** = CAPTURE, **Enter** = CONFIRM, **Esc** = CANCEL (shown on screen), and tick "use this laptop's camera".

## `/receive` on a phone (HTTPS required)

The phone camera (`getUserMedia`) only works in a secure context, and an HTTPS page can only open `wss://` sockets. So the phone needs **HTTPS for the page and `wss://` for the relay**:

1. **Deployed (demo setup, `docs/STACK.md`)**: deploy `apps/web` to Vercel and run the relay behind TLS on the issuer host. Set on Vercel: `NEXT_PUBLIC_RELAY_URL=wss://<relay-host>`, `NEXT_PUBLIC_ISSUER_URL=https://<issuer-host>`, the `NEXT_PUBLIC_WORLD_*` vars; add the Vercel origin to the issuer's `ISSUER_ALLOWED_ORIGINS`. No server secrets are needed for `/receive`.
2. **Local, same Wi-Fi**: `pnpm --filter @cpay/web dev:https` serves `https://<laptop-ip>:3000` with a self-signed certificate (Next's `--experimental-https`, mkcert). Trust the mkcert root CA on the phone (or accept the warning), and point `NEXT_PUBLIC_RELAY_URL` at a `wss://` relay (e.g. a TLS tunnel to `localhost:8787`). Venue Wi-Fi often isolates clients; a phone hotspot works.
3. **Tunnel**: `cloudflared tunnel --url http://localhost:3000` (and one for the relay → use its `wss://` URL). Note the tunnel operator terminates TLS and sees traffic; prefer option 1 for the demo.

Open `/receive` in the wallet's in-app browser (MetaMask mobile etc.): step 1 needs an injected EIP-1193 wallet.

## Face model (self-hosted, same on both sides)

`public/models/`: YuNet 2023mar detector (MIT) + SFace 2021dec int8 embedder (Apache-2.0), both from OpenCV Zoo. Preprocessing is one shared module: `lib/face/geometry.ts` (letterbox 640×640 BGR → YuNet decode + NMS → 5-landmark similarity alignment to 112×112 → RGB CHW → SFace 128-d). See `public/models/README.md` for sources and hashes. Not InsightFace weights (non-commercial).

## Tests

`pnpm test` (root) runs `apps/web/test/*`: policy engine + ledger, units, face geometry, recipient probe handling against the real protocol (3 recipients, QR fallback), evidence merging.
