// Pay + sweep against a throwaway local anvil chain with a test-only ERC-20. Skipped if anvil isn't installed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import solc from "solc";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  KEY_DERIVATION_MESSAGE,
  createOneTimeDestination,
  keysFromSignature,
  payToDestination,
  recoverSpendKey,
  sweep,
} from "../src/index.js";

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;

// anvil's well-known dev account #0 (public test key, local chain only)
const DEV_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

function compileToken(): { abi: unknown[]; bytecode: Hex } {
  const source = readFileSync(new URL("./fixtures/TestToken.sol", import.meta.url), "utf8");
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "TestToken.sol": { content: source } },
        settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const c = out.contracts["TestToken.sol"].TestToken;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

describe.skipIf(!hasAnvil)("pay + sweep on local anvil", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let token: Address;

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    const pub = createPublicClient({ chain: foundry, transport: http(rpc) });
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch (e) {
        if (i > 100) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const { abi, bytecode } = compileToken();
    const wallet = createWalletClient({ account: privateKeyToAccount(DEV_KEY), chain: foundry, transport: http(rpc) });
    const hash = await wallet.deployContract({ abi, bytecode, args: [1_000_000_000n] });
    const r = await pub.waitForTransactionReceipt({ hash });
    token = r.contractAddress!;
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("pays USDC + gas drop to a recipient-generated address, which the recipient can sweep", async () => {
    const transport = http(rpc);
    const pub = createPublicClient({ chain: foundry, transport });
    const agent = privateKeyToAccount(DEV_KEY);

    const recipientWallet = privateKeyToAccount(generatePrivateKey());
    const keys = keysFromSignature(await recipientWallet.signMessage({ message: KEY_DERIVATION_MESSAGE }));
    const dest = createOneTimeDestination(keys);

    const gasDropWei = 300_000_000_000_000n;
    const res = await payToDestination({ account: agent, destination: dest.address, amount: 2_000_000n, gasDropWei, token, transport, chain: foundry });
    expect(res.gasDropHash).not.toBeNull();
    expect(await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [dest.address] })).toBe(2_000_000n);
    expect(await pub.getBalance({ address: dest.address })).toBe(gasDropWei);

    const sk = recoverSpendKey(keys, dest);
    const out = await sweep({ stealthPrivateKey: sk, to: recipientWallet.address, token, transport, chain: foundry });
    expect(out.amount).toBe(2_000_000n);
    expect(await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [dest.address] })).toBe(0n);
    expect(await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipientWallet.address] })).toBe(2_000_000n);
  }, 60_000);

  it("refuses to pay more than the agent wallet holds", async () => {
    const keys = keysFromSignature(await privateKeyToAccount(generatePrivateKey()).signMessage({ message: KEY_DERIVATION_MESSAGE }));
    const dest = createOneTimeDestination(keys);
    await expect(
      payToDestination({ account: privateKeyToAccount(DEV_KEY), destination: dest.address, amount: 10n ** 30n, token, transport: http(rpc), chain: foundry }),
    ).rejects.toThrow(/insufficient token balance/);
  });
});
