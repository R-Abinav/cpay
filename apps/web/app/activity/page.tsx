"use client";
import Link from "next/link";
import { Page } from "../../components/app-shell.js";
import { ChevronIcon } from "../../components/icons.js";

// Payment history lives only on this phone. The encrypted on-device activity store comes with
// @cpay/wallet's ledger; until then each payment's tx link and 0G evidence show in Pay → Details.
export default function ActivityPage() {
  return (
    <Page>
      <section className="flex min-h-[40vh] flex-col justify-center text-center">
        <p className="text-xl font-semibold">History stays on this phone</p>
        <p className="mx-auto mt-2 max-w-xs text-sm text-neutral-400">
          On-device history isn&apos;t wired in this build yet. The current payment&apos;s transaction link and 0G request IDs are under Pay →
          Details.
        </p>
      </section>
      <Link href="/evidence" className="flex min-h-16 items-center justify-between gap-4 border-y border-neutral-900 py-3">
        <span>
          <span className="block font-semibold">0G evidence</span>
          <span className="block text-sm text-neutral-500">Public list of 0G request IDs, receipts and storage root hashes.</span>
        </span>
        <span className="text-neutral-600">
          <ChevronIcon />
        </span>
      </Link>
    </Page>
  );
}
