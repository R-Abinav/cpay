# CPay ("See-Pay")

Smart glasses for private, hands-free payments: look at a QR, say *"pay 2 USDC"*, then say the confirm code only you can see.

> **"Your face picks you out but never identifies you."**

---

## Network & Chain Details

CPay uses **Base Sepolia** testnet for fast, low-cost micro-transactions:
* **Network Name**: Base Sepolia
* **Chain ID**: `84532`
* **RPC Endpoint**: `https://sepolia.base.org`
* **Block Explorer**: [https://sepolia.basescan.org](https://sepolia.basescan.org)
* **Circle USDC (Base Sepolia)**: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

---

## Architecture Overview

* **Frontend**: Next.js App Router (PWA) with client-side face recognition and QR scanning (`jsQR`).
* **AI Brain & Voice**: **0G Private Computer** (`whisper-large-v3` for speech-to-text, `glm-5.3` / `qwen-flash` for intent extraction) inside hardware-isolated TEEs.
* **Identity & Sybil Resistance**: **World ID** Proof of Human (IDKit 4.0) + World Agent Pass (human-in-the-loop step-up) + BBS anonymous credentials.
* **Database**: **Supabase PostgreSQL** via Prisma (stores ONLY anonymous World ID nullifiers + issuer keys).
* **Settlement**: **Base Sepolia** via Agent Wallet and one-time stealth addresses (`ERC-5564`).

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
