# Integration debrief (running notes): World IDKit 4 + World Agent Pass

These notes feed the README's integration debrief (required by both World tracks). Everything was done by the identity agent on Thu 5 Nov 2026. The docs were read live that day.

## IDKit 4 (recipient onboarding, Proof of Human)

**Time to first success**
- Code-level, about 25 min from reading the guide to a passing issuer test. The test covered RP signing, the verify-call shape, the signal check and the nullifier store.
- That test used a local fake verify server, because no Developer Portal app or credentials exist yet.
- The first real staging round trip with the simulator is still to do. It needs `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY`.

**What went smoothly**
- `signRequest` from `@worldcoin/idkit-core/signing` needs no WASM, and its output maps 1:1 onto `rp_context`.
- `hashSignal` (`@worldcoin/idkit-core/hashing`) and `Nullifier` (`@worldcoin/idkit-core/nullifier`) are exported, so the server never re-implements field hashing.
- The verify call is "forward the payload as-is", which is simple and hard to get wrong.

**Friction**
- **The guide doesn't say how `signal_hash` is computed.** We found it by reading the `hashSignal` source:
  - a `0x`-hex string is hashed as bytes
  - anything else is hashed as UTF-8
  - our signal is `0x` + sha256(commitment), so it's hashed as bytes
- **Nullifier format differs by protocol version.** The types say v4 `nullifier` is decimal and v3 is hex. The guide says "0x-prefixed hex → convert to decimal". We normalise both forms to decimal.
- **`allow_legacy_proofs: true` gives one human two nullifiers** (v3 and v4). The type docs warn "you must track both v3 and v4 nullifiers". For a one-card-per-human credential we turned legacy proofs off and refuse `protocol_version: "3.0"`. The integrate guide's example uses `allow_legacy_proofs: true` without that caveat.
- **The verify response mostly doesn't echo the nullifier.** `nullifier` / `results[].nullifier` are optional in the 200 schema, so we store the nullifier from the IDKit payload. If World does echo one, we cross-check it.
- The guide suggests a `verified_at` column. We omit it on purpose (privacy: no enrolment timestamps).

**Missing docs / open questions**
1. Does the simulator (`environment: "staging"`) return World ID **4.0** `proof_of_human` results, or only legacy 3.0? Our issuer requires 4.0.
2. Is `signal_hash` checked server-side by the verify API against the proof? We assume yes, because it's a public input of the proof. We also check it equals `hashSignal(signal)` before forwarding.
3. What exact `identifier` string does a v4 Proof of Human response carry? The types say `"proof_of_human"` and `issuer_schema_id` 1. We check both.

**Top improvement**
Add a short "signal binding" section to the integrate guide:
- how `signal_hash` is derived (or "call `hashSignal`")
- that the backend should compare it
- a full 200 verify-response example

## Agent Pass (World IdP OIDC step-up for over-cap payments)

**Time to first success**
- About 35 min to a passing end-to-end test, run against an in-process fake IdP. The real oauth4webapi validation runs in that test, including RS256 + JWKS.
- The real sandbox run is still to do. It needs a sandbox client from `https://sandbox.auth.world.org/portal` and the sandbox World ID app (TestFlight).

**What went smoothly**
- The discovery document is standard. It advertises RFC 9207 `iss`, S256 only and RS256, so `oauth4webapi` works out of the box.
- The human-in-the-loop guide is explicit about:
  - `max_age=0`
  - the essential-`acr` claims JSON
  - validating `acr` yourself, because `acr_values` is only a preference

**Friction**
- **Basic client auth form-urlencodes the id and secret** (RFC 6749 §2.3.1). That's correct, but it caught our fake IdP; real servers handle it.
- **There is no protocol-level transaction binding.** No `binding_message` or `authorization_details`. We bind `{sessionId, amount, token}` server-side, keyed by `state`, and make approvals single-use with a TTL. The guide recommends this, but it is all app code.
- Production discovery advertises only `orb` and `orb-face` in `acr_values_supported`. The docs also list `selfie` and `selfie-face`.

**Missing docs / open questions**
1. **Cancel in World App:** which callback `error` code is returned when the user cancels? `access_denied` is only documented for the device flow. We treat any `error=` as "not approved", and an attempt that never returns expires after `approvalTtlSeconds`.
2. **`amr` values:** the guide says to check `amr` ("World ID proof or passkey") but doesn't list the values. We don't gate on `amr` yet.
3. **Sandbox `acr`:** the testing guide says sandbox IDs carry "an Orb-level test credential". Is the sandbox ID token's `acr` exactly `https://world.org/oidc/acr/orb`?
4. **Sandbox `iss`:** is it exactly `https://sandbox.auth.world.org`? We assume yes and read it from discovery.
5. **Track wording vs docs:** the track says "proofs are mocked by World (fake identities)", while the testing guide describes a real sandbox app with ~1 h credential issuance. Confirm with the World booth which one judges expect.

**Top improvement**
Add a first-class transaction-binding parameter, for example a `binding_message` shown in World App ("Approve 8 USDC payment"). Then the human sees what they approve and the ID token carries it, so apps don't need a server-side map.

## Privacy notes (issuer)
- Stores only:
  - `nullifiers(nullifier, action)`
  - `WORLD_RP_SIGNING_KEY` (env)
  - `ISSUER_BBS_SECRET_KEY` (env)
- Logs are `[issuer] METHOD /path STATUS` only, with no query strings, IPs or bodies.
- Agent Pass never touches the issuer.
