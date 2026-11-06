# Railgun on Ethereum Sepolia: research notes (6 Nov 2026)

Scope: Ethereum Sepolia (chainId 11155111), Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, browser/PWA client.
Method: primary sources (Railgun repos and docs, Kohaku repo, the npm package installed in this repo) plus live reads against Sepolia and the POI node on 6 Nov 2026. Where docs are silent, this says so. Nothing here is guessed.

Sources used throughout:
- [S1] Railgun shared-models network config: https://github.com/Railgun-Community/shared-models/blob/main/src/models/network-config.ts
- [S2] Railgun shared-models POI constants: https://github.com/Railgun-Community/shared-models/blob/main/src/models/proof-of-innocence.ts
- [S3] `@kohaku-eth/railgun@0.0.1-alpha.31` as installed in this repo (`packages/railgun/node_modules/@kohaku-eth/railgun`: `sdk/plugin.ts`, `sdk/unshield-calls.ts`, `dist/pkg/index.d.ts`, wasm). Its Sepolia config came from calling the package's own `chainConfigSepolia()`.
- [S4] Kohaku repo: https://github.com/ethereum/kohaku (README, `packages/railgun/README.md`, `packages/provider/src/anon/index.ts`, `examples/anon-rpc-poc`)
- [S5] Railgun wallet SDK artifacts: https://github.com/Railgun-Community/wallet/blob/main/src/services/artifacts/artifact-util.ts and `artifact-downloader.ts`
- [S6] Railgun broadcaster docs: https://docs.railgun.org/developer-guide/wallet/broadcasters
- [S7] Waku broadcaster client (web) README: https://cdn.jsdelivr.net/npm/@railgun-community/waku-broadcaster-client-web@9.1.1/README.md
- [S8] Broadcaster software: https://github.com/Railgun-Community/ppoi-safe-broadcaster-example
- [S9] PPOI docs: https://docs.railgun.org/wiki/assurance/private-proofs-of-innocence.md
- [S10] Engine start docs: https://docs.railgun.org/developer-guide/wallet/getting-started/5.-start-the-railgun-privacy-engine.md
- [S11] Prover docs: https://docs.railgun.org/developer-guide/wallet/getting-started/6.-load-a-groth16-prover-for-each-platform.md
- [S12] Railgun engine source: https://github.com/Railgun-Community/engine (`src/contracts/relay-adapt/V2/relay-adapt-v2.ts`, `src/note/shield-note.ts`)
- [S13] anon-rpc: https://github.com/ethereum/anon-rpc, `docs/integrate-wallet.md`, `adopters.json5`, https://ethereum.github.io/anon-rpc/adopters/
- [S14] Render web services: https://render.com/docs/web-services
- [L] Live on-chain reads via `https://ethereum-sepolia-rpc.publicnode.com` and `https://ppoi.fdi.network/` (`ppoi_node_status`), 6 Nov 2026.

---

## 1. Official Railgun deployments on Sepolia

| Contract | Address | Source |
|---|---|---|
| RailgunSmartWallet (proxy) | `0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea` | [S1] `RailgunProxyContract`, [S3] `railgunSmartWallet` |
| RelayAdapt (V2) | `0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D` ("Deployment - Apr 2024") | [S1], [S3] |
| RelayAdapt7702 | `0x19702345c059ac86a1f17434ebE0227D62F5965f` (`supports7702: true` on Sepolia) | [S1] |
| Railgun registry | `0xFe276aD6a9Be967292D7fcb74E5510a1A6796bFb` | [S1] |
| Wrapped base token (WETH) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | [S1], [S3] |
| Privacy paymaster (4337, Kohaku) | `0xbb9d6507b5de027deb0196c83a7dc6eef325bee4` | [S3] only. Not in [S1]. |
| Railgun fee adapter (Kohaku) | `0xebabf510f824a349a9be7f40cad3486b7249b1e0` | [S3] only |
| V3 contracts (accumulator, verifier, token vault) | empty, `// TODO`; `supportsV3: false` | [S1] |

- **Yes, `0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea` is correct.** It is the same address in a different case. [S1][S3]
- Deployment block: [S1] says `5784866` and Kohaku [S3] says `5784774`. They differ slightly. Use the earlier one for syncing.
- POI launch on Sepolia: block `5944700` (21 May 2024). [S1][S3]
- Live checks [L]: all addresses above have bytecode. The proxy's EIP-1967 implementation slot points to `0x16dc2574cc30e4deecfb9ba22d95e5126a2fc0b3`. `shieldFee()` and `unshieldFee()` both return `25` (25 bps = 0.25%). `treeNumber()` = 0 and `nextLeafIndex()` = 11753, so the pool is active.

