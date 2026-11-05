import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-bold">CPay</h1>
        <p className="mt-2 text-neutral-400">Your face picks you out but never identifies you.</p>
      </header>
      <nav className="grid gap-3">
        <Link href="/stage1" className="block rounded-2xl border-2 border-emerald-500/60 bg-emerald-950/20 p-5 hover:bg-emerald-900/30 transition">
          <div className="flex items-center gap-2">
            <span className="block text-xl font-bold text-emerald-400">⚡ Stage 1 Demo: Scan & Agent Pay</span>
            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-400">Ready</span>
          </div>
          <span className="mt-1 block text-sm text-neutral-300">
            Upload address scanner image $\to$ prompt 0G AI (<code className="text-emerald-400 font-mono">glm-5.3</code>) $\to$ execute on Sepolia via Agent Wallet or MetaMask.
          </span>
        </Link>
        <Link href="/receive" className="block rounded-2xl border border-neutral-700 p-5 hover:bg-neutral-900 transition">
          <span className="block text-xl font-semibold">Receive (phone)</span>
          <span className="text-sm text-neutral-400">Enrol your face on-device, prove you&apos;re a unique human with World ID, get paid privately.</span>
        </Link>
        <Link href="/pay" className="block rounded-2xl border border-neutral-700 p-5 hover:bg-neutral-900 transition">
          <span className="block text-xl font-semibold">Pay (laptop + glasses)</span>
          <span className="text-sm text-neutral-400">Look, hold CAPTURE, say &ldquo;Hey Pay, pay her 2 USDC&rdquo;, press CONFIRM.</span>
        </Link>
      </nav>
      <p className="text-xs text-neutral-600">No analytics, no trackers, no CDN. Models and WASM are served from this origin.</p>
    </main>
  );
}
