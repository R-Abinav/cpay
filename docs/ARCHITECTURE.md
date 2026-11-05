# CPay architecture

## Components

| Component | Runs on | Holds | Never holds |
|---|---|---|---|
| Glasses (ESP32-S3) | the payer's head | camera, mic, OLED, 2–3 buttons | identities, keys |
| Bridge | payer's laptop/phone (Node) | Wi-Fi link to glasses; forwards frames/audio to the payer app; drives the OLED | keys |
| Payer app (`apps/web` `/pay`) | payer's browser | embedding model, policy engine, BBS verifier, wallet/Railgun keys | anyone's face template or wallet |
| Recipient app (`apps/web` `/receive`) | recipient's phone browser | own face template, BBS card + holder secret, stealth keys, Railgun 0zk keys | anything about other people |
| Relay (`apps/relay`) | anywhere, anyone can run one | per-connection ephemeral pubkeys, ciphertext in flight | everything else |
| Issuer (`apps/issuer`) | our server | World RP signing key, BBS issuer key, used nullifiers | faces, wallets, payments |
| 0G Private Computer | 0G | intent inference in private mode | keys, faces |
| 0G Storage | 0G | encrypted episode logs + request IDs | plaintext PII |
| Ethereum Sepolia | chain | USDC transfers to one-time addresses / Railgun commitments | links to identities |

## (0) Recipient onboarding (once, about 60 s)

1. The recipient opens `/receive` on their phone.
2. Keys are derived on-device:
   - stealth keys: `keysFromSignature(walletSig)` over `KEY_DERIVATION_MESSAGE`, so they're recoverable from the wallet
   - BBS holder secret `s`
   - Railgun 0zk wallet (full mode)
3. Face enrolment: 5+ captures → embeddings → `buildTemplate()`. Store it encrypted in IndexedDB. It is never uploaded.
4. BBS blind commitment `C` to `s`.
5. World IDKit 4 with the **Proof of Human** credential, action `cpay-recipient-v1`, signal = `hash(C)`. The RP signature is generated server-side by the issuer.
6. The issuer:
   - forwards the IDKit payload as-is to `POST https://developer.world.org/api/v4/verify/{rp_id}`, checks `success` and `environment`, and checks signal == `hash(C)`
   - inserts `(nullifier, action)` with a UNIQUE constraint and rejects repeats
   - blind-signs `[s (hidden), tier=orb, epoch=YYYY-MM]` and returns σ
7. The recipient verifies σ and stores the card. Done.

Why Proof of Human (the IDKit judges ask for the "minimum sufficient credential"): every card lets a phone answer face probes. Sybil cards would mean fake claimants, so we need strict one-human-one-card. Selfie Check is medium assurance and doesn't guarantee that.

## (1)–(8) Payment

```
glasses --(frame, audio)--> bridge --> payer app
payer app: embed centred face locally; delete frame
payer app --(audio)--> 0G router, private mode --> {amount, token, mode} + request ID
payer app: policy(amount, token, chain, daily cap)
           over cap -> World Agent Pass step-up (OIDC, max_age=0, acr orb/orb-face) -> continue only if valid
payer app --payer.hello--> relay --peers[{peerId, pub}]--> payer app
payer app --probe{sessionId, payerPub, items[{peerId, sealed ProbeBody}]}--> relay --> each recipient
each recipient: open box -> cosine(embedding, own template) >= threshold ?
           no  -> stay silent (send nothing)
           yes -> destination = createOneTimeDestination(keys)  (or fresh 0zk address in full mode)
                  proof = BBS.prove(card, reveal[tier, epoch], hide[s], presentationHeader = bindingDigest(...))
                  --claim{sessionId, sealed ClaimBody}--> relay --> payer
payer app: openClaim (trial-decrypt against probed peers)
           exactly ONE valid claim within timeout, else abort -> QR fallback
           verify BBS proof against issuer public key + recomputed bindingDigest
bridge -> OLED: "verified human · 2 USDC · OK?"  (physical confirm/cancel)
settle:  lite: payToDestination(USDC + gas drop)   full: Railgun private transfer
log:     encrypt {decision, requestId, txHash, timestamps} with payer key -> 0G Storage; keep root hash
```

Message schemas: `packages/protocol/src/messages.ts`. Sealing: X25519 → HKDF-SHA256 → AES-256-GCM with context `probe:<sessionId>` / `claim:<sessionId>`.

## Modes

