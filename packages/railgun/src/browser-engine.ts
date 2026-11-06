/// <reference path="./declarations.d.ts" />
import { ArtifactStore, createRailgunWallet, generateUnshieldProof, getProver, loadProvider, populateProvedUnshield, refreshBalances, setOnBalanceUpdateCallback } from "@railgun-community/wallet";
import { ChainType, EVMGasType, NetworkName, RailgunWalletBalanceBucket, TXIDVersion, type TransactionGasDetails } from "@railgun-community/shared-models";
import * as snarkjs from "snarkjs";
import { IndexedDBDown } from "./indexeddb-down.js";
import { RAILGUN_SMART_WALLET_SEPOLIA } from "./constants.js";
import type { RailgunWalletKeys } from "./keys.js";
import type { Address, Hex } from "viem";

const CHAIN = { type: ChainType.EVM, id: 11155111 };
const POI_URLS = ["https://poi-sepolia.railgun.org"];
const ARTIFACT_DB = "cpay-railgun-artifacts-v1";
const ARTIFACTS_CID = "QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU";
const POI_CID = "QmZ2MyM6TKxffkv6stuo2hFwmUfs3q4xgMYN164Sje8new";
const SCAN_MAX_AGE_MS = 60_000;
const SCAN_TIMEOUT_MS = 180_000;

type Tx = { to: Address; data: Hex; value: bigint };
type BalanceSnapshot = { value: bigint; scannedAt: number };
const balances = new Map<string, BalanceSnapshot>();
const walletIds = new Map<string, string>();
const scanWaiters = new Map<string, (value: BalanceSnapshot | null) => void>();
const scansInFlight = new Map<string, Promise<BalanceSnapshot | null>>();
let initPromise: Promise<void> | null = null;
let artifactDbPromise: Promise<IDBDatabase> | null = null;

function openArtifactDb(): Promise<IDBDatabase> {
  artifactDbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTIFACT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open Railgun artifact cache"));
  });
  return artifactDbPromise;
}

function artifactStore(): InstanceType<typeof ArtifactStore> {
  return new ArtifactStore(
    async (path) => {
      const db = await openArtifactDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction("files", "readonly").objectStore("files").get(path);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error("Could not read Railgun artifact cache"));
      });
    },
    async (_dir, path, data) => {
      const db = await openArtifactDb();
      await new Promise<void>((resolve, reject) => {
        const request = db.transaction("files", "readwrite").objectStore("files").put(data, path);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("Could not cache Railgun artifact"));
      });
    },
    async (path) => {
      const db = await openArtifactDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction("files", "readonly").objectStore("files").count(IDBKeyRange.only(path));
        request.onsuccess = () => resolve(request.result > 0);
        request.onerror = () => reject(request.error ?? new Error("Could not check Railgun artifact cache"));
      });
    },
  );
}

