// Local-mode wallet lifecycle in Node (no WebAuthn here, so createWallet falls back to "local").
// The passkey/PRF path needs a real browser + authenticator and is tested by hand on the phone.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createWallet, currentWallet, exportBackup, forgetWallet, hasWallet, importBackup, lock, prfSupported, unlock } from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";

describe("wallet (local mode)", () => {
  beforeEach(async () => {
    await _resetStorageForTests();
    globalThis.indexedDB = new IDBFactory();
    lock();
  });

  it("reports no PRF without WebAuthn", async () => {
    expect(await prfSupported()).toBe(false);
  });

  it("creates, unlocks to the same address, and forgets", async () => {
    expect(await hasWallet()).toBe(false);
    const w = await createWallet({ rpId: "localhost" });
    expect(w.mode).toBe("local");
    expect(w.address).toBe(w.account.address);
    expect(await hasWallet()).toBe(true);
    lock();
    expect(currentWallet()).toBeNull();
    const again = await unlock({ rpId: "localhost" });
    expect(again.address).toBe(w.address);
    expect(again.keys).toEqual(w.keys);
    await forgetWallet();
    expect(await hasWallet()).toBe(false);
    await expect(unlock({ rpId: "localhost" })).rejects.toThrow();
  });

  it("signs locally with the derived account", async () => {
    const w = await createWallet({ rpId: "localhost" });
    const sig = await w.account.signMessage({ message: "cpay" });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("exports and imports an encrypted backup", async () => {
    const w = await createWallet({ rpId: "localhost" });
    const backup = await exportBackup("correct horse battery", { scryptN: 2 ** 10 });
    expect(backup).not.toContain(w.keys.agentPrivateKey.slice(2));
    await forgetWallet();
    await expect(importBackup(backup, "wrong passphrase")).rejects.toThrow(/passphrase/);
    const restored = await importBackup(backup, "correct horse battery");
    expect(restored.address).toBe(w.address);
    lock();
    expect((await unlock({ rpId: "localhost" })).address).toBe(w.address);
  });

  it("refuses a short passphrase", async () => {
    await createWallet({ rpId: "localhost" });
    await expect(exportBackup("short")).rejects.toThrow();
  });
});