| | Lite (build first) | Full |
|---|---|---|
| Recipient hidden | yes: recipient-generated ERC-5564 address, no public announcement | yes: 0zk |
| Payer hidden | no (payer's wallet is public) | yes |
| Amount hidden | no | yes |
| Tech | `@cpay/stealth`, Circle USDC on Sepolia | `@kohaku-eth/railgun` on Sepolia (shield → private transfer); proofs need `@railgun-community/circuit-artifacts` |
| Gas for the recipient later | payer includes a gas drop | relayer/broadcaster |

## Who learns what (goes in the README CROPS "P" line)

| Party | Learns |
|---|---|
| Payer | "a verified human" + one-time destination |
| Issuer | one nullifier per human; nothing about payments |
| Relay | timing + ciphertext sizes |
| Nearby enrolled phones | the probe embedding (sealed to them; discarded after compare) — **known leak, disclose it** |
| Chain (lite) | an amount went to a fresh address |
| Chain (full) | a Railgun transaction happened |
| RPC provider | nothing linkable: reads go through Anon-RPC |
| 0G | intent text in a TEE (private mode, zero retention) |

## Threats and answers (for judge Q&A)

- **Spoofed face (photo held up):** the payment can only go to the *owner* of that face, because only their phone matches.
- **Lying phone claims every probe:** collides with the real owner → abort. Each card costs a real World ID, so sybil claimants are expensive. Spend caps limit losses. Future work: private fuzzy matching.
- **Replay or address swap:** the proof is bound to nonce + destination + chain + token + amount.
- **Stolen card:** someone who copies `s` and σ off a phone can act as that holder. Mitigation: device-bound storage. Disclose it.
- **0G down:** safe-stop. The OLED shows "brain offline — payments paused". No fallback decisions.

## Hardware notes

- ESP32-S3 (XIAO Sense or similar) + OV2640, SSD1306 128×64 I²C OLED, mic (I²S, e.g. INMP441), buttons: capture / confirm / cancel.
- Firmware: capture JPEG + ~4 s audio on button press, then POST to the bridge over Wi-Fi. The bridge pushes OLED text back (HTTP or WebSocket).
- Package it as `@cpay/glasses-kit` (firmware + bridge). "Plug and play if hardware is present" is a 0G judging point.

## Implementation notes (decisions already made)

**Stealth (`packages/stealth`)**
- Use `@scopelift/stealth-address-sdk` (scheme 1, secp256k1). Don't hand-roll EC maths.
- Keys: `generateKeysFromSignature(walletSig)` over a fixed `KEY_DERIVATION_MESSAGE`, which warns the user never to sign it elsewhere. The meta-address URI is `st:eth:0x<spendPub><viewPub>`.
- **The recipient generates each destination itself**: `generateStealthAddress` with its OWN meta-address and a random ephemeral key. It stores `{address, ephemeralPublicKey, viewTag}` locally.
  - The payer never sees the meta-address.
  - No on-chain `Announcement` is needed.
- Recover the spend key with `computeStealthKey`. Assert that `privateKeyToAccount(pk).address` equals the destination.
- Self-check with `checkStealthAddress`.
- Pay = ERC-20 `transfer` + a separate small ETH **gas drop** (~0.0003 ETH on Sepolia), so the one-time address can move funds later without being funded from a known wallet.
- Sweep = transfer the full balance out using the gas drop.
- Gotcha: the SDK's ESM build uses directory imports, which Node's ESM loader rejects. In vitest, set `test.server.deps.inline: ["@scopelift/stealth-address-sdk"]`. `tsx` and Next handle it fine.

**Sealing (`packages/protocol`)**
- X25519 (`@noble/curves`) → HKDF-SHA256 (`@noble/hashes`) with info `cpay/v1/<context>` → AES-256-GCM (`@noble/ciphers`) with a 12-byte random IV and the context as AAD.
- Contexts: `probe:<sessionId>`, `claim:<sessionId>`.
- Recipients rotate their X25519 key per relay connection. Payers use a fresh key per session.

**Binding digest**
- `sha256("cpay/v1/binding" ‖ lp(sessionNonce) ‖ lp(lower(destination)) ‖ lp(chainId) ‖ lp(lower(token)) ‖ lp(amount))`
- `lp(x)` = 4-byte big-endian length prefix + UTF-8 bytes.
- This is the BBS presentation header. Tests must show that changing any field breaks verification.

**Relay wire protocol** (zod-validated, max payload 256 KB)
- client → relay:
  - `recipient.hello{pub}`
  - `payer.hello`
  - `probe{sessionId(uuid), payerPub, items[{peerId, box{iv,ct}}]}`
  - `claim{sessionId, box}`
- relay → client:
  - `peers{peers[{peerId, pub}]}` (in reply to `payer.hello`)
  - `probe{sessionId, payerPub, box}` (one per recipient)
  - `claim{sessionId, box}` (routed to the session owner)
  - `error{message}`
- The relay maps sessionId → payer socket, caps open sessions per payer, and forgets everything on close. It never says who sent a claim, so the payer **trial-decrypts** each claim against the peers it probed. That also tells the payer which peer answered, so it can detect more than one responder.
- Sealed bodies:
  - `ProbeBody{v:1, sessionNonce(32-byte hex), embedding(base64 Float32), chainId, token, amount(base units), mode: lite|full}`
  - `ClaimBody{v:1, sessionNonce, destination, credentialProof}`
- The payer rejects a claim whose nonce doesn't match its session.

**Face matching**
- Cosine similarity.
- Template = L2-normalised mean of 5+ enrolment embeddings.
- Default threshold 0.6 until calibrated on the team. A false accept pays the wrong person; a false reject just falls back to QR.
- Same model and preprocessing on both sides. Reject an embedding-length mismatch.

**Web app**
- Next.js with `transpilePackages` for workspace packages.
- `webpack.resolve.extensionAlias = {".js": [".ts", ".tsx", ".js"]}`, because workspace TS uses `.js` import specifiers.
- `experiments.asyncWebAssembly = true` for BBS and ONNX.
- Runs on port 3000.

**Testing bar**
- An end-to-end relay test with 3 recipients: only the person being looked at replies; the payer opens exactly one claim; the destination belongs to that recipient and not the others.
