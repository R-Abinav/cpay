"use client";
// "Delete my account": remove everything CPay holds about this user, on our servers and on this phone.
// On our side there is very little by design (CLAUDE.md invariant 3):
//   - issuer: the one (nullifier, action, commitment_hash) row for this holder -> POST /forget with C
//   - hub: the pairing (owner_token_hash) -> unpair (and the glasses drop it on their next power-on anyway)
//   - relay, 0G proxy: nothing stored. zg_evidence holds no user data and links to no one.
// Then this phone: wallet record, encrypted vault (World card, face template, one-time keys), Railgun data,
// local settings, caches and the service worker. Funds on chain are not touched.
import { forgetWithIssuer } from "./issuer-client.js";
import { getHub } from "./hub-client.js";
import { publicConfig } from "./public-config.js";
import { vaultWipe } from "./vault.js";
import { bbsSeed, forgetWallet, lockWallet } from "./wallet.js";

export interface DeleteReport {
  issuerRows: number | "skipped";
  glasses: "unpaired" | "not paired";
}

export async function deleteAccount(onStep: (s: string) => void): Promise<DeleteReport> {
  const seed = bbsSeed();
  if (!seed) throw new Error("Unlock your wallet first: deleting your World ID record needs your passkey.");

  // 1. Our servers first: if this fails, nothing local is wiped and the user can retry.
  let issuerRows: number | "skipped" = "skipped";
  if (publicConfig.issuerUrl) {
    onStep("Deleting your World ID record on our issuer…");
    const { initCredential, holderCommitFromSeed } = await import("@cpay/credential");
    await initCredential();
    const hc = await holderCommitFromSeed(seed.s, seed.blinding);
    issuerRows = await forgetWithIssuer(publicConfig.issuerUrl, hc.commitment);
  }

  onStep("Unpairing your glasses…");
  const hub = getHub();
  const wasPaired = hub.status.conn !== "unpaired" && hub.status.conn !== "no_hub";
  if (wasPaired) hub.unpair();

  // 2. This phone.
  onStep("Erasing everything on this phone…");
  lockWallet();
  await forgetWallet().catch(() => undefined);
  await vaultWipe().catch(() => undefined);
  await wipeBrowserStorage();
  return { issuerRows, glasses: wasPaired ? "unpaired" : "not paired" };
}

const KNOWN_DBS = ["cpay", "cpay-wallet"];

async function wipeBrowserStorage(): Promise<void> {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  let names = KNOWN_DBS;
  try {
    const list = await indexedDB.databases?.();
    if (list?.length) names = [...new Set([...KNOWN_DBS, ...list.map((d) => d.name).filter((n): n is string => !!n)])];
  } catch {
    /* Safari < 14: known names only */
  }
  await Promise.all(
    names.map(
      (n) =>
        new Promise<void>((ok) => {
          const r = indexedDB.deleteDatabase(n);
          r.onsuccess = r.onerror = () => ok();
          r.onblocked = () => ok(); // finishes once the page reloads and the open handles close
        }),
    ),
  );
  try {
    for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* ignore */
  }
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister();
  } catch {
    /* ignore */
  }
}
