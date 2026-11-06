# Deploy: web on Vercel, backend on one EC2 instance

```
phone (PWA) ──https──> Vercel  apps/web  (pages + /api/intent /api/speak /api/transcribe /api/bundler
     │                                    /api/agent-pass/* /api/episode /api/evidence /api/status)
     │
     ├──wss──> hub.<domain>       ┐
     ├──wss──> relay.<domain>     │  EC2: Caddy (Let's Encrypt, ports 80/443 only)
     ├──https─> issuer.<domain>   │       -> hub:8790, relay:8787, issuer:8788 (Docker network only)
     └──https─> artifacts.<domain>┘       -> /srv/railgun-artifacts (static, CORS = the Vercel origin)
glasses ──wss──> hub.<domain>/device
Supabase Postgres: hub (glasses_units), issuer (nullifiers), web (zg_evidence)
```

Why the Railgun circuits live on EC2, not Vercel: they are ~225 MB (81 files, largest 27 MB), more than
Vercel's static upload limit on Hobby (100 MB, https://vercel.com/docs/limits#static-file-uploads), and a
GitHub download on every build. The web build sets `NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL` and only copies the
4 MB Kohaku WASM. The browser still fetches only our own hosts (invariant 10).

You need: a domain you control (below `example.org`), an AWS account, a Vercel account, the Supabase
URLs, and every secret you already have in the root `.env`. Pick the names first:

| What | Example | Used as |
|---|---|---|
| Vercel production domain | `https://cpay.vercel.app` | `WEB_ORIGIN`, passkey RP ID, Agent Pass redirect |
| Backend domain | `example.org` | `CPAY_DOMAIN` -> `hub.` / `relay.` / `issuer.` / `artifacts.example.org` |

**The passkey RP ID is permanent.** Passkeys are bound to the Vercel domain. Choose the production domain
once (project name or a custom domain) and never use preview URLs for the demo: a passkey made on one
domain does not exist on another, so the wallet would be "gone" there.

---

## 1. Vercel project (do this first: its domain goes into the backend config)

1. Vercel -> Add New -> Project -> import the GitHub repo.
2. **Root Directory**: `apps/web`. Framework preset: **Next.js** (auto-detected).
3. **Build and Output Settings**: leave every Override **off**. `apps/web/vercel.json` sets
   - Install: `bash ../../deploy/vercel-build.sh install` (pnpm 12.16.1 at the repo root; an override `pnpm install` would run pnpm 6)
   - Build: `bash ../../deploy/vercel-build.sh build` (Prisma client, `@cpay/database` dist, Kohaku WASM, `next build --webpack`)
   - Output: Next.js default (`apps/web/.next`)
