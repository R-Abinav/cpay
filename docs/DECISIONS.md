# Decision log: how we got here, and what we rejected

Read this before proposing a "better" design. Most alternatives were already considered.

## 1. Original idea (rejected as designed)
"Pay by looking at someone": the glasses recognise a face, a central server maps face → World ID → wallet, and the agent pays.

**Rejected after talking to the World team.** It permanently links a person's face to their financial identity. Anyone with the glasses could look at a stranger and see their balance and history, which defeats the anonymity World ID is built for.

## 2. Things World ID does and doesn't do
- World ID proves a **unique human**. It does not identify faces, reveal wallets or authorise payments.
- The proof reveals no identity, and its nullifier is scoped per app and action.
- World's Face Authentication checks the holder against their own Orb enrolment *inside World's system*. **It gives apps no face template**, so it can't power "recognise this person on the street".
- Never collect iris images or try to recreate World's verification.

## 3. Intermediate designs (rejected)
| Idea | Why rejected |
|---|---|
| Central DB of consenting users' face templates | It's a honeypot: one breach exposes every face↔payment link. Consent doesn't fix that. |
| Escrow contract between face and wallet | It only moves the mapping into the contract. |
| Face → stealth meta-address on our backend (ERC-5564) | The backend can still link every one-time address to the same face. |
| BLE discovery to find the person's phone | BLE signal strength can't tell which phone belongs to the face you're looking at. |
| Optical flash pairing (phone screen blinks) | Fragile, and the phone has to be visible. |
| Payer sends to the recipient's stealth meta-address (standard ERC-5564 sender flow) | The payer learns a stable meta-address and can link all their payments to one person. It also needs public announcements. |

## 4. Final design (the core insight)
- **Match on the recipient's own device.** The payer sends a *sealed* face embedding to nearby enrolled phones. Each phone compares it only with its own owner's template, and only the match replies.
- **The face is a pointer, not an identifier.** No face database exists.
- **Bonus from this:** a spoofed face (a photo held up) can only send money *to the real owner*.
- **Anonymous credential (BBS)** instead of identity. The issuer signs one card per World-verified human (nullifier-gated). Each presentation is a fresh, unlinkable zero-knowledge proof, bound to nonce + destination + chain + token + amount.
- **The recipient generates every one-time destination itself**, so the payer never sees anything stable.
- **QR code stays as the fallback** when there are zero or several responders.

## 5. Privacy dial (payer / recipient / amount)
| Level | What it hides | Tech | Status |
|---|---|---|---|
| 1 Lite | recipient | recipient-generated ERC-5564 address + gas drop | build first |
| 2 Full | payer + recipient + amount | Railgun 0zk→0zk via EF Kohaku (`@kohaku-eth/railgun`, Sepolia) | build if Lite is solid by Fri afternoon |
| Roadmap | compliant shielding | Privacy Pools (0xbow, EF Kohaku): payer funds from an association-set-approved pool | mention in pitch only |

Rejected for payments:
- **Tornado Cash.** US sanctions on the protocol were lifted in Mar 2025, but the Roman Storm retrial is pending (Apr 2027), so it looks bad with World and EF as sponsors. It also only takes fixed denominations, which can't express "2 USDC".
- **Fhenix FHE.** CoFHE went to mainnet on 21 Oct 2026 and hides amounts, but Railgun already hides amount + payer + recipient. It also isn't a sponsor and adds a decryption-network trust assumption.

## 6. Payer-side privacy leaks we acknowledged
- In Lite mode, the payer's wallet is public. Full mode fixes this.
- Recipients scanning their addresses leak them to the RPC provider. Fix: route reads through **Anon-RPC**.
- Nearby enrolled phones decrypt the probe embedding. It's sealed, short-lived and only sent after the voice command, but it does leave the payer's phone. **Disclose this.**

## 7. Stack decisions
- **One web app (Next.js PWA), not React Native.** RN's Hermes engine has no WebAssembly, and BBS + ONNX are WASM. The browser also gives camera, ONNX (onnxruntime-web) and WebSockets with no native code.
- **WebSocket relay for the demo**; BLE is roadmap (Web Bluetooth can't advertise from phones).
- **ESP32 does hardware only.** Heavy work (vision embedding, agent, chain) runs on the payer's laptop/phone via a small bridge.
- **Payments on Ethereum Sepolia.** The ERC-5564 contracts, Railgun/Kohaku and Circle USDC are all there.
- **The AI proposes, a deterministic policy engine decides, keys stay local.** 0G is "the brain, not the spinal cord". The agent never holds wallet keys.

## 8. Sponsor decisions
- **Chosen (3 partner slots):** World (IDKit + Agent Pass), 0G (Physical AI + Private Computer), EF (CROPS; Anon-RPC as a bonus).
- **Dropped:**
  - Whitechain: its tracks require USDT on Whitechain Sepolia, which our privacy stack isn't on.
  - ENS: public names deanonymise recipients.
  - Uniswap / Arc / Hedera / Arkiv / 1inch / Chainlink / Definitive: no real fit.
  - Base: not a prize sponsor at Mumbai.
