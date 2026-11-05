# Sponsor requirements + docs (checked 5 Nov 2026 against ethglobal.com/events/mumbai/prizes)

ETHGlobal rules: select **up to 3 partner prizes**; multiple tracks from one partner count as one. Demo video **2–4 min**, at least 720p, **no AI voiceover**. Document AI usage (which files AI generated, plus specs and prompts committed to the repo). Official deadline **Sat 7 Nov 09:00 IST**; **our deadline is Fri 6 Nov 23:59 IST**.

**Priority:** World and 0G first (critical path), then EF CROPS. Anon-RPC is deferred.

Re-verified on 5 Nov 2026 against the live docs: prize amounts and requirements, IDKit endpoint, 0G router headers and models, Anon-RPC networks, Circle USDC address. Notes are inline, marked *(verified)*.

## World ($12.5k pool) — slot 1

**Best Use of IDKit ($2.5k, up to 2 teams × $1,250)**
- IDKit in a working app, with at least one credential (we use **Proof of Human**), verified **server-side**.
- Explain the trust moment and why this credential is the *minimum sufficient* one. Judges reward the credential decision.
- Demo a success **and** an alternative path (cancel / rejection / ineligible user).
- Include an integration debrief: time to first success, friction, missing docs, top improvement.

**World ID Agent Pass ($5k open: $2.5k / $1.5k / $1k)**
- A meaningful action that needs human approval: our over-cap payment.
- Show the full journey: request → user completes → backend validates → protected action. Also show a **denied / expired / cancelled path where nothing happens**.
- Validate in a secure backend; never expose secrets. Proofs are mocked by World for this track (fake identities), so no sandbox app is needed.
- Same integration debrief.

Docs:
- IDKit integrate guide: https://docs.world.org/world-id/idkit/integrate
  - packages `@worldcoin/idkit-core` / `@worldcoin/idkit` 4.x
  - RP signature on the backend via `signRequest` from `@worldcoin/idkit-core/signing`
  - verify via `POST https://developer.world.org/api/v4/verify/{rp_id}`, forwarding the payload as-is
  - store nullifiers yourself with UNIQUE(nullifier, action). *(verified)* Treat the nullifier as a uint256: convert the 0x hex to a number and store it as a decimal (we store a normalised decimal `TEXT` in Supabase Postgres)
  - check that `environment` in the verify response is the one you expect
  - use `environment: "staging"` with the simulator
- Credentials: https://docs.world.org/world-id/credentials/1 (Proof of Human) · …/9303 (Passport) · …/11 (Selfie Check / Proof of Presence)
- Agent Pass / World IdP: https://auth.world.org/docs
  - human-in-the-loop guide: https://auth.world.org/docs/guides/human-in-the-loop
  - OIDC with PKCE; `max_age=0` or `prompt=login`; an essential `acr` claim (`https://world.org/oidc/acr/orb`, `…/selfie`, `orb-face`, `selfie-face`)
  - validate `state`, `nonce`, `acr`, `auth_time`
- Simulator: https://simulator.worldcoin.org · Developer Portal: https://developer.world.org
- Agent Pass sandbox: issuer `https://sandbox.auth.world.org`, client registration at `sandbox.auth.world.org/portal`; the sandbox World ID app comes from the World team (TestFlight) and its credential issuance takes **~1 h**, so start early. Redirect URI in prod: `https://<cpay-web>/api/agent-pass/callback`.

## 0G ($15k pool) — slot 2

**Physical AI: Agents with a Body ($5k: $2.5k / $1.5k / $1k for best real-hardware build)**. The "Personal devices (glasses…) with user memory on 0G Storage and sealed inference" lane is ours.

How we satisfy it: the glasses + earbuds are the body; 0G is the ears (whisper), the brain (glm-5.3, private) and the voice (TTS). The agent acts with its own capped wallet, a World Agent Pass over the cap, and a physical confirm.
- A 0G call **inside the decision loop** (vision, voice or decision model).
- An **episode log on 0G Storage with a request ID per decision**.
- A replayable sim **or a live hardware demo at the 0G booth**.
- **A safe-stop fallback if 0G is unreachable. A fallback that fakes decisions is disqualifying.**
- Not wanted: a chatbot with a robot avatar, or 0G used only for logging.

**Build with 0G Private Computer ($5k)**
- Inference on 0G PC in the main flow, with request IDs.
- A working app judges can try.
- One sentence on what breaks without 0G.
- **iAI bonus:** users sign in with their 0G account (Privy app ID from 0G; **localhost ports 3000/3001/5173 only**) and their credits decrease as they use the app.

Not ours: "Keep Building on 0G" (continuity track) and "Agents That Pay for Themselves" ($2k).

Submission for both: public repo + README, demo video **under 3 min** (0G's own rule, stricter than ETHGlobal's 4), a live demo link, contract addresses, and team contacts.

