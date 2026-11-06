import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { approvalPublicKey, signApprovalToken, verifyApprovalToken, type ApprovalPayload } from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";

const SK = "11".repeat(32);
const PK = approvalPublicKey(SK);
const NOW = 1_800_000_000;
const SUB = "ab".repeat(32);
const binding = {
  sessionId: "sess-1",
  amount: "7000000",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
};
const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => ({ v: 1, jti: "j-" + Math.random(), binding, subHash: SUB, exp: NOW + 300, ...over });
const opts = { expected: binding, subHash: SUB, publicKey: PK, now: NOW };

describe("verifyApprovalToken", () => {
  beforeEach(async () => {
    await _resetStorageForTests();
    globalThis.indexedDB = new IDBFactory();
  });

  it("accepts a good token, case-insensitive addresses", async () => {
    const t = signApprovalToken(payload(), SK);
    const r = await verifyApprovalToken(t, { ...opts, expected: { ...binding, to: binding.to.toLowerCase(), token: binding.token.toUpperCase().replace("0X", "0x") } });
    expect(r.ok).toBe(true);
  });
  it("rejects a reused jti", async () => {
    const t = signApprovalToken(payload({ jti: "once" }), SK);
    expect((await verifyApprovalToken(t, opts)).ok).toBe(true);
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "reused" });
  });
  it("rejects a bad signature (other key)", async () => {
    const t = signApprovalToken(payload(), "22".repeat(32));
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects a tampered payload", async () => {
    const [, sig] = signApprovalToken(payload(), SK).split(".");
    const forged = Buffer.from(JSON.stringify(payload({ binding: { ...binding, amount: "1" } }))).toString("base64url");
    expect(await verifyApprovalToken(`${forged}.${sig}`, opts)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it.each(["sessionId", "amount", "token", "to"] as const)("rejects a wrong binding field: %s", async (f) => {
    const other = f === "token" || f === "to" ? "0x0000000000000000000000000000000000000001" : "other";
    const t = signApprovalToken(payload({ binding: { ...binding, [f]: other } }), SK);
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "wrong_binding" });
  });
  it("rejects a wrong subHash", async () => {
    const t = signApprovalToken(payload({ subHash: "cd".repeat(32) }), SK);
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "wrong_sub" });
  });
  it("rejects an expired token (exp == now)", async () => {
    const t = signApprovalToken(payload({ exp: NOW }), SK);
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "expired" });
  });
  it("does not burn the jti of a rejected token", async () => {
    const t = signApprovalToken(payload({ jti: "keep" }), SK);
    expect((await verifyApprovalToken(t, { ...opts, subHash: "00" })).ok).toBe(false);
    expect((await verifyApprovalToken(t, opts)).ok).toBe(true);
  });
  it.each(["", "abc", "a.b.c", "!!.??"])("rejects malformed %j", async (t) => {
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "malformed" });
  });
  it("rejects a missing public key", async () => {
    const t = signApprovalToken(payload(), SK);
    expect(await verifyApprovalToken(t, { ...opts, publicKey: "" })).toEqual({ ok: false, reason: "no_public_key" });
  });
  it("supports an injected jti store", async () => {
    const used = new Set<string>();
    const store = { has: async (j: string) => used.has(j), add: async (j: string) => void used.add(j) };
    const t = signApprovalToken(payload({ jti: "x" }), SK);
    expect((await verifyApprovalToken(t, { ...opts, jtiStore: store })).ok).toBe(true);
    expect(used.has("x")).toBe(true);
  });
});
