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
* **Payer not hidden yet**: the payer's agent wallet is visible on-chain as the sender. Payer hiding via Railgun is **in progress** and not wired into the app; we don't claim it.
* **Plain address QR**: a normal public USDC transfer from the agent wallet.
* **Moving received funds**: "Send privately" pays from the one-time addresses directly; "Move to main wallet" publicly links the one-time address to your main wallet (the app warns you).
* **No server signer**: no server holds a user key or signs a payment.

---

## Architecture Overview

* **Frontend**: Next.js App Router (PWA) with client-side face recognition and QR scanning (`jsQR`).
* **AI Brain & Voice**: **0G Private Computer** (`whisper-large-v3` for speech-to-text, `glm-5.3` / `qwen-flash` for intent extraction) inside hardware-isolated TEEs.
* **Identity & Sybil Resistance**: **World ID** Proof of Human (IDKit 4.0) + World Agent Pass (human-in-the-loop step-up) + BBS anonymous credentials.
* **Database**: **Supabase PostgreSQL** via Prisma (stores ONLY anonymous World ID nullifiers + issuer keys).
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
