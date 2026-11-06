import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  approvalBindingCommit,
  approvalPublicKey,
  newApprovalSalt,
  signApprovalToken,
  verifyApprovalToken,
  type ApprovalPayload,
} from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";

const SK = "11".repeat(32);
const PK = approvalPublicKey(SK);
const NOW = 1_800_000_000;
const SUB = "ab".repeat(32);
const binding = {
  sessionId: "sess-1",
  amount: "7000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
};
const SALT = newApprovalSalt();
const COMMIT = approvalBindingCommit(binding, SALT);
const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => ({
  v: 2,
  jti: "j-" + Math.random(),
  bindingCommit: COMMIT,
  subHash: SUB,
  exp: NOW + 300,
  ...over,
});
const opts = { expected: binding, salt: SALT, subHash: SUB, publicKey: PK, now: NOW };

const b64u = (x: string) => Buffer.from(x).toString("base64url");
/** Sign an arbitrary JSON body the way the server does (to build v1 / odd tokens). */
function signRaw(obj: unknown): string {
  const body = b64u(JSON.stringify(obj));
  const sig = ed25519.sign(new TextEncoder().encode("cpay/v1/approval." + body), hexToBytes(SK));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

describe("approvalBindingCommit", () => {
  it("is deterministic, hex sha256, and case-insensitive on addresses", () => {
    expect(COMMIT).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalBindingCommit({ ...binding, to: binding.to.toLowerCase(), token: binding.token.toUpperCase().replace("0X", "0x") }, SALT)).toBe(COMMIT);
  });
  it("changes with every field and the salt", () => {
    const seen = new Set([COMMIT]);
    for (const f of ["sessionId", "amount", "token", "to"] as const) {
      seen.add(approvalBindingCommit({ ...binding, [f]: f === "token" || f === "to" ? "0x0000000000000000000000000000000000000001" : "x" }, SALT));
    }
    seen.add(approvalBindingCommit(binding, newApprovalSalt()));
    expect(seen.size).toBe(6);
  });
  it("length-prefixes fields (no ambiguity when moving bytes between fields)", () => {
    const a = approvalBindingCommit({ ...binding, sessionId: "ab", amount: "1" }, SALT);
    const b = approvalBindingCommit({ ...binding, sessionId: "a", amount: "b1" }, SALT);
    expect(a).not.toBe(b);
  });
  it("needs a 32-byte salt", () => {
    expect(() => approvalBindingCommit(binding, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

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
  it("the token carries no payment details", () => {
    const [body = ""] = signApprovalToken(payload(), SK).split(".");
    const json = Buffer.from(body, "base64url").toString();
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(["bindingCommit", "exp", "jti", "subHash", "v"]);
    for (const v of Object.values(binding)) expect(json.toLowerCase()).not.toContain(v.toLowerCase());
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
    const forged = b64u(JSON.stringify(payload({ bindingCommit: "00".repeat(32) })));
    expect(await verifyApprovalToken(`${forged}.${sig}`, opts)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it.each(["sessionId", "amount", "token", "to"] as const)("rejects a different payment: %s", async (f) => {
    const other = f === "token" || f === "to" ? "0x0000000000000000000000000000000000000001" : "other";
    const t = signApprovalToken(payload(), SK);
    expect(await verifyApprovalToken(t, { ...opts, expected: { ...binding, [f]: other } })).toEqual({ ok: false, reason: "wrong_binding" });
  });
  it("rejects a different salt", async () => {
    const t = signApprovalToken(payload(), SK);
    expect(await verifyApprovalToken(t, { ...opts, salt: newApprovalSalt() })).toEqual({ ok: false, reason: "wrong_binding" });
  });
  it("rejects a bad salt length", async () => {
    const t = signApprovalToken(payload(), SK);
    expect(await verifyApprovalToken(t, { ...opts, salt: new Uint8Array(31) })).toEqual({ ok: false, reason: "bad_salt" });
  });
  it("rejects old v1 tokens (plaintext binding)", async () => {
    const t = signRaw({ v: 1, jti: "v1", binding, subHash: SUB, exp: NOW + 300 });
    expect(await verifyApprovalToken(t, opts)).toEqual({ ok: false, reason: "malformed" });
    const t2 = signRaw({ v: 1, jti: "v1b", bindingCommit: COMMIT, subHash: SUB, exp: NOW + 300 });
    expect(await verifyApprovalToken(t2, opts)).toEqual({ ok: false, reason: "malformed" });
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
