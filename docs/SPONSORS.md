# Sponsor requirements + docs (checked 5 Nov 2026 against ethglobal.com/events/mumbai/prizes)

ETHGlobal rules: select **up to 3 partner prizes**; multiple tracks from one partner count as one. Demo video **2–4 min**, at least 720p, **no AI voiceover**. Document AI usage (which files AI generated, plus specs and prompts committed to the repo). Deadline **Sat 7 Nov 09:00 IST**.

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
  - store nullifiers yourself with UNIQUE(nullifier, action)
  - use `environment: "staging"` with the simulator
- Credentials: https://docs.world.org/world-id/credentials/1 (Proof of Human) · …/9303 (Passport) · …/11 (Selfie Check / Proof of Presence)
- Agent Pass / World IdP: https://auth.world.org/docs
  - human-in-the-loop guide: https://auth.world.org/docs/guides/human-in-the-loop
  - OIDC with PKCE; `max_age=0` or `prompt=login`; an essential `acr` claim (`https://world.org/oidc/acr/orb`, `…/selfie`, `orb-face`, `selfie-face`)
  - validate `state`, `nonce`, `acr`, `auth_time`
- Simulator: https://simulator.worldcoin.org · Developer Portal: https://developer.world.org

## 0G ($15k pool) — slot 2

**Physical AI: Agents with a Body ($5k: $2.5k / $1.5k / $1k for best real-hardware build)**. The "Personal devices (glasses…) with user memory on 0G Storage and sealed inference" lane is ours.
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

Submission for both: public repo + README, demo video **under 3 min** (0G's own rule, stricter than ETHGlobal's 4), a live demo link, contract addresses, and team contacts.

Docs:
- Router (OpenAI-compatible): base URL `https://router-api.0g.ai/v1`, `Authorization: Bearer sk-…` — https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
- Private Computer: https://pc.0g.ai
  - per-request header `X-0G-Provider-Trust-Mode: verified | private` (use **private**: TEE + E2E encryption + zero retention)
  - signed receipts; verification guide in `github.com/0gfoundation/0g-pc-e2ee`
  - **Where the request ID / receipt comes back isn't documented. Ask at the 0G booth; don't guess.**
- Models: https://pc.0g.ai/models (whisper-large-v3 is listed on the prize page for speech)
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

**Best Use of Anon-RPC ($5k)**: the app routes RPC reads through Anon-RPC by default.
- `@anon-rpc/browser-harness` (browser only) — `new AnonRpcWorker({ address: <specifier>, preExisting: { rpcProvider } })`, then `worker.fetch` as the transport for viem
- Live networks are on **mainnet**. **Check whether a Sepolia RPC URL works through `worker.fetch` before relying on it.**
- Docs: https://ethereum.github.io/anon-rpc/wallets/ · adopters: https://ethereum.github.io/anon-rpc/adopters/

Kohaku privacy SDK (Railgun, Privacy Pools): https://github.com/ethereum/kohaku. `@kohaku-eth/railgun` has a Sepolia shield/unshield demo; transfer/unshield need `@railgun-community/circuit-artifacts`. Marked unaudited / not production-ready.

## Chain facts (Ethereum Sepolia, chainId 11155111)

- ERC5564Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564`, ERC6538Registry `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`. We don't need either in lite mode (recipient-generated addresses), but they exist.
- Circle testnet USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` — **verify at https://faucet.circle.com before demo day.**

## Dropped (and why)

- **Whitechain:** every track must settle USDT on Whitechain Sepolia, and our privacy stack (Railgun/Kohaku) is on Ethereum Sepolia.
- **ENS:** public names would make recipients identifiable.
- **Uniswap / Arc / Hedera / Arkiv / 1inch / Chainlink / Definitive:** they don't fit the product.
