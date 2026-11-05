import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-bold">CPay</h1>
        <p className="mt-2 text-neutral-400">Your face picks you out but never identifies you.</p>
      </header>
      <nav className="grid gap-3">
        <Link href="/receive" className="block rounded-2xl border border-neutral-700 p-5 hover:bg-neutral-900">
          <span className="block text-xl font-semibold">Receive (phone)</span>
          <span className="text-sm text-neutral-400">Enrol your face on-device, prove you&apos;re a unique human with World ID, get paid privately.</span>
        </Link>
        <Link href="/pay" className="block rounded-2xl border border-neutral-700 p-5 hover:bg-neutral-900">
          <span className="block text-xl font-semibold">Pay (laptop + glasses)</span>
          <span className="text-sm text-neutral-400">Look, hold CAPTURE, say &ldquo;Hey Pay, pay her 2 USDC&rdquo;, press CONFIRM.</span>
        </Link>
      </nav>
      <p className="text-xs text-neutral-600">No analytics, no trackers, no CDN. Models and WASM are served from this origin.</p>
    </main>
  );
}
