"use client";
import Link from "next/link";

// Payment history lives only on this phone. The encrypted on-device activity store comes with
// @cpay/wallet's ledger; until then each payment's tx link and 0G evidence show in the Pay scan log.
export default function ActivityPage() {
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Activity</h1>
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <p className="text-neutral-300">Your payment history is kept only on this phone. Nothing about it is stored on our servers.</p>
        <p className="mt-2 text-sm text-neutral-500">
          On-device history isn&apos;t wired in this build yet. The current payment&apos;s transaction link and 0G request IDs are in the Pay
          tab&apos;s scan log.
        </p>
      </section>
      <Link href="/evidence" className="block rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <span className="block text-lg font-semibold">0G evidence ↗</span>
        <span className="text-sm text-neutral-400">Public list of 0G request IDs, receipts and storage root hashes.</span>
      </Link>
    </main>
  );
}