export async function installRailgunArtifactOriginInterceptor() {
  const axios = (await import("axios")).default;
  const marker = "cpayRailgunArtifactOriginInterceptor";
  const defaults = axios.defaults as typeof axios.defaults & { [marker]?: boolean };
  if (defaults[marker]) return;
  axios.interceptors.request.use((config) => {
    if (config.url?.startsWith("https://ipfs-lb.com/ipfs/")) {
      const artifactPath = new URL(config.url).pathname.replace(/^\/ipfs\//, "");
      config.url = `/api/railgun/artifacts/${artifactPath}`;
      config.baseURL = typeof location === "undefined" ? undefined : location.origin;
    }
    return config;
  });
  defaults[marker] = true;
}

async function startEngine() {
  if (typeof window === "undefined" || !globalThis.indexedDB) throw new Error("Railgun proving requires a browser with IndexedDB");
  await installRailgunArtifactOriginInterceptor();
  const rpc = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const { startRailgunEngine } = await import("@railgun-community/wallet");
  await startRailgunEngine(
    "cpay-device",
    new IndexedDBDown("cpay-railgun-engine-v1"),
    false,
    artifactStore(),
    false,
    false,
    POI_URLS,
    [],
  );
  getProver().setSnarkJSGroth16(snarkjs.groth16 as never);
  await loadProvider({
    chainId: 11155111,
    providers: [{ provider: rpc, priority: 1, weight: 2, maxLogsPerBatch: 2, stallTimeout: 2500 }],
  }, NetworkName.EthereumSepolia, 15_000);

  setOnBalanceUpdateCallback((event) => {
    if (event.chain.id !== CHAIN.id || event.balanceBucket !== RailgunWalletBalanceBucket.Spendable) return;
    const tokenAddress = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").toLowerCase();
    const amount = event.erc20Amounts.find((token) => token.tokenAddress.toLowerCase() === tokenAddress)?.amount ?? 0n;
    const snapshot = { value: amount, scannedAt: Date.now() };
    balances.set(event.railgunWalletID, snapshot);
    scanWaiters.get(event.railgunWalletID)?.(snapshot);
    scanWaiters.delete(event.railgunWalletID);
  });
}

async function ensureEngine() {
  initPromise ??= startEngine().catch((error) => { initPromise = null; throw error; });
  await initPromise;
}

async function ensureWallet(keys: RailgunWalletKeys): Promise<string> {
  await ensureEngine();
  const cached = walletIds.get(keys.railgunAddress);
  if (cached) return cached;
  // The engine encrypts its stored wallet records with this key. It is derived from the user's
  // spending secret and exists only in this browser session.
  const encryptionKey = keys.spendingKey.slice(2);
  const info = await createRailgunWallet(encryptionKey, keys.mnemonic, { [NetworkName.EthereumSepolia]: 7_000_000 });
  walletIds.set(keys.railgunAddress, info.id);
  return info.id;
}

export async function proveUnshieldInBrowser(params: {
  railgunKeys: RailgunWalletKeys;
  destination: Address;
  amount: bigint;
  tokenAddress: Address;
}): Promise<Tx> {
  const walletId = await ensureWallet(params.railgunKeys);
  const recipients = [{ tokenAddress: params.tokenAddress, amount: params.amount, recipientAddress: params.destination }];
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.EthereumSepolia,
    walletId,
    params.railgunKeys.spendingKey.slice(2),
    recipients,
    [],
    undefined,
    false,
    undefined,
    (progress: number) => { window.dispatchEvent(new CustomEvent("cpay:railgun-proof-progress", { detail: progress })); },
  );
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 800_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  };
  const populated = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.EthereumSepolia,
    walletId,
    recipients,
    [],
    undefined,
    false,
    undefined,
    gasDetails,
  );
  return {
    to: populated.transaction.to as Address,
    data: populated.transaction.data as Hex,
    value: populated.transaction.value ? BigInt(populated.transaction.value.toString()) : 0n,
  };
}

export async function getSpendableUSDC(keys: RailgunWalletKeys): Promise<{ balance: bigint; scannedAt: number } | null> {
  const walletId = await ensureWallet(keys);
  const cached = balances.get(walletId);
  if (cached && Date.now() - cached.scannedAt <= SCAN_MAX_AGE_MS) return { balance: cached.value, scannedAt: cached.scannedAt };
  const existingScan = scansInFlight.get(walletId);
  if (existingScan) {
    const existingResult = await existingScan;
    return existingResult && Date.now() - existingResult.scannedAt <= SCAN_MAX_AGE_MS
      ? { balance: existingResult.value, scannedAt: existingResult.scannedAt }
      : null;
  }
  let resolveScan!: (snapshot: BalanceSnapshot | null) => void;
  const completed = new Promise<BalanceSnapshot | null>((resolve) => { resolveScan = resolve; });
  scanWaiters.set(walletId, resolveScan);
  scansInFlight.set(walletId, completed);
  void refreshBalances(CHAIN, [walletId]).catch(() => {
    scanWaiters.get(walletId)?.(null);
    scanWaiters.delete(walletId);
  });
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), SCAN_TIMEOUT_MS));
  const result = await Promise.race([completed, timeout]);
  scansInFlight.delete(walletId);
  scanWaiters.delete(walletId);
  if (!result || Date.now() - result.scannedAt > SCAN_MAX_AGE_MS) return null;
  return { balance: result.value, scannedAt: result.scannedAt };
}

export function invalidateSpendableUSDC(railgunAddress: string) {
  const walletId = walletIds.get(railgunAddress);
  if (walletId) balances.delete(walletId);
}

export const RAILGUN_DEVICE_CHAIN = CHAIN;
export const RAILGUN_ARTIFACT_CIDS = { standard: ARTIFACTS_CID, poi: POI_CID };
export const RAILGUN_PROXY_ADDRESS = RAILGUN_SMART_WALLET_SEPOLIA;
