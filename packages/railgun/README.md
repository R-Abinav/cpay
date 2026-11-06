# @cpay/railgun

The phone's private balance. It is real Railgun on Ethereum Sepolia, built on `@kohaku-eth/railgun@0.0.1-alpha.31` (alpha, unaudited). Nothing is mocked.

- **Keys:** `seed = deriveKeys(root).railgunSeed` (HKDF-SHA256, info `cpay/v1/railgun`, in `@cpay/wallet`). Then `entropyToMnemonic(seed)` goes into Kohaku's `MnemonicKeystore`, which derives the Railgun BIP-32 spending and viewing keys (index 0). The seed and keys stay in the page's memory and are never stored or sent.
- **Shield:** `prepareShield` returns `[wrap?, approve?, shield]` as `TxData`. The agent wallet signs them on the phone. For WETH, the wrap (`WETH.deposit`) covers only the shortfall.
- **Pay:** `pay` unshields USDC to `to` through an **ERC-4337 UserOperation**:
  - It's sent from a **fresh, never-funded EIP-7702 account for each payment**. That key is generated in memory and dropped after signing.
  - Gas is sponsored by the Railgun **privacy paymaster**. Its fee comes out of the **shielded WETH** balance.
  - It goes through our `/api/bundler` proxy to Pimlico.
  - The recipient gets exactly `amount`, and the 0.25% unshield fee is added on top.
  - `pay` returns the **on-chain transaction hash** from the UserOperation receipt, after checking the receipt on chain.
  - There is no fallback: no wallet of ours ever signs or pays gas for an unshield.
  - **Gas drop (`gasDropWei`)**: for a one-time recipient address, the same UserOperation also delivers native ETH. USDC and WETH are unshielded to the fresh 7702 account, which unwraps the WETH (`WETH.withdraw`, Kohaku's native-unshield prefix) and forwards the USDC and the ETH to the destination. The ETH comes from the shielded WETH, so no public wallet funds the recipient.
- **`canPay({amount, gasDropWei})`**: true only if POI-valid USDC covers `amount` + 0.25% and POI-valid WETH covers the paymaster fee reserve (`FEE_RESERVE_WEI`, 0.004; a payment cost ~0.0028 ETH at ~1.1 gwei) plus the gross gas drop. Pure math in `src/needs.ts`.
- **POI:** POI is on (Kohaku default). Only notes the POI node marks `Valid` can be spent. `balances()` shows those as `valid`; every other status (`ProofSubmitted`, `Missing`, `ShieldBlocked`) shows as `pending`.
- **Known limit (Sepolia, 6 Nov 2026): change notes never become spendable.**
  - Kohaku does queue POI proofs for the outputs of a 4337 payment: both the unshield and the WETH fee transfer show "Waiting for txid to be indexed".
  - Its txid indexer (Subsquid) returns 0 operations, and its synced block stays frozen at 12076122. The POI node's own validated txid index is also stuck at leaf 4844. The proofs are never accepted, and an older queued one is rejected with "Invalid proof".
  - So USDC change and WETH fee change stay `pending` (`Missing`). **Every payment needs fresh shield-origin `Valid` notes:** USDC covering the amount plus 0.25%, and a WETH note for the fee (about 0.002 WETH was used per payment).
  - Shield ahead of time: the testnet POI standby took about 100 s.
- **Sync:** `sync()` is incremental. At most once a minute it rebuilds the provider from storage after moving the stored scan pointers back `TAIL_BLOCKS` (50) blocks, which covers events the Subsquid indexer reported but hadn't served yet. railgun-rs doesn't dedupe replayed notes (on Sepolia this doubled balances), so after a rescan we drop duplicate `(tree, leaf)` notes and rebuild from storage. All edits to stored state are lossless text edits, because note values exceed 2^53. See `src/tail.ts`.
- **Web Worker:** Kohaku's sync and Groth16 proving are long synchronous WASM runs. On the main thread of headless Chromium one sync blocked it for ~24 s in total, in tasks of up to 2.7 s. So the PWA runs the client in a dedicated worker: `serveRailgun(self, initRailgun)` in the worker, and `connectRailgun(worker, cfg)` from `@cpay/railgun/worker-client` on the page (that entry never imports Kohaku). Both sides check every message (`src/worker-protocol.ts`).
  - The seed crosses once, in the `init` message (`postMessage`, same origin), and lives only in the worker's memory. Locking the wallet terminates the worker.
  - Storage stays on the page: the worker asks the page for each `get`/`set`, so the encrypted vault is unchanged.
  - The artifact `fetch` rewrite is installed inside the worker, where the WASM runs.
  - Measured with the same test seed: 0 long tasks on the page during init, sync, and a full private payment (worst event-loop gap 54 ms).
- **Storage:** `RailgunStorage` receives Kohaku's scan state. That includes decrypted notes, so it must stay on the device, wrapped like the rest of the vault.

## Hosts contacted

| Host | From | What it learns |
|---|---|---|
| our origin `/railgun-artifacts/*`, `/railgun/kohaku_bg.wasm` | browser | which circuit sizes are used (static files) |
| our origin `/api/bundler` → `api.pimlico.io` (server-side, our key) | browser → our server → Pimlico | the UserOperation: fresh 7702 sender, proof, unshield destination and amount (public on-chain anyway). Only our web origin may call the proxy. Our code logs nothing; the hosting platform may keep access logs. Pimlico sees our server's IP, not the phone's. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` host (e.g. `ethereum-sepolia-rpc.publicnode.com`) | browser | `eth_getLogs` over the Railgun contract, calls, and the smart-account nonce/code reads. The phone's IP. |
| `rail-squid.squids.live` (Railgun Subsquid indexer, hard-coded in Kohaku) | browser (WASM) | that this IP syncs Railgun Sepolia (bulk history queries, no addresses) |
| `ppoi.fdi.network` (Railgun POI aggregator node, hard-coded in Kohaku) | browser (WASM) | blinded commitments of this wallet's notes (POI status queries) and POI proofs for its change notes. The phone's IP. |

Nothing else is contacted. Run `pnpm --filter @cpay/railgun prove:4337` to see the observed host list. The GitHub artifact URL baked into the WASM is rewritten to our origin by a `fetch` wrapper (`src/artifacts.ts`), so GitHub is never contacted at runtime. Subsquid stays on because an RPC-only first sync from the 2024 deployment block isn't viable on a phone.

## Artifacts (self-hosted, invariant 10)

`pnpm --filter @cpay/railgun artifacts` downloads every circuit Kohaku can request into `apps/web/public/railgun-artifacts/railgun/`, about 225 MB of Brotli files:
- transact `01x01`…`05x05`
- POI `poi/03x03` and `poi/13x13`

It also copies Kohaku's WASM to `apps/web/public/railgun/kohaku_bg.wasm`. The source is pinned to one commit of `Robert-MacWha/privacy-protocol-artifacts`, and every file is checked against its git blob SHA-1 (`scripts/artifacts.manifest.json`). Both output folders are gitignored. The Render `cpay-web` build runs this script before `next build`.

## Proving it on Sepolia

```bash
pnpm --filter @cpay/railgun artifacts
SHIELD=0.5 pnpm --filter @cpay/railgun prove:4337   # fresh USDC shield (dev wallet signs the TxData)
PAY=0.2 pnpm --filter @cpay/railgun prove:4337      # wait for POI Valid, then pay via 4337
SHIELD_WETH=0.006 PAY=0.2 GAS_DROP=0.0005 pnpm --filter @cpay/railgun prove:4337   # pay + ETH gas drop
```

The script serves `apps/web/public` and the real `/api/bundler` handler from localhost and uses a fixed TEST seed. It reads the dev key and the Pimlico key from `apps/web/.env` and never prints them. Scan state goes to `scripts/.state/` (gitignored).