## 2. Broadcasters on Sepolia

- **How a browser reaches them:** `@railgun-community/waku-broadcaster-client-web`. You call `WakuBroadcasterClient.start(chain, options, statusCb)`, then `findBestBroadcaster(chain, feeToken, ...)`, then `BroadcasterTransaction.create(...)` and `.send()`. The option `trustedFeeSigner` is **required**. Others: `poiActiveListKeys`, `pubSubTopic`, `additionalDirectPeers`, `useDNSDiscovery`/`useCustomDNS`, `broadcasterVersionRange`. [S6][S7] Next.js needs WASM aliasing (curve25519) and Node polyfills. [S7]
- **Is anyone serving Sepolia?** The docs don't say. [S6] lists no networks or testnets, and the README's only example is mainnet. [S7] We did not observe a live Sepolia broadcaster: that needs a running Waku client and we ran out of time. **Assume there are none until a Waku client sees fee messages for chain 11155111.** The docs also don't give a value for `trustedFeeSigner`.
- **Fee model:** the user pays from their private balance in a token the broadcaster accepts. The SDK adds a private transfer to the broadcaster's `railgunAddress`. The fee is gas cost plus a broadcaster premium. If no broadcaster accepts the token, `findBestBroadcaster` returns `undefined`. [S6] The reference broadcaster's **default Sepolia fee tokens are WETH `0x7b79995e…`, WETH_ALT `0x97a3…`, DAI `0x3e62…` and USDT `0xb4fb…`. Circle USDC `0x1c7D…` is not in that list.** [S8 `src/server/config/config-tokens.ts`, `config-token-addresses.ts`] On top of that, the protocol takes 0.25% on unshield. [L]
- **Kohaku uses a different path (alpha.31):** `RailgunPlugin.broadcast()` does **not** use Waku, even though its doc comment says it does. It builds an **ERC-4337 UserOperation** (`provider.prepareUserOp(...)`), pays fees in **WETH** through the Railgun **privacy paymaster**, and needs `Bundler.pimlico(bundlerUrl)` plus a 7702 smart-account signer. [S3 `sdk/plugin.ts`] Live [L]: the Sepolia paymaster `0xbb9d…bee4` has a deposit of about 0.446 ETH at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` (we believe that's EntryPoint v0.8; we didn't verify the label) and 0 at the v0.7 EntryPoint. So the paymaster is funded on Sepolia right now, but a **Pimlico (third-party) bundler URL and API key** is needed.
- **Running our own broadcaster:** the official software is [S8]. It needs Node 18+, Docker, at least 1 GB RAM and 20 GB disk, plus an **nwaku node with public ports 60000, 8000 and 8546**, a **mnemonic** (the broadcaster's wallet, which pays gas and receives fees) and a `DB_ENCRYPTION_KEY`. Sepolia is in its chain list. [S8] **Render can't host it as-is:** a Render web service exposes only one public HTTP port, and other ports are private-network only. [S14] Waku's libp2p port 60000 wouldn't be reachable. Options: a VPS, or a *private* broadcaster that skips Waku and takes the proved tx over HTTPS. That second option is a custom design, not the official software.
- **What a broadcaster learns:** the proved transaction (`to`, `data`, nullifiers, min gas price) and its fee note. [S6] For an unshield, the recipient address, token and amount are public on-chain anyway. The proof hides which shielded notes paid. Over Waku, Railgun says the user's IP isn't exposed ("nobody can snoop on a user's IP address", [S6]). **Over plain HTTPS to our own server, our server sees the payer's IP and timing next to the destination address.** That is an identity→payment link, which invariant 2 forbids, unless we never log it and go through anon-rpc or Tor. Keys: the broadcaster's mnemonic and ETH gas key are *our operational keys*, which invariant 1 allows. But **every CPay unshield would then come from one EOA**, so on a quiet testnet the anonymity set is roughly "CPay users". Disclose this.

## 3. Proof of Innocence (POI) on Sepolia

- **Required?** The POI node serves Sepolia. `ppoi_node_status` on `https://ppoi.fdi.network/` returns `forNetwork.Ethereum_Sepolia` with txid index 4843, Shield 5112, Transact 5070, Unshield 1905 on list key `efc6ddb5…9e88`, and 0 pending proofs. [L] Kohaku enables POI by default (`poi?: boolean, default true`). With POI on, it "submit[s] POI proofs when spending notes and … only spend[s] notes that have been marked as `spendable`". [S3 `plugin.ts`, `index.d.ts withPoi`] So in practice, **yes**: with default config, unspendable notes can't be spent. The contract itself doesn't enforce POI. It's a client and broadcaster policy, and the reference broadcaster is "PPOI-safe". [S8]
- **Standby period:** mainnet is **1 hour** (`POI_SHIELD_PENDING_SEC = 60*60`, and the docs say "this Unshield-Only Standby Period will be 1 hour"). Testnet is **1 minute** (`POI_SHIELD_PENDING_SEC_TEST_NET = 1*60`). [S2][S9] During standby, the only allowed action is unshielding back to the original wallet. [S9]
- **Default POI node URLs:** the Railgun wallet SDK quick-start defaults to `poiNodeURLs = ["https://ppoi.fdi.network"]`, described as "a public aggregator node run by the community". [S10] Kohaku hard-codes `poiEndpoint: "https://ppoi.fdi.network/"` and list key `efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88` for both Sepolia and mainnet. [S3] Kohaku's own comment says the endpoint was "Sourced from signal chat with the railgun team. Not publicly documented anywhere". [S3 `index.d.ts`]
- **Other third parties Kohaku calls by default:** a Subsquid indexer `https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/v/v1/graphql`. [S3] You can disable it with `subsquid: false` and sync over RPC only. [S3 `plugin.ts`] Live, the squid was about 240 blocks (~48 min) behind Sepolia head (12075816 vs 12076056). [L] The RPC syncer covers the tail.

