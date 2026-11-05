"use client";

import { useState, useRef, type ChangeEvent } from "react";
import jsQR from "jsqr";
import Link from "next/link";

interface IntentResult {
  amount: string;
  token: string;
  recipient?: string;
  confidence?: number;
  error?: string;
}

export default function Stage1Page() {
  // Step 1: Scanner / Image upload
  const [address, setAddress] = useState<string>("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2: Prompt
  const [prompt, setPrompt] = useState<string>("send 0.001 ETH to this account");

  // Step 3: 0G AI state
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [parsedIntent, setParsedIntent] = useState<IntentResult | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [zgTrace, setZgTrace] = useState<any | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Step 4: Payment state
  const [isSending, setIsSending] = useState<boolean>(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  // Handle Image Upload & QR Detection
  const handleImageUpload = (e: ChangeEvent<HTMLInputElement>) => {
    setScanError(null);
    setAddress("");
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setImagePreview(dataUrl);

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setScanError("Failed to initialize canvas context");
          return;
        }

        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0, img.width, img.height);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);

        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code && code.data) {
          const raw = code.data.trim();
          // Extract 0x address from ethereum:0x... or plain 0x...
          const ethMatch = raw.match(/0x[a-fA-F0-9]{40}/);
          if (ethMatch) {
            setAddress(ethMatch[0]);
          } else {
            setScanError(`Scanned content found, but not an Ethereum address: "${raw.slice(0, 40)}"`);
          }
        } else {
          setScanError("No QR code detected in this image. Try another clear image or enter address manually.");
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  // Trigger 0G AI Private Computer Intent Model
  const handleParseWith0G = async () => {
    if (!prompt.trim()) return;
    setIsParsing(true);
    setParseError(null);
    setParsedIntent(null);
    setRequestId(null);
    setTxHash(null);
    setTxError(null);

    try {
      const res = await fetch("/api/stage1/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, recipient: address }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "0G Inference failed");
      }

      setParsedIntent(data.intent);
      setRequestId(data.requestId);
      setZgTrace({
        model: data.model,
        provider: data.provider,
        trustMode: data.trustMode,
      });
    } catch (err: any) {
      setParseError(err.message || "Failed to call 0G router");
    } finally {
      setIsParsing(false);
    }
  };

  // Execute with Agent Wallet (Server Autonomous)
  const handlePayWithAgentWallet = async () => {
    if (!address || !parsedIntent?.amount) return;
    setIsSending(true);
    setTxError(null);
    setTxHash(null);

    try {
      const res = await fetch("/api/stage1/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: address,
          amount: parsedIntent.amount,
          token: parsedIntent.token || "ETH",
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Transaction failed");
      }

      setTxHash(data.txHash);
    } catch (err: any) {
      setTxError(err.message || "Failed to execute payment");
    } finally {
      setIsSending(false);
    }
  };

  // Execute with Browser MetaMask
  const handlePayWithMetaMask = async () => {
    if (!address || !parsedIntent?.amount) return;
    setTxError(null);
    setTxHash(null);

    const eth = (window as any).ethereum;
    if (!eth) {
      setTxError("MetaMask extension not detected in this browser");
      return;
    }

    try {
      setIsSending(true);
      // Ensure MetaMask is on Base Sepolia (84532 -> 0x14a34)
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x14a34" }],
        });
      } catch (switchErr: any) {
        if (switchErr.code === 4902) {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x14a34",
                chainName: "Base Sepolia",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia.base.org"],
                blockExplorerUrls: ["https://sepolia.basescan.org"],
              },
            ],
          });
        }
      }

      const accounts = await eth.request({ method: "eth_requestAccounts" });
      const from = accounts[0];

      // Convert amount to hex wei
      const weiAmount = BigInt(Math.floor(Number(parsedIntent.amount) * 1e18));
      const hexValue = "0x" + weiAmount.toString(16);

      const hash = await eth.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: address,
            value: hexValue,
          },
        ],
      });

      setTxHash(hash);
    } catch (err: any) {
      setTxError(err.message || "MetaMask transaction rejected");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6 font-sans">
      <header className="flex items-center justify-between border-b border-neutral-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
              Stage 1 Demo
            </span>
            <span className="rounded-full bg-blue-500/20 px-2.5 py-0.5 text-xs font-semibold text-blue-400">
              0G Private Computer
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-bold">Scan & Agent Pay</h1>
          <p className="text-sm text-neutral-400">
            Upload address scanner $\to$ AI intent parsing $\to$ Base Sepolia settlement
          </p>
        </div>
        <Link href="/" className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800">
          ← Back
        </Link>
      </header>

      {/* Step 1: Image Upload / Scanner */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-sm ${address ? "bg-emerald-500 text-black font-bold" : "bg-neutral-800 text-neutral-300"}`}>
              {address ? "✓" : "1"}
            </span>
            Upload Address Scanner Image
          </h2>
          {address && (
            <span className="text-xs font-medium text-emerald-400">Address Detected</span>
          )}
        </div>

        <p className="mt-1 text-xs text-neutral-400">
          Upload a screenshot or photo of an Ethereum / MetaMask QR code scanner.
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            onChange={handleImageUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center gap-2 rounded-xl bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700 transition"
          >
            📁 Choose Scanner Image
          </button>

          <button
            onClick={() => setAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F")}
            className="text-xs text-neutral-400 underline hover:text-neutral-200"
          >
            Or use demo test address
          </button>
        </div>

        {scanError && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            {scanError}
          </div>
        )}

        {imagePreview && (
          <div className="mt-4 flex items-center gap-4">
            <img
              src={imagePreview}
              alt="Uploaded scan"
              className="h-20 w-20 rounded-lg border border-neutral-700 object-cover"
            />
            <div className="text-xs text-neutral-400">
              Scanned with <code className="text-emerald-400">jsQR</code> in-browser
            </div>
          </div>
        )}

        {/* Address display input */}
        <div className="mt-4">
          <label className="text-xs font-medium text-neutral-400">Recipient Address (Auto-populated):</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder="0x..."
            className="mt-1 w-full rounded-xl border border-neutral-700 bg-black/50 px-3.5 py-2.5 font-mono text-sm text-neutral-200 placeholder-neutral-600 focus:border-emerald-500 focus:outline-none"
          />
        </div>
      </section>

      {/* Step 2: Natural Language Prompt */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className={`grid h-7 w-7 place-items-center rounded-full text-sm ${parsedIntent ? "bg-emerald-500 text-black font-bold" : "bg-neutral-800 text-neutral-300"}`}>
            {parsedIntent ? "✓" : "2"}
          </span>
          Type Prompt for 0G AI
        </h2>

        <p className="mt-1 text-xs text-neutral-400">
          The natural language instruction that 0G Private Computer (<code className="text-emerald-400">glm-5.3</code>) will parse inside a TEE.
        </p>

        <div className="mt-3">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. send 0.001 ETH to this account"
            className="w-full rounded-xl border border-neutral-700 bg-black/50 px-3.5 py-2.5 text-sm text-neutral-200 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="text-neutral-500">Quick examples:</span>
          {["send 0.001 ETH to this account", "pay 0.002 ETH", "send 1 USDC to her"].map((ex) => (
            <button
              key={ex}
              onClick={() => setPrompt(ex)}
              className="rounded-lg bg-neutral-800/80 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <button
            onClick={handleParseWith0G}
            disabled={!address || isParsing}
            className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 transition"
          >
            {isParsing ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-black border-t-transparent" />
                Querying 0G Private Computer...
              </>
            ) : (
              <>✨ Parse with 0G AI (glm-5.3)</>
            )}
          </button>
        </div>

        {parseError && (
          <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {parseError}
          </div>
        )}
      </section>

      {/* Step 3: 0G Output & Parsed Intent */}
      {parsedIntent && (
        <section className="rounded-2xl border border-emerald-500/30 bg-emerald-950/10 p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-emerald-300">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-500 text-sm font-bold text-black">
                ✓
              </span>
              0G Intent Parsed
            </h2>
            {requestId && (
              <span className="rounded-full bg-neutral-800 border border-neutral-700 px-3 py-1 font-mono text-xs text-neutral-300">
                0G Request: {requestId.slice(0, 8)}...
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-neutral-800 bg-black/40 p-3">
              <span className="text-xs text-neutral-400">Token</span>
              <p className="mt-1 text-lg font-bold text-white">{parsedIntent.token || "ETH"}</p>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-black/40 p-3">
              <span className="text-xs text-neutral-400">Amount</span>
              <p className="mt-1 text-lg font-bold text-emerald-400">{parsedIntent.amount}</p>
            </div>
          </div>

          {zgTrace && (
            <div className="mt-3 flex items-center gap-4 text-xs text-neutral-400">
              <span>Model: <code className="text-neutral-200">{zgTrace.model}</code></span>
              <span>Trust: <code className="text-emerald-400">{zgTrace.trustMode}</code></span>
              <span>Attestation: <span className="text-emerald-400">TEE Sealed</span></span>
            </div>
          )}

          {/* Step 4: Execute Transaction */}
          <div className="mt-6 border-t border-neutral-800 pt-4">
            <h3 className="text-sm font-semibold text-neutral-200">Execute Base Sepolia Payment:</h3>
            <p className="text-xs text-neutral-400 mt-0.5">
              Choose autonomous Agent Wallet execution or browser MetaMask on Base Sepolia.
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={handlePayWithAgentWallet}
                disabled={isSending}
                className="flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-3 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-40 transition"
              >
                🤖 Pay via Agent Wallet (Autonomous)
              </button>

              <button
                onClick={handlePayWithMetaMask}
                disabled={isSending}
                className="flex items-center gap-2 rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition"
              >
                🦊 Pay via MetaMask (Base Sepolia)
              </button>
            </div>

            {isSending && (
              <div className="mt-3 flex items-center gap-2 text-xs text-neutral-300">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                Signing and submitting Base Sepolia transaction...
              </div>
            )}

            {txError && (
              <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                {txError}
              </div>
            )}

            {txHash && (
              <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  🎉 Payment Sent Successfully on Base Sepolia!
                </span>
                <p className="mt-1 text-xs text-neutral-300">
                  Transaction Hash: <code className="font-mono text-emerald-300">{txHash}</code>
                </p>
                <a
                  href={`https://sepolia.basescan.org/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 underline hover:text-emerald-300"
                >
                  View on BaseScan (Base Sepolia) ↗
                </a>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
