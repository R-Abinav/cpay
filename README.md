# CPay ("See-Pay")

Smart glasses for private, hands-free payments: look at a QR or face, say *"pay 2 USDC"*, then say the confirm code only you can see.

> **"Your face picks you out but never identifies you."**

---

## Network & Privacy Details (Ethereum Sepolia)

CPay runs on **Ethereum Sepolia** (testnet) with **ERC-5564 stealth (one-time) addresses**:

* **Chain ID**: `11155111` · **Explorer**: [https://sepolia.etherscan.io](https://sepolia.etherscan.io)
* **Circle USDC (Sepolia)**: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

---

## Privacy: what is true today

* **Recipient hidden (works)**: a CPay QR / face payment goes to a fresh one-time address the recipient's phone derives for that payment. The payer's agent wallet sends the USDC plus a small ETH gas drop to it, signed **on the payer's phone**.
* **Payer hidden with "Pay privately" (works, testnet alpha)**: payments come from the phone's **Railgun** private balance (Kohaku `@kohaku-eth/railgun` alpha.31 on Ethereum Sepolia; unaudited). The proof is made on the phone and the payment goes out as an ERC-4337 UserOperation from a fresh one-time account, gas sponsored by the Railgun privacy paymaster (fee paid from the shielded WETH), sent to Pimlico through our server. On-chain the destination gets the funds from Railgun, not from your agent wallet. A CPay QR / face recipient's one-time address also gets a small ETH gas drop from the shielded WETH in the same payment, so no public wallet funds it.
  * **Deposits are public**: topping up the private balance (shield) is a visible transfer from the agent wallet. Payments aren't directly linked to it, but similar amounts and timing can still link them.
  * **Testnet limit**: Sepolia's POI node never validates change notes, so each private payment spends a fresh, pre-deposited note (USDC + 0.25% fee, and WETH for the fee and gas drop). Deposits become spendable after ~1–4 min.
  * **If a payment can't be made privately** (low private balance, another token, or a Railgun error), the glasses show `PUBLIC` and the voice says "Private payment unavailable. Pay … publicly?" before you confirm. Private payments show `PRIVATE`.
* **Plain address QR**: a normal public USDC transfer from the agent wallet (or a private Railgun payment with "Pay privately").
* **Moving received funds**: "Send privately" pays from the one-time addresses directly; "Move to main wallet" publicly links the one-time address to your main wallet (the app warns you).
* **No server signer**: no server holds a user key or signs a payment.
* **Hosts the phone talks to**:

  | Host | When | What it learns |
  |---|---|---|
  | Sepolia RPC (`NEXT_PUBLIC_SEPOLIA_RPC_URL`) | always | the phone's IP, its transactions and balance/log reads |
  | `rail-squid.squids.live` (Railgun indexer) | only after your first private deposit, or a tap on "Load private balance" | that this IP syncs Railgun Sepolia (bulk history, no addresses) |
  | `ppoi.fdi.network` (Railgun POI node) | same | the IP + blinded commitments of your notes and their POI proofs |
  | `api.pimlico.io` (4337 bundler), via our `/api/bundler` | each private payment | the UserOperation (public on-chain anyway); Pimlico sees our server's IP, not yours. Our code logs nothing; the hosting platform may keep access logs |
  | Vercel (hosts the app + `/api/*`) | every request | your IP, user agent, path and timing, in Vercel's own request logs (we can't turn them off). Our code logs no request bodies |
  | Our EC2 (hub, relay, issuer, Railgun files) behind Caddy | glasses, payments, enrolment | connections only; Caddy keeps no access or error logs |

  Short spoken cues without an amount ("Scanning. Look at the QR code or the person you're paying.", "Nothing found to pay…") are pre-recorded clips served from our own origin (`/voice/*.mp3`), so they play at once. They were made **once, at build time**, with Google Gemini TTS from the fixed template text only (no user data, no amounts); the phone never contacts Google. Replies with an amount still go to 0G TTS with a request ID and receipt.

---

## Architecture Overview

* **Frontend**: Next.js App Router (PWA) with client-side face recognition and QR scanning (`jsQR`).
* **AI Brain & Voice**: **0G Private Computer** (`whisper-large-v3` for speech-to-text, `glm-5.3` / `qwen-flash` for intent extraction) inside hardware-isolated TEEs.
* **Identity & Sybil Resistance**: **World ID** Proof of Human (IDKit 4.0) + World Agent Pass (human-in-the-loop step-up) + BBS anonymous credentials.
* **Database**: **Supabase PostgreSQL** via Prisma, server-side only. Three tables and nothing else: `nullifiers` (one row per World-verified human), `glasses_units` (which glasses unit is paired to which anonymous phone token, hashed) and `zg_evidence` (0G request IDs, receipts, root hashes; no user data).
* **Settlement & Privacy**: **Ethereum Sepolia**, phone-signed transfers, one-time stealth addresses (`ERC-5564`).

---

## Quickstart

```bash
# 1. Install dependencies across the monorepo
pnpm install

# 2. Push Prisma database schema to Supabase
pnpm db:push

# 3. Start the Web App
pnpm --filter @cpay/web dev
# -> http://localhost:3000

# 4. Start the Issuer Backend (World ID verify & BBS)
pnpm --filter @cpay/issuer dev
# -> http://localhost:8788
```