## 4. Circuit artifacts

- **Railgun wallet SDK:** the gateway is hard-coded as `https://ipfs-lb.com`, with root CIDs `QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU` (transact) and `QmZrP9zaZw2LwErT2yA6VpMWm65UdToQiKj4DtStVsUJHr` (POI 3x3 and 13x13). Paths are `circuits/<NNxMM>/zkey.br`, `prover/snarkjs/<NNxMM>.wasm.br` and `circuits/<NNxMM>/vkey.json`, all Brotli. Downloads are hash-checked (`validateArtifactDownload`). [S5] **No URL config option.** But the downloader checks `artifactStore.exists(path)` first. [S5 `artifact-downloader.ts`] So you can self-host by pre-filling the `ArtifactStore` from our own origin.
- **Kohaku:** the wasm has a hard-coded base `https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts/` and loads `<variant>/proving_key.bin.br`, `matrices.bin.br` and `wasm.br`. [S3 wasm strings; repo listing] **The public TS API has no artifact-URL option** (`index.d.ts`). To self-host you'd need a Service Worker that rewrites those fetches, or a patched build. As shipped, it's a third-party fetch, so it **breaks invariant 10** unless we intercept it.
- **Sizes (Brotli, as downloaded):**
  - IPFS [L]: `01x02` zkey 3.53 MB + wasm 0.89 MB; `02x02` zkey 4.75 MB.
  - Kohaku repo (GitHub API tree): `01x02` proving_key 3.34 MB + matrices 0.14 MB + wasm 0.89 MB (≈4.4 MB); `02x02` ≈5.6 MB; POI `03x03` ≈8.6 MB; POI `13x13` ≈28.5 MB. The whole Railgun folder is ≈326 MB, but a payment only needs the variants it uses.
- In this repo, `apps/web/public/circuits/circuits.json` points to `/circuits/{shield,unshield,transact}.{wasm,zkey}`. **Those files don't exist**, and Railgun has no "shield" or "unshield" circuits. Its circuits are named `NNxMM` (nullifiers × commitments). [S5]

## 5. Proof-generation performance

- **No published Railgun timings were found.** [S11] only says that browser and Node use snarkjs (WASM) and mobile apps use the C++ `@railgun-community/native-prover`. Kohaku proves in Rust→WASM (arkworks-style `proving_key.bin` and `matrices.bin`). [S3]
- General data, not Railgun: Mopro reports native or rapidsnark proving up to about 20× faster than snarkjs in the browser on phones (e.g. a Keccak circuit on an S23 Ultra took ~11.1 s with snarkjs vs ~0.74 s with rapidsnark). https://hackmd.io/@vivi432/mopro-benchmark
- With POI on, each spend needs **two** proofs: the transact proof and a POI proof (3x3 or 13x13). [S3 wasm `PoiCircuitInputs`] Plan for tens of seconds on a phone and **measure it on the demo phone** before relying on it in the voice flow.

