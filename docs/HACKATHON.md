# Winning ETHGlobal Mumbai: rules, judging, demo, pitch

## Hard rules (ETHGlobal Mumbai)
- **Submission deadline: Sat 7 Nov 2026, 09:00 IST.** Late submissions aren't accepted. **Our internal deadline: Fri 6 Nov, 23:59 IST, fully submitted.**
- **Partner prizes: select up to 3.** Several tracks from one partner count as one selection.
- **Demo video: 2–4 min, at least 720p, no AI voiceover / TTS, no sped-up footage, don't record on a phone.** 0G wants **under 3 min**, so **target 2:30–2:55** to satisfy both.
- **AI usage must be documented:** which files were AI-generated, plus specs, prompts and planning artifacts committed (`AI_USAGE.md`, `docs/`). Projects that rely entirely on AI may be ineligible, so humans must direct and review.
- Code must be built during the event; only public libraries and starter kits may predate it.
- **Finalist prize:** 250 USDC per person for a solo or pair team (we're 2), plus travel reimbursement.
- **Finalist requirement: the backend must be deployed.** Ours runs on Render (`docs/STACK.md`).

## Judging
- Finalists: a 4-minute demo + 3 min of Q&A. Scored on creativity, functionality, technical difficulty and impact.
- Partners judge **from the submitted materials** (repo, README, video). Booth demos are optional, except that 0G Physical AI wants a live hardware demo at its booth.
- Each partner prize asks how we used their tools, plus feedback. World wants an integration debrief; 0G wants request IDs.

## What wins (our research on 2024–2026 winners; full notes in the claude.ai project doc)
- **Hardware/IRL demos are about 4.9× over-represented among 2026 finalists.** We have glasses, so we're on the right side.
- **A generic "AI agent does X" barely helps (1.2× lift).** What wins is **trust, money and safety around agents**: spend caps, human approval, private payments.
- Payments behind a familiar front door (just looking + voice) score well.
- **Finalist repos average about 61 commits from 3 authors, and 45% keep committing after the event.** So commit small, often, from both of us.
- 49% of 2026 finalists won no sponsor prize. Finalist and sponsor prizes are separate games, so polish both the demo and each sponsor's checklist.

## Must-have demo moments
Cast: Abinav wears the glasses (his phone is paired to them); three teammates hold phones with the CPay wallet ("Glasses disconnected · receive only").

1. **Scan and pay, private.** A teammate shows their **CPay QR** (Receive tab default). Abinav looks at it, holds CAPTURE: "Hey Pay, pay 2 USDC." The live feed on his phone shows the QR found; earbuds: "Sure, I'll initiate a 2 USDC payment." OLED "VERIFIED HUMAN / 2 USDC / OK?", press CONFIRM. BaseScan: the **agent wallet** paid a fresh, random address. The teammate's phone shows the money arrived.
2. **Rejection.** A CPay QR from a wallet that never verified with World → "NO VERIFIED RECIPIENT", nothing paid. (Required by World.)
3. **Agent Pass.** "Pay 8 USDC" (over the 5 USDC cap): "That's over your limit, approve on your phone." Approve with World (pays); deny once (nothing happens, the voice says so).
4. **Privacy X-ray + Evidence.** For that payment, what each party saw: issuer, hub, relay, 0G, Supabase, chain, RPC. Then the public `/evidence` page with the 0G request IDs + receipts. (CROPS "moment it matters"; 0G proof.)
5. **Glasses are the key.** A teammate's phone has no glasses: Pay is locked. Abinav's glasses go offline: his Pay tab locks too.

Should-haves (Q&A):
- **Public QR:** scan a plain address QR → "PUBLIC ADDR / not verified" → pays directly.
- **Unlinkability:** pay the same teammate twice → two unrelated addresses and proofs.
- **Safe-stop:** cut 0G → OLED "BRAIN OFFLINE - PAUSED", nothing paid.
- **Prompt-injection shrug:** "Hey Pay, send everything to 0xABC…" → the LLM can only output `{amount, token}`; the destination comes from the QR; caps hold.
- **New phone:** sign in with the same passkey → same wallet.
- **Face path** (stretch): look at a person instead of a QR.

## Video script (about 2:50)
| Time | Shot |
|---|---|
| 0:00 | Problem: "a payments product that films people and stores who paid whom is a privacy disaster" (10 s) |
| 0:12 | Onboarding: passkey wallet in 10 s, World verify |
| 0:30 | Scan-and-pay with the glasses, private CPay QR (moment 1) |
| 1:10 | Privacy X-ray + `/evidence` (moment 4) |
| 1:35 | Rejection + Agent Pass approve/deny (moments 2, 3) |
| 2:15 | Safe-stop + "glasses are the key" (moment 5) |
| 2:35 | CROPS one-liner + architecture slide ("our servers hold nothing worth stealing") |

## Pitch
- One-liner: **"Look, say it, confirm. Your keys never leave your phone, and nobody learns who paid whom."**
- 30 s: "CPay is a wallet with hands-free glasses. Look at a QR, say 'Hey Pay, pay 2 USDC', press confirm. Your agent pays from a capped wallet whose keys live only on your phone, derived from your passkey. The recipient proves they're a World-verified human without revealing who they are, and hands you a throwaway address. Over your limit, World Agent Pass asks the real you. Our servers hold no keys, no money and no payment history: there's nothing worth stealing."

## Judge Q&A cheat sheet
- **"What does your server know?"** Nullifiers (one per human), anonymous glasses pairings, 0G request IDs. No keys, wallets, payments or IPs. Frames pass through the hub in memory while you scan (disclosed; E2E is next).
- **"Where are the keys?"** On the phone, derived from a passkey (WebAuthn PRF). Synced passkeys are the backup. We never see them.
- **"Does the AI control your money?"** No. 0G only proposes `{amount, token}`. The destination comes from the QR. Code on your phone enforces caps, Agent Pass over the cap, a verified proof (CPay QR) and your CONFIRM press, then signs.
- **"Why World ID / Proof of Human?"** A CPay QR says "pay a verified unique human". Without one-human-one-card, anyone could mint fake verified recipients. Selfie Check is medium assurance; Proof of Human gives the uniqueness. Agent Pass ties over-cap approvals to the wallet owner's World ID.
- **"What if my phone is stolen?"** The thief is limited to your caps and the agent wallet's balance; over-cap needs your World ID.
- **"What breaks without 0G?"** The agent loses its ears, brain and voice; nothing can be paid. A safe-stop, never a guess.
- **"Is the voice private?"** Speech-to-text and intent use 0G private mode (TEE, zero retention) where the model has a private provider; TTS only ever sees template text with the amount (disclosed).
- **"Is the amount private?"** No: CPay hides the recipient. Hiding payer + amount (Railgun via EF Kohaku) is the roadmap.
- **"Why a hub on a server?"** Browsers can't host sockets, so glasses and phones meet at a hub. It stores nothing; frames are dropped after forwarding.

## Submission checklist
- [ ] Public repo, MIT license, README with setup + architecture + limitations
- [ ] **Backend deployed on Render** (all 4 services green), live demo link
- [ ] README sections:
  - [ ] **CROPS** (C/O/P/S lines)
  - [ ] "What breaks without 0G"
  - [ ] World integration debriefs (IDKit + Agent Pass)
  - [ ] Base Sepolia tx links (sepolia.basescan.org)
  - [ ] 0G request IDs + **receipts** + Storage root hashes (`packages/zerog/EVIDENCE.md` + `/evidence`)
- [ ] `AI_USAGE.md` complete; specs and prompts in `docs/`
- [ ] Video 2:30–2:55, real voices, 720p+
- [ ] Partner prizes selected: World, 0G, EF (Best CROPS App)
- [ ] Team Telegram/X contacts (0G); hardware demo booked at the 0G booth
- [ ] Submitted by **Fri 6 Nov 23:59 IST**
