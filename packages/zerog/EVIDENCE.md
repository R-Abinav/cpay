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
| 2026-11-05T22:23Z | intent | qwen-flash | private | 400 `model_not_capable` (safe-stop, 503 to client) | `45599696-4426-49b1-820c-55b717736ab9` | missing | absent | | |
| 2026-11-05T22:23Z | intent (Stage 1 route) | qwen-flash | private | 400 `model_not_capable` (safe-stop) | `ba5b9159-a86c-4b4c-bbbe-fcdad5eb3c82` | missing | absent | | |
| 2026-11-05T22:23Z | intent ("pay 2 USDC" -> `{"amount":"2","token":"USDC"}`) | 0gm-1.0-35b-a3b | private (`x-0g-e2ee: sealed`) | 200 | `727c2895-9e20-422a-9a2b-2445c8186ecc` | `c7fa4654-c710-4e25-9fb2-231840ee29dc` | absent (null for E2EE requests) | | |
| 2026-11-05T22:23Z | intent ("what is the weather" -> refusal `model_refused`) | 0gm-1.0-35b-a3b | private (`x-0g-e2ee: sealed`) | 200 | `8442c9c9-e4bd-4206-ae23-b7778be40ea9` | `e06b817c-ee25-45ae-a6ca-6ccb890730ab` | absent | | |
| 2026-11-06T04:17:29Z | intent ("pay 2 USDC") | 0gm-1.0-35b-a3b | private (`x-0g-e2ee: sealed`) | 200 | `b61ff8e5-f9ee-4611-b388-494582e40175` | `34a61a44-a172-4952-b582-4672d807994b` | absent | | |

### Notes from the 6 Nov run (IST)

- Calls above went through the real route handlers (`apps/web/app/api/intent`, `apps/web/app/api/stage1/intent`) with the env of the main checkout.
- **Private-provider check** (`GET /v1/providers`, request `7eedae8926964f42`): the only private **chat** model is `0gm-1.0-35b-a3b` (supports `response_format`). `qwen-flash` (the currently configured `ZG_INTENT_MODEL`) and `glm-5.3` have **standard** providers only, so a private-mode intent call to them is refused by the router (`model_not_capable`) and CPay safe-stops. `whisper-large-v3` has a private provider. TTS (`minimax-speech-*`) is standard only.
- The router sends **two** `X-Request-ID` values (`"<edge id>, <uuid>"`); the uuid equals `x_0g_trace.request_id`, which is what we record. The full header is kept in the raw headers.
- Private-mode responses carry `x-0g-e2ee: sealed` and no `x_0g_trace.tee_verified` (null for E2EE requests per the router OpenAPI), so `receipt_status` is `unverified` with a `ZG-Res-Key`. Booth question: is the `ZG-Res-Key` + provider signature the receipt they want?
