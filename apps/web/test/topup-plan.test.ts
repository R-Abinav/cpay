import { describe, expect, it } from "vitest";
import * as P from "../lib/topup-plan.js";
import type { TxData } from "../lib/railgun-types.js";

const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const RAILGUN = "0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea";
const wrap: TxData = { to: WETH, data: "0xd0e30db0", value: 6n };
const approve = (to: `0x${string}`): TxData => ({ to, data: `0x095ea7b3${"0".repeat(128)}`, value: 0n });
const shield: TxData = { to: RAILGUN, data: "0x044a40c3abcdef", value: 0n };
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const bal = (uv: bigint, up = 0n, wv = 0n, wp = 0n) => ({ usdc: { valid: uv, pending: up }, weth: { valid: wv, pending: wp } });

function prepared(withWeth = true): P.TopUp {
  const t = P.newTopUp(withWeth ? { USDC: 1_000_000n, WETH: 6n } : { USDC: 1_000_000n }, { usdc: 5n, weth: 0n });
  const fresh = [...P.stepsOf("USDC", [approve(USDC), shield], WETH), ...(withWeth ? P.stepsOf("WETH", [wrap, approve(WETH), shield], WETH) : [])];
  return P.withPrepared(t, fresh);
}

/** Run one step to done (sign, then confirm). */
function done(t: P.TopUp, i: number, nonce: number): P.TopUp {
  return P.onConfirmed(P.onSigned(P.onActive(t, i), i, { raw: `0x02${i}`, hash: h(i + 1), nonce }), i);
}