4. Settings -> General: **Node.js Version 22.x**. Keep "Include files outside the root directory in the Build Step" **enabled** (default).
5. Settings -> Functions: Fluid compute on (default). **Function Region**: the one nearest your Supabase
   project (e.g. `bom1` Mumbai if Supabase is in `ap-south-1`). No `maxDuration` is needed: the default
   is 300 s on every plan (https://vercel.com/docs/functions/limitations#max-duration); 0G calls take
   30-45 s at most and the bundler proxy polls per request, not inside one request.
6. Note the production domain (Settings -> Domains). Add the environment variables in step 4 before the
   real deploy: `NEXT_PUBLIC_*` are inlined at build time, so changing one needs a **redeploy**.

Vercel limits checked against our routes:

| Limit | Vercel | Ours |
|---|---|---|
| Function request/response body | 4.5 MB (https://vercel.com/docs/functions/limitations#request-body-size) | audio <= 1 MiB (`MAX_AUDIO_BYTES`), episode <= 96 KiB, bundler <= 128 KiB |
| Function duration | 300 s default (Hobby max 300 s) | 0G <= 45 s |
| Function bundle | 250 MB uncompressed | Prisma engine + client traced in (`outputFileTracingIncludes`), circuits not in the bundle |
| Static upload | 100 MB Hobby / 1 GB Pro | ~29 MB public/ (models, ORT, Kohaku WASM) |

## 2. EC2 instance

1. Region: `ap-south-1` (Mumbai, next to the venue). AMI: **Ubuntu 24.04 LTS**. Type: **t3.small**
   (2 vCPU, 2 GiB; the image build needs ~1.5 GiB). Disk: **20 GiB gp3**.
2. Security group, inbound: **TCP 80** and **TCP 443** from `0.0.0.0/0` and `::/0`. Nothing else.
   Shell access through **EC2 Instance Connect / SSM Session Manager**, or open 22 to your own IP only
   while setting up and remove it afterwards. 80 is needed for Let's Encrypt HTTP-01 and the HTTPS redirect.
3. Allocate an **Elastic IP** and associate it (the DNS records must not change on reboot).
4. Install Docker:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 docker-buildx git
   sudo usermod -aG docker $USER && newgrp docker
   docker compose version
   ```

## 3. DNS

Four **A** records to the Elastic IP (TTL 300):

```
hub.example.org        A  <elastic-ip>
relay.example.org      A  <elastic-ip>
issuer.example.org     A  <elastic-ip>
artifacts.example.org  A  <elastic-ip>
```
On Cloudflare set them to **DNS only** (grey cloud): the glasses pin ISRG Root X1 (Let's Encrypt) and
Caddy needs port 80 reachable directly. Check with `dig +short hub.example.org` before step 5.

## 4. Configuration

### Backend (`deploy/.env` on the instance)

```bash
git clone <repo-url> cpay && cd cpay/deploy
cp backend.env.example .env && chmod 600 .env && nano .env
```
Fill in every name in `backend.env.example`:
`CPAY_DOMAIN`, `WEB_ORIGIN`, `DATABASE_URL`, `DIRECT_URL`, `HUB_TICKET_SECRET`,
`HUB_PAIRING_CODE_TTL_SECONDS`, `HUB_TICKET_TTL_SECONDS`, `ISSUER_BBS_PUBLIC_KEY`,
`RELAY_MAX_CONNS_PER_IP`, `RELAY_MAX_NEW_CONNS_PER_MIN_PER_IP`, `WORLD_ENVIRONMENT`, `WORLD_ENVIRONMENTS`, `WORLD_ACTION`,
`WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `ISSUER_BBS_SECRET_KEY`.

- `DATABASE_URL`: the Supabase **pooler** URL with `&connect_timeout=30&pool_timeout=30` appended (keep its existing query parameters, e.g. `pgbouncer=true`; use `?` instead of `&` if it has none).
- Put each value in **single quotes** (`DATABASE_URL='postgres://...'`): Compose would otherwise expand any `$` inside a password.
- `WEB_ORIGIN` = the Vercel origin exactly, `https://` and no trailing slash. It becomes `HUB_ALLOWED_ORIGINS`, `ISSUER_ALLOWED_ORIGINS` and the artifacts CORS origin.
- `HUB_TICKET_SECRET` must equal the Vercel value. `ISSUER_BBS_SECRET_KEY` must be the key you already issued cards with.
- The relay reaches the issuer on the private Docker network (`http://issuer:8788`); you do not set `ISSUER_URL` here.

### Vercel (Settings -> Environment Variables, scope **Production**)

Server only (never `NEXT_PUBLIC_`):

| Name | Value |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Supabase (same as the backend; `zg_evidence`) |
| `HUB_TICKET_SECRET` | same value as `deploy/.env` |
| `ZG_ROUTER_BASE_URL`, `ZG_ROUTER_API_KEY`, `ZG_TRUST_MODE`, `ZG_STT_MODEL`, `ZG_STT_TRUST_MODE`, `ZG_INTENT_MODEL`, `ZG_INTENT_TRUST_MODE`, `ZG_TTS_API_KEY`, `ZG_TTS_MODEL`, `ZG_TTS_VOICE`, `ZG_TTS_TRUST_MODE`, `ZG_TTS_FORMAT`, `ZG_VERIFY_TEE`, `ZG_TIMEOUT_MS`, `ZG_RATE_LIMIT_PER_MIN` | as in your root `.env` |
| `ZG_STORAGE_RPC_URL`, `ZG_STORAGE_INDEXER_URL`, `ZG_STORAGE_PRIVATE_KEY`, `ZG_EPISODE_KEY` | as in your root `.env` |
| `ISSUER_URL` | `https://issuer.example.org` |
| `ISSUER_BBS_PUBLIC_KEY` | issuer public key (optional; else fetched from `ISSUER_URL`) |
| `AGENT_PASS_ISSUER`, `AGENT_PASS_CLIENT_ID`, `AGENT_PASS_CLIENT_SECRET`, `AGENT_PASS_ACR`, `AGENT_PASS_APPROVAL_SECRET_KEY`, `AGENT_PASS_APPROVAL_TTL_SECONDS` | as in your root `.env` (sandbox issuer for the hackathon) |
| `AGENT_PASS_REDIRECT_URI` | `https://<vercel-domain>/api/agent-pass/callback` (also register it for the client in the World portal) |
| `AGENT_PAYMENT_CAP_USDC`, `AGENT_DAILY_CAP_USDC`, `AGENT_ALLOWED_TOKENS` | as in your root `.env` |
| `PIMLICO_API_KEY` | Pimlico key (bundler proxy) |
| `BUNDLER_ALLOWED_ORIGINS` | `https://<vercel-domain>` |
| `SEPOLIA_RPC_URL`, `GAS_DROP_WEI` | as in your root `.env` |

Browser (inlined at build; public by design, never a secret):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_PASSKEY_RP_ID` | `<vercel-domain>` (host only, e.g. `cpay.vercel.app`) |
| `NEXT_PUBLIC_HUB_URL` | `wss://hub.example.org` |
| `NEXT_PUBLIC_RELAY_URL` | `wss://relay.example.org` |
| `NEXT_PUBLIC_ISSUER_URL` | `https://issuer.example.org` |
| `NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL` | `https://artifacts.example.org/railgun-artifacts/` (the build refuses to run without it) |
| `NEXT_PUBLIC_ISSUER_BBS_PUBLIC_KEY` | issuer public key |
| `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_WORLD_ACTION`, `NEXT_PUBLIC_WORLD_ENVIRONMENT`, `NEXT_PUBLIC_WORLD_ENVIRONMENTS` (e.g. `production,staging`, same as the issuer's `WORLD_ENVIRONMENTS`), `NEXT_PUBLIC_REQUIRED_TIER` (`orb,staging` while testing with the World simulator; `orb` only in production) | as in your root `.env` (`WORLD_ACTION` must match the issuer) |
| `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_WETH_ADDRESS`, `NEXT_PUBLIC_RAILGUN_ADDRESS`, `NEXT_PUBLIC_GAS_DROP_WEI` | as in your root `.env` |
| `NEXT_PUBLIC_AGENT_PAYMENT_CAP_USDC`, `NEXT_PUBLIC_AGENT_DAILY_CAP_USDC`, `NEXT_PUBLIC_DEFAULT_PAYMENT_CAP_USDC`, `NEXT_PUBLIC_DEFAULT_DAILY_CAP_USDC`, `NEXT_PUBLIC_ALLOWED_TOKENS`, `NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY`, `NEXT_PUBLIC_FACE_MATCH_THRESHOLD`, `NEXT_PUBLIC_CLAIM_TIMEOUT_MS` | as in your root `.env` |

Do not set `NODE_ENV`: Vercel runs builds and functions with `NODE_ENV=production`, which makes the 0G
routes require a hub ticket.

## 5. Start the backend

```bash
cd ~/cpay/deploy
docker compose up -d --build          # first build ~5 min
docker compose logs -f artifacts      # wait for "railgun artifacts: 81 fetched, 0 kept (81 files)"
docker compose ps                     # hub, relay, issuer, caddy: running / healthy; artifacts: exited (0)
docker compose logs caddy | grep -i certificate   # "certificate obtained successfully" x4
```
Update later: `git pull && docker compose up -d --build`. Certificates live in the `caddy-data` volume;
do not delete it (Let's Encrypt rate limits). The services keep no state on disk.

## 6. Deploy the web

Vercel -> Deployments -> Redeploy (after all env vars are set). The build log ends with the route table.

## 7. Reflash the glasses

The `cam` env has the Render host compiled in; use `cam-tunnel` (TLS on 443, path `/device`) with your host:
```bash
cd packages/glasses-kit/firmware
CPAY_HUB_HOST=hub.example.org ~/.platformio/penv/bin/pio run -e cam-tunnel -t upload
```

## 8. Smoke checks

```bash
curl -s https://hub.example.org/health        # {"ok":true}
curl -s https://relay.example.org/health      # {"ok":true}
curl -s https://issuer.example.org/health     # {"ok":true,"environment":"staging"}
curl -sI -H "Origin: https://<vercel-domain>" \
  https://artifacts.example.org/railgun-artifacts/railgun/01x01/wasm.br
  # 200, access-control-allow-origin: https://<vercel-domain>, cache-control: public, max-age=31536000, immutable
curl -s https://<vercel-domain>/api/status
```
Then on the phone, on the production domain only:
1. Onboarding: create the passkey (the prompt shows `<vercel-domain>`), World verify (issuer), card stored.
2. Settings -> pair glasses: the OLED code links the unit (hub writes `glasses_units`); Pay unlocks while the glasses are online.
3. Pay once end to end. Evidence page lists the 0G request IDs **as stored** (if it says not stored, the
   Prisma engine was not found: check the function log for `evidence DB unavailable`).
4. An over-cap payment through World Agent Pass (start -> World App -> callback -> status). See the risk below.

### Known risk on Vercel: in-memory state

Agent Pass attempts (`packages/world/src/agent-pass.ts`), the per-ticket 0G rate limit and the bundler
rate limit live in process memory (by design: nothing persisted). On Render that was one long-running
process. On Vercel, all our API routes have the same config so they are bundled into one function, and
Fluid compute reuses warm instances, so one demo user normally hits one instance. Vercel does not
guarantee it, though: if a callback lands on a different instance, Agent Pass answers "unknown or expired
attempt". Test step 8.4 right after deploying. If it fails, the fallback is to retry (a warm instance
usually serves it); the real fix is a shared store, which would need a privacy review (it must hold only
the salted commitment and the attempt id).

## Privacy checklist (before the demo)

- [ ] Caddy: no `log` directive in any site (no access logs); the default logger excludes `http.log.access`, `http.log.error`, `http.stdlib` (these carry client IPs / headers). `docker compose logs caddy` shows only startup + certificate lines.
- [ ] Hub / relay / issuer logs: `docker compose logs hub relay issuer` show only `listening`, `store=postgres`, and issuer `METHOD /path STATUS` lines. No bodies, IPs, user agents or wallet addresses.
- [ ] Docker log rotation on (10 MB x 3 per container, `json-file`).
- [ ] Only the listed tables exist in Supabase: `nullifiers`, `glasses_units`, `zg_evidence`.
- [ ] Secrets only in `deploy/.env` (mode 600, gitignored) and Vercel env vars. None in the image (`Dockerfile.dockerignore` drops every `.env`), none in `NEXT_PUBLIC_*`.
- [ ] Each container gets only its own variables (`environment:` lists in `docker-compose.yml`).
- [ ] `NODE_ENV=production` on hub / relay / issuer (set by compose) and on Vercel (automatic): 0G routes refuse calls without a hub ticket; issuer refuses to run without Postgres.
- [ ] Security group: inbound 80 + 443 only. Hub, relay and issuer ports are not published (`expose` only).
- [ ] Artifacts CORS allows only `WEB_ORIGIN`; the browser contacts only Vercel + our four subdomains (+ the RPC hosts listed in `packages/railgun/README.md`).
- [ ] Vercel: no Web Analytics / Speed Insights enabled (third-party-free client, invariant 10). Our functions log no content; runtime logs are kept 1 h on Hobby. Disclose that Vercel, like Render before, keeps its own platform request logs (we cannot turn those off); the EC2 edge keeps none.
- [ ] Run the `privacy-reviewer` agent on this branch before merging into `main`.