Docs:
- Router (OpenAI-compatible): base URL `https://router-api.0g.ai/v1`, `Authorization: Bearer sk-…` — https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
  - OpenAPI spec: https://0gfoundation.github.io/0g-router/
  - endpoints we use: `POST /v1/audio/transcriptions` (ears), `POST /v1/chat/completions` (brain), `POST /v1/audio/speech` (voice, *verified*: body `{model, input, voice, response_format, speed}`; voices in `GET /v1/models` → `speech_capabilities.voices`)
  - we're getting **0G credits** for the hackathon, so all three run on our router key
- Private Computer: https://pc.0g.ai
  - per-request header `X-0G-Provider-Trust-Mode: standard | verified | private` (or body `provider.trust_mode`). Use **private**: TEE + E2E encryption + zero retention
  - **request ID** *(verified)*: the `X-Request-ID` response header on every response, also in the body as `x_0g_trace.request_id` (error bodies too)
  - signed receipts; verification guide in `github.com/0gfoundation/0g-pc-e2ee`. **The receipt field isn't in the router spec. Ask at the 0G booth; don't guess.**
  - **0G told us to show them request IDs + receipts for our inference.** We record both for every call and print them in logs. See "0G evidence" in `docs/STACK.md`.
- Models: https://pc.0g.ai/models. *(verified)* Private-mode models:
  - **Models are the teammate's choice (env).** `GET /v1/providers` on 5 Nov: `whisper-large-v3` private ✅; **`glm-5.3` verified only (no private provider)**; `0gm-1.0-35b-a3b` private ✅. Re-check before the demo; our "private inference" claim must match.
  - TTS models (`minimax-speech-2.6/2.8-turbo/-hd`, `minimax-speech-02-*`) are **not** private-mode. We send them template text only.
  - `0gm-1.0-35b-a3b`, `0gm-1.0-35b-a3b-sia`, `vela-2.0-9b`, `laya`, `qwen3-embedding-0.6b`/`-8b`, `z-image-turbo`
  - Confirm the IDs with `GET /v1/models` before hard-coding them.
- Storage TS SDK: `@0gfoundation/0g-storage-ts-sdk` + `ethers`
  - EVM RPC `https://evmrpc-testnet.0g.ai`, indexer `https://indexer-storage-testnet-turbo.0g.ai`
  - call `merkleTree()` before upload; keep the root hash
  - docs: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
- Faucet: https://faucet.0g.ai · Reference robot project: https://github.com/0gfoundation/zerobot

## EF ($15k pool) — slot 3. A project wins at most ONE EF prize.

**Best CROPS App ($3.5k: $2k / $1k / $500)**
- Public repo under a FOSS license (MIT), with a README explaining how to run it.
- A README section titled **CROPS**, 1–2 lines per letter:
  - C: what we control that users depend on, and what happens if it goes away
  - O: license; can users build and run it from the repo alone
  - P: what each third party learns
  - S: key/data protection and trust assumptions
- Demo video of 3 min or less showing the lead property (P) working end to end, including the moment it matters.
- **No third-party trackers or analytics in the client.** Keys and personal data stay on the device, or the README explains why not.

**Best Use of Anon-RPC ($5k)**: **DEFERRED.** We only win one EF prize, and CROPS is the target. The notes below are kept for the roadmap. The app would route RPC reads through Anon-RPC by default.
- `@anon-rpc/browser-harness` (browser only) — `new AnonRpcWorker({ address: <specifier>, preExisting: { rpcProvider } })`, then `worker.fetch` as the transport for viem
- *(verified)* The specifier contracts for Passthrough, Tor and Nym are on **mainnet**. There is one **Sepolia** network: Sphinx-packet over KPS, specifier `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`. Its bootstrap `rpcProvider` must answer for Sepolia.
- Docs: https://ethereum.github.io/anon-rpc/wallets/ · adopters: https://ethereum.github.io/anon-rpc/adopters/

Kohaku privacy SDK (Railgun, Privacy Pools): https://github.com/ethereum/kohaku. **Roadmap only.** `@kohaku-eth/railgun` is alpha. Its Sepolia demo is shield/unshield only. Private transfers need `@railgun-community/circuit-artifacts` (on Railgun's own npm registry), and there's no worked transfer example.

## Chain facts (Base Sepolia, chainId 84532)

- Circle testnet USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` *(verified 6 Nov 2026 on developers.circle.com/stablecoins/usdc-contract-addresses)*. Get test USDC at https://faucet.circle.com (pick Base Sepolia).
- Public RPC `https://sepolia.base.org` (rate-limited; use a provider URL for the demo if it throttles). Explorer: https://sepolia.basescan.org.
- No contracts of ours. ERC-5564 Announcer/Registry aren't needed (recipients generate their own one-time addresses).
- Previously Ethereum Sepolia (USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`); switched for ~2 s blocks. See `docs/DECISIONS.md` §12.

## Dropped (and why)

- **Whitechain:** every track must settle USDT on Whitechain Sepolia, and our privacy stack (Railgun/Kohaku) is on Ethereum Sepolia.
- **ENS:** public names would make recipients identifiable.
- **Uniswap / Arc / Hedera / Arkiv / 1inch / Chainlink / Definitive:** they don't fit the product.
