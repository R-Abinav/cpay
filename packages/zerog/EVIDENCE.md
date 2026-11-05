# 0G evidence

0G asked to see a **request ID and a receipt** for our inference. Every 0G call CPay makes (transcribe, intent, speak, storage upload) produces one evidence record. Each record is:

1. printed as one server log line, e.g.
   `[0g] kind=intent model=glm-5.3 trust=private status=200 requestId=… receipt=<ZG-Res-Key>|missing tee_verified=true|false|absent provider=0x… clientRequestId=…`
2. appended to the JSONL at `ZG_EVIDENCE_PATH` (git-ignored, on the payer laptop)
3. referenced from the encrypted episode on 0G Storage, with a plaintext index record `{kind: "storage", rootHash, txHash, requestIds}` in the same JSONL
4. shown on the `/pay` screen and in the Privacy X-ray (frontend)

Records hold IDs, receipts, model names and hashes only. They never hold the transcript, intent text, audio, faces or recipient addresses.

## Record format (`Evidence` in `src/evidence.ts`)

| field | source |
|---|---|
| `ts`, `kind`, `model`, `trustMode`, `latencyMs` | ours |
| `httpStatus` | the router response (null on timeout or network error) |
| `requestId` | the `X-Request-ID` header, then `x_0g_trace.request_id`, then an error body's `request_id`. A missing ID is a safe-stop. |
| `clientRequestId` | our `X-Client-Request-Id` (router-documented; 0G support can look it up for 30 days, including for requests that timed out on our side) |
| `receipt.resKey` | the `ZG-Res-Key` response header: the provider's response id, used to fetch the provider's TEE signature at `<provider broker>/v1/proxy/signature/{resKey}` (0g-pc-e2ee `protocol/SPEC.md` §8) |
| `receipt.teeVerified` | `x_0g_trace.tee_verified`: the router's check of that signature (we send `verify_tee: true`) |
| `receipt.provider`, `receipt.providerIdentity` | `x_0g_trace.provider`, `x_0g_trace.provider_identity` |
| `rawTrace` | the whole `x_0g_trace` object, verbatim |
| `rawZgHeaders` | every `x-0g-*` and `zg-*` response header plus `x-request-id`, `x-provider` and `x-client-request-id`, with values verbatim |
| `error` | failures only, as a machine code (`timeout`, `network`, `http_503:<code>`, `missing_request_id`, …) |
| `rootHash`, `txHash`, `requestIds` | storage records only |

Until the 0G team confirms which artifact they count as "the receipt", the raw trace and headers are kept verbatim as well.

## Real evidence

Fill this in from `pnpm --filter @cpay/zerog smoke` (it prints these rows) and from demo runs. Only real values go here.

| ts (UTC) | kind | model | trust | HTTP | request ID | receipt (ZG-Res-Key) | tee_verified | root hash | storage tx |
|---|---|---|---|---|---|---|---|---|---|
