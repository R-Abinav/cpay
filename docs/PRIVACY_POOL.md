# Privacy pool for private funds: findings (Fri 6 Nov 2026)

**Question:** can a recipient deposit USDC/ETH from a one-time (ERC-5564) address into an audited privacy pool on
**Base Sepolia (84532)** and later withdraw to a pasted address, so that deposit and withdrawal are unlinkable?

**Answer: no.** No audited pool has an official deployment on Base Sepolia. We did not build one and did not invent
addresses or ABIs. What ships instead is **Send privately** (each one-time address pays directly; the main wallet
never signs), see `packages/wallet/src/onetime.ts` `sendFromPrivate`. Railgun (payer/amount hiding) is the
teammate's track and is out of scope here.

## 0xbow Privacy Pools

| What | Finding | Source |
|---|---|---|
| Official deployments | **Ethereum Mainnet only**: Entrypoint proxy `0x6818809eefce719e480a7526d76bd3e561526b46`, one pool, **PrivacyPool ETH** `0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb`. No USDC pool, no Base, no testnet address published | [docs.privacypools.com/deployments](https://docs.privacypools.com/deployments), [repo `docs/docs/deployments.md`](https://github.com/0xbow-io/privacy-pools-core/blob/main/docs/docs/deployments.md) |
| Chains the deploy script knows | `EthereumSepolia` (11155111, native ETH pool, min deposit 0.001 ETH), `GnosisChiado` (10200), `EthereumMainnet` (1), `Gnosis` (100). **No Base / Base Sepolia config** | [`packages/contracts/script/Deploy.s.sol`](https://github.com/0xbow-io/privacy-pools-core/blob/main/packages/contracts/script/Deploy.s.sol) |
| Assets | Protocol supports native + ERC-20 (`PrivacyPoolSimple` / `PrivacyPoolComplex`), but only an ETH pool is deployed | [docs.privacypools.com](https://docs.privacypools.com/) |
| SDK | `@0xbow/privacy-pools-core-sdk` v1.5.0 (browser ESM build) | [`packages/sdk/package.json`](https://github.com/0xbow-io/privacy-pools-core/blob/main/packages/sdk/package.json) |
| Withdrawals need an ASP | Withdrawals prove membership in the Association Set Provider's approved set; "Only authorized postmen can update roots". Unapproved deposits can only **ragequit** (a public exit to the original depositor) | [docs.privacypools.com/layers/asp](https://docs.privacypools.com/layers/asp) |

## Other pools checked

A web search ("shielded pool Base Sepolia USDC audited") found no official, audited Base Sepolia deployment:
Veil.cash is described (by a third-party listing, not its own docs) as Base mainnet only; the rest were hackathon
projects with mock tokens or docs with placeholder addresses. None qualifies under "audited + official address".
Tornado-style pools aren't an option (no official Base deployment; sanctions history).

## What it would take

1. **Use 0xbow on Ethereum Sepolia** (the only testnet in their script). But no Sepolia address is published, so we'd
   have to confirm one with 0xbow or deploy it ourselves, and CPay pays on Base Sepolia: funds would need a bridge hop
   (which itself links addresses).
2. **Self-deploy 0xbow contracts on Base Sepolia** (`Deploy.s.sol` + a `BaseSepolia` config with a USDC
   `PrivacyPoolComplex`). Then **we** would be the ASP postman. That gives us a server-side role that approves or
   blocks users' deposits, and an anonymity set of just our demo users. It's unaudited as a deployment, and it conflicts
   with "nothing worth stealing on our side". Not worth it at a hackathon.
3. **Mainnet later:** the real 0xbow ETH pool on Ethereum mainnet. The design would stay as it was asked for:
   deposit secrets from HKDF(root, `cpay/v1/pool`) kept only on the phone, deposit straight from a one-time address,
   withdraw (partial amounts, after waiting) to a pasted address via a relayer, so the withdrawal needs no gas from a
   linked address.

## Disclosure (README / judge Q&A)

"Send privately" keeps received funds unlinked from your **main wallet**. It does **not** hide that a given one-time
address paid the recipient, and paying from several one-time addresses at once lets observers guess they belong to one
person (the UI says so and uses as few as possible). A privacy pool would remove even that; there isn't one on Base
Sepolia today.