## 6. Kohaku (`@kohaku-eth/railgun`)

- **Status:** "NOT READY FOR PRODUCTION USE AND CONTAINS UNAUDITED CODE". [S3 README] In the Kohaku repo, Railgun is marked 🚧 "currently under mainenance", and `packages/railgun` on `master` is now a **placeholder stub** ("Placeholder … while the real implementation is reintroduced. … Do not depend on this stub."). The Rust implementation lives in https://github.com/ethereum/kohaku-rs. [S4] The latest npm release is `0.0.1-alpha.31` (22 Sep 2026), which has real code and is what this repo installed (`npm view`).
- **Browser:** WASM built with `wasm-pack --target web`. [S3 package.json] `ensureInitialized(wasmInput?)` takes a URL or bytes. [S3 `lib.ts`] In plain Node ESM, importing the package root fails (`ERR_UNSUPPORTED_DIR_IMPORT` on `../pkg`). We saw this; it needs a bundler or a direct `dist/pkg/index.js` import.
- **Sepolia:** supported (`chainConfigSepolia()`). [S3]
- **API:** `createRailgunPlugin(host, {poi, subsquid, bundler})` → `prepareShield` returns raw `TxData` that you sign yourself. `prepareTransfer(to: 0zk…)` and `prepareUnshield(asset, to, {tailCalls})` return a proved op → `broadcast(op)` via 4337/Pimlico. `RailgunProvider.build(builder)` returns plain `TxData`, which you can send yourself, but then your own EOA is visible as the sender. [S3] Examples: the package README points to `./tests/`, which **isn't in the npm tarball**. Kohaku's docs example (kohaku-cli) covers Privacy Pools and Tornado: "These pages cover Privacy Pools and Tornado Cash". [S4 `docs/pages/examples.mdx`] **We found no published browser example of a Railgun transfer or unshield.**

## 7. Unshield USDC + ETH (gas) to one address in one tx

- **Wallet SDK "unshield base token":** WETH is unshielded *to RelayAdapt*, then `relayAdapt.unwrapBase(0)` and `relayAdapt.transfer([{token: ERC20(0x0)=ETH, to, value: 0}])` run, where value 0 means "all". [S12 `relay-adapt-v2.ts getOrderedCallsForUnshieldBaseToken`] `transfer` takes an **array** of `TokenTransfer`. So a single RelayAdapt cross-contract call could, in principle, unshield USDC and WETH to RelayAdapt and then `unwrapBase(0)` + `transfer([ETH→X, USDC→X])`. **This isn't a built-in SDK helper and we haven't tested it.** The wallet SDK's cross-contract API only checks that each call has `to` and `data`. [S5 repo `tx-cross-contract-calls.ts`]
- **Kohaku:** `prepareUnshieldMulti([{native,…},{erc20 USDC,…}], to)` unshields USDC and WETH *to `to`*. At broadcast it prepends `WETH.withdraw(nativeAmount)` as an execution call **run by the 7702/4337 smart account at `to`**. [S3 `unshield-calls.ts`, `plugin.ts`] That only works if `to` is a smart account the signer controls. **A fresh stealth EOA generated by the recipient can't be the target, because the payer has no key for it.** For a stealth recipient you'd unshield USDC + WETH (ERC-20), and the recipient would still need ETH to unwrap. The RelayAdapt route above is the only single-tx path.
- **Linkability:** ETH sent to a fresh address by RelayAdapt is visible on-chain as RelayAdapt→X. It doesn't reveal the payer.

## 8. Anon-RPC

- **What it is:** "A standard that lets a wallet or application make anonymized RPC requests by running hash-pinned client code inside a sandboxed worker…". [S13] The browser package is `@anon-rpc/browser-harness`: `new AnonRpcWorker({ address: <specifier>, config, preExisting: { rpcProvider } })`, then `worker.fetch(rpcUrl, …)`. [S13 integrate-wallet] Kohaku wraps it as `anon({ specifier, rpcUrl, workerConfig, bootstrap })` from `@kohaku-eth/provider/anon`. The default receipt polling is 4 s with a 5 min timeout. [S4]
- **There's no public endpoint.** You point it at any JSON-RPC URL (`rpcUrl`), and the worker forwards through its network. The bootstrap provider reads the specifier contract once, and that read is **not** anonymized. [S13]
- **Networks** (from [S13] `adopters.json5`):
  - passthrough `0x4fd77be300f31c5fe6ab266d35d27750a3478d27` (mainnet, does **not** anonymize)
  - tor-js `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e` (mainnet, demo gateway "may disappear")
  - Nym `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` (mainnet, ~18 MB bundle)
  - **Nox `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`, published on Sepolia (11155111)**: Sphinx mixnet, TLS inside the worker.

  "Chain" here is where the *specifier contract* lives, which determines what the bootstrap provider must serve. It isn't necessarily the target chain. For Sepolia reads and tx submission: `rpcUrl` = a Sepolia RPC. For Nox, the bootstrap provider must answer on Sepolia. For tor-js or Nym, bootstrap must be a mainnet provider.
