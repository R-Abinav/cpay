# CPay ("See-Pay")

Smart glasses for private, hands-free payments: look at a QR or face, say *"pay 2 USDC"*, then say the confirm code only you can see.

> **"Your face picks you out but never identifies you."**

---

## Network & Privacy Details (Ethereum Sepolia)

CPay operates on **Ethereum Sepolia** using the official, canonical **Railgun Smart Wallet** zero-knowledge pool combined with **ERC-5564 stealth addresses**:

* **Network Name**: Ethereum Sepolia
* **Chain ID**: `11155111`
* **RPC Endpoint**: `https://ethereum-sepolia-rpc.publicnode.com`
* **Block Explorer**: [https://sepolia.etherscan.io](https://sepolia.etherscan.io)
* **Circle USDC (Sepolia)**: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
* **Official Railgun Smart Wallet**: `0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea`

---

## Privacy Architecture: Dual-Sided Anonymity

* **Payer Hidden by Railgun**: The payer tops up and unshields funds from Railgun's communal zero-knowledge privacy pool via a Broadcaster. The payer's agent wallet never signs payment transactions on-chain and never pays gas directly.
* **Recipient Hidden by Stealth**: The recipient receives payments at a fresh, single-use ERC-5564 stealth address derived locally on their phone.
* **Default Exit**: Recipients choose **"Move to private balance"** to shield funds directly into their own private Railgun `0zk` wallet, preventing identity linkage.
* **Self-Hosted Circuits (Invariant 10)**: All circuit files and artifacts are self-hosted on the origin server (`/circuits/`). The SDK never contacts IPFS, CDNs, or third-party artifact hosts.

### What Network Participants Learn

| Actor | What They Learn | What Stays Private |
| :--- | :--- | :--- |
| **RPC** | Sees shield deposits into Railgun and unshield transfers from Railgun to the destination address. | Cannot link which shield deposit belongs to which unshield. Cannot link payer to recipient. |
| **Broadcaster (Relayer)** | Sees the recipient destination address and unshield amount to broadcast. | Never sees the payer's 0zk address, spending key, viewing key, or remaining pool balance. |
| **POI (Proof of Innocence)** | Verifies that unshielded funds do not originate from blacklisted/sanctioned deposits. | Never exposes user transaction history or identity graphs. |

---

## Architecture Overview

* **Frontend**: Next.js App Router (PWA) with client-side face recognition and QR scanning (`jsQR`).
* **AI Brain & Voice**: **0G Private Computer** (`whisper-large-v3` for speech-to-text, `glm-5.3` / `qwen-flash` for intent extraction) inside hardware-isolated TEEs.
* **Identity & Sybil Resistance**: **World ID** Proof of Human (IDKit 4.0) + World Agent Pass (human-in-the-loop step-up) + BBS anonymous credentials.
* **Database**: **Supabase PostgreSQL** via Prisma (stores ONLY anonymous World ID nullifiers + issuer keys).
* **Settlement & Privacy**: **Ethereum Sepolia** via official Railgun Smart Wallet and one-time stealth addresses (`ERC-5564`).

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
