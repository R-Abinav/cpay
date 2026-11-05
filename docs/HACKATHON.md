# Winning ETHGlobal Mumbai: rules, judging, demo, pitch

## Hard rules (ETHGlobal Mumbai)
- **Submission deadline: Sat 7 Nov 2026, 09:00 IST.** Late submissions aren't accepted.
- **Partner prizes: select up to 3.** Several tracks from one partner count as one selection.
- **Demo video: 2–4 min, at least 720p, no AI voiceover / TTS, no sped-up footage, don't record on a phone.** 0G wants **under 3 min**, so **target 2:30–2:55** to satisfy both.
- **AI usage must be documented:** which files were AI-generated, plus specs, prompts and planning artifacts committed (`AI_USAGE.md`, `docs/`). Projects that rely entirely on AI may be ineligible, so humans must direct and review.
- Code must be built during the event; only public libraries and starter kits may predate it.
- **Finalist prize:** 250 USDC per person for a solo or pair team (we're 2), plus travel reimbursement.

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

## The 4 must-have demo moments
1. **Look and pay in a crowd.** Three enrolled people in a row. Look at the middle one, "pay her 2 USDC", and only her phone lights up. OLED confirm. Etherscan shows a random address.
2. **Rejection.** A non-enrolled person: "no verified recipient", nothing paid. (Required by World.)
3. **Agent Pass.** "Pay her 50": over the cap, so World approval is required. Approve once (pays), deny once (nothing happens).
4. **Privacy X-ray screen.** A live panel showing what each party saw for that payment: payer / issuer / relay / chain / 0G / RPC. (This is our CROPS "moment it matters".)

Should-haves (great for Q&A):
- **Unlinkability:** pay the same person twice; two unrelated proofs and addresses.
- **Spoof judo:** hold up her photo and it pays… her.
- **Invisible mode:** she toggles off and disappears.
- **Safe-stop:** kill 0G connectivity and the OLED shows "BRAIN OFFLINE - PAUSED".

## Video script (about 2:50)
| Time | Shot |
|---|---|
| 0:00 | Problem: "face → wallet means anyone can see how rich you are" (10 s) |
| 0:15 | Crowd look-and-pay, live on the glasses |
| 1:00 | Privacy X-ray |
| 1:30 | Non-enrolled person rejected; over-cap approve and deny |
| 2:15 | 0G safe-stop |
| 2:35 | CROPS one-liner + architecture slide |

## Pitch
- One-liner: **"Your face picks you out but never identifies you."**
- 30 s: "CPay is smart glasses where you look at someone and say 'pay her 2 USDC'. The obvious version is a privacy disaster because your face becomes your wallet. In CPay nobody holds that link. Your face template lives only on your phone, and your phone is the only thing that recognises you. It answers with a zero-knowledge proof that says 'World-verified human' and nothing else, plus a throwaway address. Our server only stores World ID nullifiers."

## Judge Q&A cheat sheet
- **"Why World ID?"** Each credential lets a phone answer face probes, so sybils would be fake claimants. Proof of Human gives one card per human; Selfie Check is medium assurance and doesn't guarantee it. (IDKit judges reward the credential choice.)
- **"Can someone spoof a face?"** Yes, and the money goes to the face's real owner, because only their phone matches.
- **"What if a phone lies and claims everything?"** It collides with the real owner and we abort. Each lying card costs a real World ID. Spend caps limit losses. Private fuzzy matching is future work.
- **"What does your server know?"** One nullifier per human. Nothing about payments.
- **"Isn't the embedding leaking?"** Yes, to nearby enrolled phones, sealed and discarded after comparing. We disclose it.
- **"What breaks without 0G?"** The glasses can't understand what you asked, so nothing can be paid. A safe-stop, never a guess.
- **"Is the amount private?"** In Full mode (Railgun), yes, and so are payer and recipient. In Lite mode only the recipient is hidden.

## Submission checklist
- [ ] Public repo, MIT license, README with setup + architecture + limitations
- [ ] README sections:
  - [ ] **CROPS** (C/O/P/S lines)
  - [ ] "What breaks without 0G"
  - [ ] World integration debriefs (IDKit + Agent Pass)
  - [ ] Sepolia tx links
  - [ ] 0G request IDs + Storage root hashes
- [ ] `AI_USAGE.md` complete; specs and prompts in `docs/`
- [ ] Video 2:30–2:55, real voices, 720p+
- [ ] Partner prizes selected: World, 0G, EF
- [ ] Live demo link (0G); team Telegram/X contacts (0G)
- [ ] Hardware demo booked at the 0G booth
