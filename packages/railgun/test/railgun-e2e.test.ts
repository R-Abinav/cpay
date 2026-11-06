import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { validateRailgunAddress } from "@railgun-community/wallet";
import {
  ByteUtils,
  RailgunEngine,
  ShieldNoteERC20,
} from "@railgun-community/engine";
import { getSharedSymmetricKey } from "@railgun-community/engine/utils/keys-utils.js";
import {
  deriveRailgunKeys,
  shieldToRailgun,
  shieldFromOneTime,
  broadcastUnshield,
  RAILGUN_ABI,
  RAILGUN_SMART_WALLET_SEPOLIA,
  USDC_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_EXPLORER,
} from "../src/index.js";

vi.mock("../src/browser-engine.js", () => ({
  proveUnshieldInBrowser: vi.fn(),
  invalidateSpendableUSDC: vi.fn(),
}));

// Route handler import
import { POST as broadcastRoutePOST } from "../../../apps/web/app/api/railgun/broadcast/route.js";
import { proveUnshieldInBrowser } from "../src/browser-engine.js";

describe("Railgun End-to-End Verification", () => {
  const TEST_SEED_HEX = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
  const TEST_DESTINATION: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const BROADCASTER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

  function stubRpcFetch(txHash = "0xbroadcasttxhash12345") {
    const sentTxs: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init && init.body && typeof init.body === "string") {
          try {
            const body = JSON.parse(init.body);

            const handleSingle = (req: any) => {
              const m = req.method;
              switch (m) {
                case "eth_chainId":
                  return "0xaa36a7"; // 11155111
                case "eth_getTransactionCount":
                  return "0x1";
                case "eth_getBlockByNumber":
                  return { baseFeePerGas: "0x3b9aca00", number: "0x1000", timestamp: "0x66000000" };
                case "eth_maxPriorityFeePerGas":
                  return "0x3b9aca00";
                case "eth_gasPrice":
                  return "0x3b9aca00";
                case "eth_estimateGas":
                  return "0x7a120";
                case "eth_sendRawTransaction":
                  sentTxs.push(req.params[0]);
                  return txHash;
                case "eth_getTransactionReceipt":
                  return {
                    status: "0x1",
                    transactionHash: txHash,
                    blockNumber: "0x1001",
                    blockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                  };
                default:
                  return "0x0";
              }
            };

            if (Array.isArray(body)) {
              return new Response(
                JSON.stringify(body.map((req) => ({ jsonrpc: "2.0", id: req.id, result: handleSingle(req) }))),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handleSingle(body) }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          } catch {}
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: "0x0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    return sentTxs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BROADCASTER_PRIVATE_KEY", BROADCASTER_KEY);
    vi.stubEnv("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // Requirement 1: Genuine 0zk Key & Address Derivation
  // =========================================================================
  describe("1. Genuine Railgun 0zk Key Derivation", () => {
    it("derives genuine Railgun 0zk keys and a valid 0zk address matching official Railgun specification", () => {
      const keys = deriveRailgunKeys(TEST_SEED_HEX);

      // Verify all cryptographic key components are formatted as 32-byte hex strings
      expect(keys.spendingKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(keys.viewingKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(keys.masterPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(keys.npk).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify standard 12-word BIP-39 mnemonic
      const words = keys.mnemonic.trim().split(/\s+/);
      expect(words).toHaveLength(12);

      // Verify official 0zk address prefix and checksum validation
      expect(keys.railgunAddress.startsWith("0zk1")).toBe(true);
      expect(keys.railgunAddress.length).toBeGreaterThan(60);
      expect(validateRailgunAddress(keys.railgunAddress)).toBe(true);

      // Verify the address decodes to genuine master and viewing public keys
      const decoded = RailgunEngine.decodeAddress(keys.railgunAddress);
      expect(decoded.masterPublicKey).toBe(BigInt(keys.masterPublicKey));
      expect(decoded.viewingPublicKey).toBeInstanceOf(Uint8Array);
      expect(decoded.viewingPublicKey.length).toBe(32);
    });

    it("accepts seed as hex with 0x, hex without 0x, and Uint8Array interchangeably", () => {
      const rawHex = TEST_SEED_HEX.slice(2);
      const uint8 = Buffer.from(rawHex, "hex");

      const fromWith0x = deriveRailgunKeys(TEST_SEED_HEX);
      const fromWithout0x = deriveRailgunKeys(rawHex as Hex);
      const fromUint8 = deriveRailgunKeys(uint8);

      expect(fromWith0x.railgunAddress).toBe(fromWithout0x.railgunAddress);
      expect(fromWith0x.railgunAddress).toBe(fromUint8.railgunAddress);
      expect(fromWith0x.mnemonic).toBe(fromUint8.mnemonic);
      expect(fromWith0x.spendingKey).toBe(fromUint8.spendingKey);
      expect(fromWith0x.viewingKey).toBe(fromUint8.viewingKey);
    });
  });

  // =========================================================================
  // Requirement 2: Deterministic Derivation
  // =========================================================================
  describe("2. Deterministic Derivation from 32-Byte Seed", () => {
    it("consistently derives identical keys and 0zk address from identical seed", () => {
      const run1 = deriveRailgunKeys(TEST_SEED_HEX);
      const run2 = deriveRailgunKeys(TEST_SEED_HEX);
      const run3 = deriveRailgunKeys(TEST_SEED_HEX);

      expect(run1.railgunAddress).toBe(run2.railgunAddress);
      expect(run2.railgunAddress).toBe(run3.railgunAddress);
      expect(run1.mnemonic).toBe(run2.mnemonic);
      expect(run1.spendingKey).toBe(run2.spendingKey);
      expect(run1.viewingKey).toBe(run2.viewingKey);
      expect(run1.masterPublicKey).toBe(run2.masterPublicKey);
      expect(run1.npk).toBe(run2.npk);
    });

    it("produces strictly distinct keys and addresses for differing seeds", () => {
      const seedA = keccak256(new Uint8Array([1, 2, 3, 4]));
      const seedB = keccak256(new Uint8Array([5, 6, 7, 8]));

      const keysA = deriveRailgunKeys(seedA);
      const keysB = deriveRailgunKeys(seedB);

      expect(keysA.railgunAddress).not.toBe(keysB.railgunAddress);
      expect(keysA.mnemonic).not.toBe(keysB.mnemonic);
      expect(keysA.spendingKey).not.toBe(keysB.spendingKey);
      expect(keysA.viewingKey).not.toBe(keysB.viewingKey);
      expect(validateRailgunAddress(keysA.railgunAddress)).toBe(true);
      expect(validateRailgunAddress(keysB.railgunAddress)).toBe(true);
    });
  });

  // =========================================================================
  // Requirement 3: ShieldNoteERC20 Cryptography & ABI Serialization
  // =========================================================================
  describe("3. ShieldNoteERC20 Cryptography & Contract ABI Serialization", () => {
    it("creates a valid ShieldNoteERC20 with authentic ECDH shared symmetric key and AES encryption", async () => {
      const keys = deriveRailgunKeys(TEST_SEED_HEX);
      const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(keys.railgunAddress);

      const random = ByteUtils.randomHex(16);
      const amount = 5_000_000n; // 5 USDC
      const shieldNote = new ShieldNoteERC20(masterPublicKey, random, amount, getAddress(USDC_SEPOLIA));

      // 1. Sender encrypts note using ephemeral shield private key and recipient's viewing public key
      const ephemeralShieldPrivateKey = ByteUtils.randomHex(32);
      const serialized = await shieldNote.serialize(
        ByteUtils.hexToBytes(ephemeralShieldPrivateKey),
        viewingPublicKey
      );

      // 2. Verify serialized preimage structure matches contract expectation
      expect(serialized.preimage.npk).toMatch(/^0x[0-9a-f]{64}$/);
      expect(serialized.preimage.value).toBe(amount);
      expect(getAddress(String(serialized.preimage.token.tokenAddress))).toBe(getAddress(USDC_SEPOLIA));
      expect(serialized.preimage.token.tokenType).toBe(0); // ERC20

      // 3. Verify ciphertext bundle contains 3 words and shieldKey contains ephemeral public key
      expect(serialized.ciphertext.encryptedBundle).toHaveLength(3);
      for (const bundlePart of serialized.ciphertext.encryptedBundle) {
        expect(bundlePart).toMatch(/^0x[0-9a-f]{64}$/);
      }
      expect(serialized.ciphertext.shieldKey).toMatch(/^0x[0-9a-f]{64}$/);

      // 4. Authentic ECDH shared symmetric key verification:
      // Receiver derives shared symmetric key from their viewing private key and the ephemeral shieldKey
      const shieldKeyStr = String(serialized.ciphertext.shieldKey);
      const encryptedBundleStr = serialized.ciphertext.encryptedBundle.map((b) => String(b)) as [string, string, string];

      const receiverSharedKey = await getSharedSymmetricKey(
        ByteUtils.hexStringToBytes(keys.viewingKey),
        ByteUtils.hexStringToBytes(shieldKeyStr)
      );
      expect(receiverSharedKey).toBeDefined();

      // Receiver decrypts note random using AES-GCM with the derived ECDH shared key
      const decryptedRandom = ShieldNoteERC20.decryptRandom(
        encryptedBundleStr,
        receiverSharedKey!
      );
      expect(decryptedRandom).toBe(ByteUtils.hexlify(random));

      // 5. Unauthorized key cannot decrypt (tamper protection)
      const unauthorizedKeys = deriveRailgunKeys(keccak256(new Uint8Array([9, 9, 9])));
      const wrongSharedKey = await getSharedSymmetricKey(
        ByteUtils.hexStringToBytes(unauthorizedKeys.viewingKey),
        ByteUtils.hexStringToBytes(shieldKeyStr)
      );
      expect(() =>
        ShieldNoteERC20.decryptRandom(encryptedBundleStr, wrongSharedKey!)
      ).toThrow();
    });

    it("shieldToRailgun executes full allowance check, ABI encoding, and targets official proxy contract", async () => {
      const keys = deriveRailgunKeys(TEST_SEED_HEX);
      const mockAccount = privateKeyToAccount(keccak256(new Uint8Array([11, 22, 33])));

      let allowanceReadCalls = 0;
      let approvalCalls = 0;
      let shieldContractCall: any = null;

      const mockPublicClient: any = {
        readContract: vi.fn(async ({ functionName }) => {
          if (functionName === "allowance") {
            allowanceReadCalls++;
            return 0n; // Zero initial allowance triggers approve
          }
          return 0n;
        }),
        waitForTransactionReceipt: vi.fn(async ({ hash }) => ({
          status: "success",
          transactionHash: hash,
        })),
      };

      const mockWalletClient: any = {
        chain: { id: SEPOLIA_CHAIN_ID },
        writeContract: vi.fn(async (callParams) => {
          if (callParams.functionName === "approve") {
            approvalCalls++;
            return "0xapprove1234567890abcdef" as Hex;
          }
          if (callParams.functionName === "shield") {
            shieldContractCall = callParams;
            return "0xshield1234567890abcdef" as Hex;
          }
          throw new Error(`Unexpected contract call: ${callParams.functionName}`);
        }),
      };

      const amountToShield = 10_000_000n; // 10 USDC
      const receipt = await shieldToRailgun(
        mockWalletClient,
        mockPublicClient,
        USDC_SEPOLIA,
        amountToShield,
        keys,
        mockAccount
      );

      // Verify transaction receipt
      expect(receipt.txHash).toBe("0xshield1234567890abcdef");
      expect(receipt.explorerUrl).toBe(`${SEPOLIA_EXPLORER}/tx/0xshield1234567890abcdef`);
      expect(allowanceReadCalls).toBe(1);
      expect(approvalCalls).toBe(1);

      // Verify proxy contract address
      expect(shieldContractCall).not.toBeNull();
      expect(shieldContractCall.address.toLowerCase()).toBe(
        RAILGUN_SMART_WALLET_SEPOLIA.toLowerCase()
      );
      expect(shieldContractCall.functionName).toBe("shield");

      // Verify request structure passed into shield function
      const requests = shieldContractCall.args[0];
      expect(requests).toHaveLength(1);
      const req = requests[0];

      expect(req.preimage.value).toBe(amountToShield);
      expect(req.preimage.token.tokenAddress.toLowerCase()).toBe(USDC_SEPOLIA.toLowerCase());
      expect(req.preimage.token.tokenType).toBe(0);
      expect(req.ciphertext.encryptedBundle).toHaveLength(3);
      expect(req.ciphertext.shieldKey).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify ABI encoding matches official Railgun Proxy contract ABI
      const encodedCalldata = encodeFunctionData({
        abi: RAILGUN_ABI,
        functionName: "shield",
        args: [requests],
      });
      expect(encodedCalldata.startsWith("0x")).toBe(true);

      // Verify ABI decoding roundtrips with fidelity
      const decodedCalldata = decodeFunctionData({
        abi: RAILGUN_ABI,
        data: encodedCalldata,
      });
      expect(decodedCalldata.functionName).toBe("shield");
      const decodedRequests = decodedCalldata.args[0] as any[];
      expect(decodedRequests[0].preimage.value).toBe(amountToShield);
      expect(decodedRequests[0].preimage.token.tokenAddress.toLowerCase()).toBe(
        USDC_SEPOLIA.toLowerCase()
      );
    });

    it("shieldFromOneTime delegates cleanly from one-time stealth account", async () => {
      const keys = deriveRailgunKeys(TEST_SEED_HEX);
      const oneTimeAccount = privateKeyToAccount(keccak256(new Uint8Array([44, 55, 66])));

      const mockPublicClient: any = {
        readContract: vi.fn(async () => 1_000_000_000n), // Sufficient allowance
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
      };

      const mockWalletClient: any = {
        chain: { id: SEPOLIA_CHAIN_ID },
        writeContract: vi.fn(async () => "0xonetimeshieldtx" as Hex),
      };

      const receipt = await shieldFromOneTime(
        mockWalletClient,
        mockPublicClient,
        USDC_SEPOLIA,
        2_000_000n,
        keys,
        oneTimeAccount
      );

      expect(receipt.txHash).toBe("0xonetimeshieldtx");
      expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Requirement 4: Broadcast Unshield Route & ZK Prover Invocation
  // =========================================================================
  describe("4. Broadcast Unshield Route & Zero-Knowledge Verification", () => {
    let requestId = 0;
    const makeRequest = (body: Record<string, unknown>) =>
      new Request("http://localhost/api/railgun/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": `192.0.2.${++requestId}` },
        body: JSON.stringify(body),
      });

    const provedTransaction = {
      to: RAILGUN_SMART_WALLET_SEPOLIA,
      data: "0xabcdef123456789000112233445566778899aabbccddeeff" as Hex,
      value: "0",
    };

    it("fails visibly when the trusted proxy IP header is missing or invalid", async () => {
      const missing = new Request("http://localhost/api/railgun/broadcast", { method: "POST", body: "{}" });
      const invalid = new Request("http://localhost/api/railgun/broadcast", { method: "POST", headers: { "cf-connecting-ip": "not-an-ip" }, body: "{}" });
      expect((await broadcastRoutePOST(missing as any)).status).toBe(503);
      expect((await broadcastRoutePOST(invalid as any)).status).toBe(503);
    });

    it("rejects missing or invalid destination addresses and malformed proved transactions", async () => {
      const res1 = await broadcastRoutePOST(
        makeRequest({ transaction: provedTransaction }) as any
      );
      expect(res1.status).toBe(400);
      expect(await res1.json()).toEqual({ error: "Invalid destination address" });

      const res2 = await broadcastRoutePOST(
        makeRequest({ destination: "not-a-valid-address", transaction: provedTransaction }) as any
      );
      expect(res2.status).toBe(400);
      expect(await res2.json()).toEqual({ error: "Invalid destination address" });

      const invalid = await broadcastRoutePOST(makeRequest({ destination: TEST_DESTINATION, transaction: { ...provedTransaction, data: "0x123" } }) as any);
      expect(invalid.status).toBe(400);
    });

    it("rejects gas drops above the bounded sponsorship limit", async () => {
      const response = await broadcastRoutePOST(makeRequest({ destination: TEST_DESTINATION, transaction: provedTransaction, gasDropWei: "1000000000000001" }) as any);
      expect(response.status).toBe(400);
    });

    it("rejects malformed gas drop integers", async () => {
      const response = await broadcastRoutePOST(makeRequest({ destination: TEST_DESTINATION, transaction: provedTransaction, gasDropWei: "1e15" }) as any);
      expect(response.status).toBe(400);
    });

    it("fails closed when the dedicated broadcaster key is not configured", async () => {
      vi.stubEnv("BROADCASTER_PRIVATE_KEY", "");
      const response = await broadcastRoutePOST(makeRequest({ destination: TEST_DESTINATION, transaction: provedTransaction }) as any);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "Broadcaster: no broadcaster private key configured on server" });
    });

    it("broadcasts the already-proved transaction without receiving mnemonic or key material", async () => {
      stubRpcFetch("0xbroadcasttxhash12345");
      const res = await broadcastRoutePOST(
        makeRequest({
          destination: TEST_DESTINATION,
          transaction: provedTransaction,
          gasDropWei: "300000000000000",
        }) as any
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.txHash).toBe("0xbroadcasttxhash12345");
      expect(body.destination).toBe(TEST_DESTINATION);
      expect(body.broadcaster).toBe(privateKeyToAccount(BROADCASTER_KEY).address);
      expect(body).not.toHaveProperty("mnemonic");
    });

    it("preserves a completed unshield when the gas drop fails", async () => {
      vi.stubEnv("BROADCASTER_PRIVATE_KEY", BROADCASTER_KEY);
      vi.stubEnv("BROADCASTER_GAS_SPONSOR_PRIVATE_KEYS", `${BROADCASTER_KEY},0x0000000000000000000000000000000000000000000000000000000000000001`);
      const unshieldAbi = parseAbi(["event Unshield(address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)"]);
      const topics = encodeEventTopics({ abi: unshieldAbi, eventName: "Unshield" });
      const data = encodeAbiParameters(
        parseAbiParameters("address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee"),
        [TEST_DESTINATION, { tokenType: 0, tokenAddress: USDC_SEPOLIA, tokenSubID: 0n }, 1_000_000n, 0n],
      );
      const walletClient = { sendTransaction: vi.fn().mockResolvedValueOnce("0xpayment").mockRejectedValueOnce(new Error("broadcaster has no ETH")) };
      const publicClient = { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: RAILGUN_SMART_WALLET_SEPOLIA, data, topics }] }) };
      const req = new Request("http://localhost/api/railgun/broadcast", {
        method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": `198.51.100.${++requestId}` },
        body: JSON.stringify({ destination: TEST_DESTINATION, transaction: provedTransaction, gasDropWei: "1" }),
      });
      const response = await broadcastRoutePOST(req as any, { walletClient, publicClient });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, txHash: "0xpayment", gasDropHash: null, gasDropError: "broadcaster has no ETH" });
    });

    it("skips gas drop when destination does not match unshield recipient", async () => {
      vi.stubEnv("BROADCASTER_PRIVATE_KEY", BROADCASTER_KEY);
      const unshieldAbi = parseAbi(["event Unshield(address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)"]);
      const topics = encodeEventTopics({ abi: unshieldAbi, eventName: "Unshield" });
      const actualRecipient = "0x1111111111111111111111111111111111111111" as Address;
      const data = encodeAbiParameters(
        parseAbiParameters("address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee"),
        [actualRecipient, { tokenType: 0, tokenAddress: USDC_SEPOLIA, tokenSubID: 0n }, 1_000_000n, 0n],
      );
      const walletClient = { sendTransaction: vi.fn().mockResolvedValueOnce("0xpayment") };
      const publicClient = { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: RAILGUN_SMART_WALLET_SEPOLIA, data, topics }] }) };
      const req = new Request("http://localhost/api/railgun/broadcast", {
        method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": `198.51.100.${++requestId}` },
        body: JSON.stringify({ destination: TEST_DESTINATION, transaction: provedTransaction, gasDropWei: "1" }),
      });
      const response = await broadcastRoutePOST(req as any, { walletClient, publicClient });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.txHash).toBe("0xpayment");
      expect(body.gasDropHash).toBeNull();
      expect(body.gasDropError).toBe("Gas drop skipped because the requested destination does not match the Railgun unshield recipient");
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("sends a matching gas drop from the configured sponsor pool", async () => {
      const sponsorKeys = [BROADCASTER_KEY, "0x0000000000000000000000000000000000000000000000000000000000000001"] as const;
      vi.stubEnv("BROADCASTER_PRIVATE_KEY", BROADCASTER_KEY);
      vi.stubEnv("BROADCASTER_GAS_SPONSOR_PRIVATE_KEYS", sponsorKeys.join(","));
      const eventAbi = parseAbi(["event Unshield(address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)"]);
      const topics = encodeEventTopics({ abi: eventAbi, eventName: "Unshield" });
      const data = encodeAbiParameters(
        parseAbiParameters("address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee"),
        [TEST_DESTINATION, { tokenType: 0, tokenAddress: USDC_SEPOLIA, tokenSubID: 0n }, 1_000_000n, 0n],
      );
      const walletClient = { sendTransaction: vi.fn().mockResolvedValueOnce("0xpayment").mockResolvedValueOnce("0xgasdrop") };
      const publicClient = { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: RAILGUN_SMART_WALLET_SEPOLIA, data, topics }] }) };
      const req = new Request("http://localhost/api/railgun/broadcast", {
        method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": `198.51.100.${++requestId}` },
        body: JSON.stringify({ destination: TEST_DESTINATION, transaction: provedTransaction, gasDropWei: "1" }),
      });
      const response = await broadcastRoutePOST(req as any, { walletClient, publicClient });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, txHash: "0xpayment", gasDropHash: "0xgasdrop", gasDropError: null });
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
      const sponsorAddress = walletClient.sendTransaction.mock.calls[1]![0].account.address;
      expect(sponsorKeys.map((key) => privateKeyToAccount(key).address)).toContain(sponsorAddress);
    });

    it("broadcastUnshield request includes only a proved transaction and bounded gas drop", async () => {
      const keys = deriveRailgunKeys(TEST_SEED_HEX);
      vi.mocked(proveUnshieldInBrowser).mockResolvedValueOnce({ ...provedTransaction, value: 0n });

      // 1. Success case
      const fakeFetchSuccess = vi.fn(async (url, init) => {
        const payload = JSON.parse(String(init?.body));
        expect(payload.destination).toBe(TEST_DESTINATION);
        expect(payload.transaction.data).toBe(provedTransaction.data);
        expect(payload.gasDropWei).toBe("0");
        expect(payload).not.toHaveProperty("mnemonic");

        return new Response(
          JSON.stringify({
            success: true,
            txHash: "0xbroadcaster999",
            broadcaster: privateKeyToAccount(BROADCASTER_KEY).address,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      vi.stubGlobal("fetch", fakeFetchSuccess);

      const result = await broadcastUnshield({
        destination: TEST_DESTINATION,
        amount: 3_000_000n,
        railgunKeys: keys,
      });

      expect(result.txHash).toBe("0xbroadcaster999");
      expect(result.explorerUrl).toBe(`${SEPOLIA_EXPLORER}/tx/0xbroadcaster999`);
      expect(result.gasPaidByBroadcaster).toBe(true);

      // 2. Failure case
      const fakeFetchError = vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "Broadcaster gas limit exceeded" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", fakeFetchError);
      vi.mocked(proveUnshieldInBrowser).mockResolvedValueOnce({ ...provedTransaction, value: 0n });

      await expect(
        broadcastUnshield({
          destination: TEST_DESTINATION,
          amount: 3_000_000n,
          railgunKeys: keys,
        })
      ).rejects.toThrow("Railgun Broadcaster failed: Broadcaster gas limit exceeded");
    });
  });
});