- **Limits:** the worker "sees every routed request, including signed transactions, and can observe, censor, or lie". [S13] Already recorded in `docs/SPONSORS.md` as *deferred* (we can win only one EF prize, and CROPS is the target).
- **Track:** we found no public web page for an ETHGlobal Mumbai "Best Use of Anon-RPC" prize via search. Our internal `docs/SPONSORS.md` lists it at $5k (deferred).

---

## Findings about the current repo code (read-only review, nothing changed)

1. **`apps/web/app/api/railgun/broadcast/route.ts` is not Railgun.** It does `erc20.transfer(destination, amount)` (plus a plain ETH send for the "gas drop") from a **server key**, `BROADCASTER_PRIVATE_KEY || AGENT_WALLET_PRIVATE_KEY`. No proof, nullifier or Railgun contract is involved. The client presents it as "Unshielding from Railgun … Payer is hidden by Railgun" (`apps/web/app/pay/private-flow.ts`). This is a **mocked privacy claim (invariant 9)**, it puts **funds on a server (invariant 1)**, and it can fall back to a key named `AGENT_WALLET_PRIVATE_KEY`.
2. **`packages/railgun/src/railgun.ts` `shieldToRailgun` builds a fake shield.** `npk` is `keccak256("cpay/v1/railgun/npk", …)` and the ciphertext fields are keccak hashes (`packages/railgun/src/keys.ts`). Real Railgun needs `npk = poseidon([masterPublicKey, random])` [S12 `shield-note.ts`] and an encrypted bundle that a viewing key can decrypt. **The contract accepts the shield anyway** (it can't check the npk). The resulting notes can't be found by any wallet and almost certainly can't be spent: no known master key opens that npk. **Don't shield real test funds with this code.**
3. The `0zk` address in `keys.ts` is string concatenation, not Railgun's bech32m encoding.
4. `@kohaku-eth/railgun` is a dependency of `@cpay/railgun`, but nothing imports it.
5. `circuits.json` references missing files (see §4).

## Risks for a demo tonight

- The current "Railgun" path is a server-side transfer. Shipping it as "Railgun hides the payer" is a mock (invariant 9) and a server-held-funds problem (invariant 1). **Either do it for real or remove the claim.**
- No confirmed public Sepolia broadcaster. The official one can't run on Render (single public HTTP port). Kohaku's path needs a Pimlico bundler key (third party) and a 7702 smart account, and its fee is paid in WETH, which must be shielded too.
- Circle USDC isn't a default fee token for Sepolia broadcasters.
- POI is on by default. A fresh shield needs the testnet standby (1 min per [S2]), and then the POI node has to mark it spendable. That depends on a third-party node (`ppoi.fdi.network`) and list providers. A slow node stalls the demo.
- Proving cost: a transact proof plus a POI proof, with about 4–9 MB of artifacts per circuit on first use. Timing on the demo phone hasn't been measured, and the voice flow has only a 5 s confirm window.
- Third-party fetches by default (GitHub raw artifacts, Subsquid, POI node, Pimlico) conflict with invariant 10 unless they're proxied or self-hosted. Kohaku has no artifact-URL option.
- Kohaku is alpha and unaudited, and Railgun on `master` is now a stub ("under maintenance"). There's no browser transfer or unshield example, and the Node ESM import is broken (needs a bundler).
- One-tx USDC + ETH gas drop to a stealth EOA is only possible through a custom RelayAdapt multicall that we haven't tested.
- Sepolia vs Base Sepolia: `docs/SPONSORS.md` says payments moved to **Base Sepolia (84532)**. Railgun has **no Base Sepolia deployment** in [S1] (testnets are Sepolia and Amoy only), so Railgun forces Ethereum Sepolia with ~12 s blocks.