describe("top-up steps", () => {
  it("classifies wrap, approve and deposit and labels each state", () => {
    const s = P.stepsOf("WETH", [wrap, approve(WETH), shield], WETH);
    expect(s.map((x) => x.kind)).toEqual(["wrap", "approve", "deposit"]);
    expect(s.map(P.stepLabel)).toEqual(["Wrapping ETH…", "Approving WETH…", "Depositing WETH…"]);
    expect(P.stepLabel({ ...s[2]!, status: "done" })).toBe("Deposited WETH");
    expect(P.stepLabel({ ...s[1]!, status: "failed" })).toBe("Approving WETH failed");
    expect(P.stepName(s[2]!)).toBe("WETH deposit");
  });

  it("rejects a plan that doesn't end in exactly one deposit", () => {
    expect(() => P.stepsOf("USDC", [approve(USDC)], WETH)).toThrow();
    expect(() => P.stepsOf("USDC", [shield, approve(USDC)], WETH)).toThrow();
    expect(() => P.stepsOf("USDC", [shield, shield], WETH)).toThrow();
  });

  it("starts by preparing every token, then sends steps in order, then waits for POI", () => {
    const t0 = P.newTopUp({ USDC: 1n, WETH: 6n }, { usdc: 0n, weth: 0n });
    expect(P.nextAction(t0)).toEqual({ do: "prepare", tokens: ["USDC", "WETH"] });
    let t = prepared();
    expect(P.nextAction(t)).toEqual({ do: "send", i: 0 });
    for (let i = 0; i < t.steps.length; i++) t = done(t, i, 10 + i);
    expect(P.nextAction(t)).toEqual({ do: "poi" });
    expect(P.nextAction(P.onSpendable(P.onPoiStart(t, 0)))).toEqual({ do: "none" });
  });

  it("a retry after a failure with signed bytes resumes the same tx (never signs again)", () => {
    let t = P.onSigned(P.onActive(prepared(), 0), 0, { raw: "0x02aa", hash: h(1), nonce: 4 });
    t = P.onStepFailed(t, 0, "timeout");
    expect(t.stage).toBe("failed");
    expect(P.nextAction(t)).toEqual({ do: "resume", i: 0 });
    expect(P.canStartNew(t)).toBe(false); // possibly in flight: settle it first
  });

  it("a failure before signing re-sends that step", () => {
    const t = P.onStepFailed(P.onActive(prepared(), 0), 0, "user rejected");
    expect(P.nextAction(t)).toEqual({ do: "send", i: 0 });
    expect(P.canStartNew(t)).toBe(true);
  });

  it("a reverted step prepares again only the tokens not yet deposited, keeping done steps", () => {
    let t = prepared();
    t = done(t, 0, 1);
    t = done(t, 1, 2); // USDC deposited
    t = P.onSigned(P.onActive(t, 2), 2, { raw: "0x02bb", hash: h(9), nonce: 3 });
    t = P.onStepFailed(t, 2, "reverted on chain", true);
    expect(P.nextAction(t)).toEqual({ do: "prepare", tokens: ["WETH"] });
    expect(P.canStartNew(t)).toBe(true);
    const again = P.withPrepared(t, P.stepsOf("WETH", [approve(WETH), shield], WETH)); // wrap already done on chain
    expect(again.steps.map((s) => `${s.token}:${s.kind}:${s.status}`)).toEqual(["USDC:approve:done", "USDC:deposit:done", "WETH:approve:todo", "WETH:deposit:todo"]);
    expect(again.stage).toBe("sending");
    expect(P.nextAction(again)).toEqual({ do: "send", i: 2 });
  });

  it("the next nonce is never below a signed step's nonce + 1 (lagging RPCs)", () => {
    let t = done(prepared(false), 0, 41);
    expect(P.minNonce(t)).toBe(42);
    t = P.onStepFailed(P.onSigned(P.onActive(t, 1), 1, { raw: "0x02", hash: h(2), nonce: 42 }), 1, "replaced", true);
    expect(P.minNonce(t)).toBe(42); // a replaced nonce is used by someone else; the RPC count covers it
  });

  it("is spendable only once the deposited amounts, net of the shield fee, are POI-valid on top of the baseline", () => {
    const t = prepared(); // baseline usdc 5, weth 0; deposits 1 USDC + 6 wei WETH
    expect(P.isSpendable(t, bal(5n, 997_500n, 0n, 6n))).toBe(false);
    expect(P.isSpendable(t, bal(997_505n, 0n, 0n, 6n))).toBe(false);
    expect(P.isSpendable(t, bal(997_505n, 0n, 6n))).toBe(true); // 6 wei: fee rounds to 0
    expect(P.isSpendable(t, bal(997_504n, 0n, 6n))).toBe(false);
    expect(P.isSpendable(prepared(false), bal(997_505n))).toBe(true);
  });

  it("nets the shield fee exactly as observed on Sepolia", () => {
    expect(P.netOfShield(200_000n)).toBe(199_500n); // 0.2 USDC -> 0.1995
    expect(P.netOfShield(6_000_000_000_000_000n)).toBe(5_985_000_000_000_000n); // 0.006 WETH -> 0.005985
  });

  it("counts down ~2 min, then gives up polling after 15 min", () => {
    const t = P.onPoiStart(prepared(), 1_000);
    expect(P.poiSecondsLeft(t, 1_000)).toBe(120);
    expect(P.poiSecondsLeft(t, 61_000)).toBe(60);
    expect(P.poiSecondsLeft(t, 500_000)).toBe(0);
    expect(P.poiGiveUp(t, 1_000 + P.POI_GIVE_UP_MS - 1)).toBe(false);
    expect(P.poiGiveUp(t, 1_000 + P.POI_GIVE_UP_MS)).toBe(true);
    expect(P.onPoiStart(t, 99_999).poiStartedAt).toBe(1_000); // a re-check keeps the original start
    expect(P.canStartNew(P.onSlow(t))).toBe(true);
  });

  it("a failed POI check retries the check, not the deposits", () => {
    let t = prepared(false);
    t = done(done(t, 0, 1), 1, 2);
    t = P.onPoiFailed(P.onPoiStart(t, 0), "network");
    expect(t.failedAt).toBe("poi");
    expect(P.nextAction(t)).toEqual({ do: "poi" });
    expect(P.canStartNew(t)).toBe(true);
  });
});

describe("balance hint", () => {
  const pub = "Sending ETH/USDC to your wallet is public balance. Tap Top up privately to move it into your private balance.";
  it("explains public vs private when nothing was deposited", () => {
    expect(P.balanceHint(undefined, false)).toBe(pub);
    expect(P.balanceHint(bal(0n), true)).toBe(pub);
  });
  it("explains pending when spendable is 0 but pending > 0", () => {
    expect(P.balanceHint(bal(0n, 5n), true)).toMatch(/privacy check/);
  });
  it("says nothing when there is spendable USDC, or before the first load", () => {
    expect(P.balanceHint(bal(1n, 5n), true)).toBeNull();
    expect(P.balanceHint(undefined, true)).toBeNull();
  });
});
