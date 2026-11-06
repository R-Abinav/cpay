import {
  startRailgunEngine,
  createRailgunWallet,
  loadProvider,
  ArtifactStore,
  getProver,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import {
  NetworkName,
  TXIDVersion,
  EVMGasType,
  type TransactionGasDetails,
} from "@railgun-community/shared-models";
import memdown from "memdown";
import * as snarkjs from "snarkjs";
import fs from "node:fs";
import path from "node:path";
import { type Address, type Hex } from "viem";

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CIRCUITS_DIR = path.resolve(process.cwd(), "circuits-cache");

// Filesystem-backed ArtifactStore caching circuit artifacts locally
const artifactStore = new ArtifactStore(
  async (filename: string) => {
    const fullPath = path.join(CIRCUITS_DIR, filename);
    if (!fs.existsSync(fullPath)) return null;
    return fs.promises.readFile(fullPath);
  },
  async (dir: string, filename: string, data: string | Buffer | Uint8Array) => {
    const targetDir = path.join(CIRCUITS_DIR, dir);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const fullPath = path.join(CIRCUITS_DIR, filename);
    await fs.promises.writeFile(fullPath, Buffer.from(data));
  },
  async (filename: string) => {
    const fullPath = path.join(CIRCUITS_DIR, filename);
    return fs.existsSync(fullPath);
  }
);

let isEngineStarted = false;
let isProviderLoaded = false;
const DB_ENCRYPTION_KEY = "0101010101010101010101010101010101010101010101010101010101010101";

export async function getRailgunServerEngine() {
  if (!isEngineStarted) {
    if (!fs.existsSync(CIRCUITS_DIR)) {
      fs.mkdirSync(CIRCUITS_DIR, { recursive: true });
    }

    const db = (memdown as any)("cpay");
    await startRailgunEngine(
      "cpay",
      db,
      false,
      artifactStore,
      false, // useNativeArtifacts
      false, // skipMerkletreeScans
      ["https://poi-sepolia.railgun.org"],
      []
    );

    getProver().setSnarkJSGroth16(snarkjs.groth16 as any);
    isEngineStarted = true;
  }

  if (!isProviderLoaded) {
    const providerConfig = {
      chainId: 11155111,
      providers: [
        {
          provider: SEPOLIA_RPC_URL,
          priority: 1,
          weight: 2,
          maxLogsPerBatch: 2,
          stallTimeout: 2500,
        },
        {
          provider: "https://1rpc.io/sepolia",
          priority: 2,
          weight: 2,
          maxLogsPerBatch: 5,
        },
      ],
    };

    await loadProvider(providerConfig, NetworkName.EthereumSepolia, 15000);
    isProviderLoaded = true;
  }

  return {
    isReady: true,
  };
}

export interface ProveAndPopulateUnshieldParams {
  mnemonic: string;
  destination: Address;
  amount: bigint;
  tokenAddress: Address;
}

export async function proveAndPopulateUnshield(params: ProveAndPopulateUnshieldParams) {
  await getRailgunServerEngine();

  // Load user's Railgun wallet from mnemonic
  const walletInfo = await createRailgunWallet(
    DB_ENCRYPTION_KEY,
    params.mnemonic,
    { [NetworkName.EthereumSepolia]: 7000000 }
  );

  const erc20AmountRecipients = [
    {
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      recipientAddress: params.destination,
    },
  ];

  // 1. Generate zk-SNARK unshield proof
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.EthereumSepolia,
    walletInfo.id,
    DB_ENCRYPTION_KEY,
    erc20AmountRecipients,
    [], // no NFTs
    undefined, // broadcasterFeeERC20AmountRecipient
    false, // sendWithPublicWallet = false (submitted by Broadcaster)
    undefined, // overallBatchMinGasPrice
    (progress: number) => {
      console.log(`[Railgun ZK] Unshield proof progress: ${(progress * 100).toFixed(0)}%`);
    }
  );

  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 800000n,
    maxFeePerGas: 3000000000n,
    maxPriorityFeePerGas: 1500000000n,
  };

  // 2. Populate raw contract transaction with proof and nullifiers
  const { transaction } = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.EthereumSepolia,
    walletInfo.id,
    erc20AmountRecipients,
    [],
    undefined,
    false,
    undefined,
    gasDetails
  );

  return {
    walletId: walletInfo.id,
    railgunAddress: walletInfo.railgunAddress,
    transaction: {
      to: transaction.to as Address,
      data: transaction.data as Hex,
      value: transaction.value ? BigInt(transaction.value.toString()) : 0n,
    },
  };
}
