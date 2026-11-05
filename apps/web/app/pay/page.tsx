import type { Metadata } from "next";
import { PayConsole } from "./pay-console.js";

export const metadata: Metadata = { title: "CPay · Pay" };

export default function PayPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 pb-16">
      <header>
        <h1 className="text-2xl font-bold">CPay · Payer console</h1>
        <p className="text-sm text-neutral-400">
          Glasses + earbuds in, agent wallet out. The AI only proposes an amount; this laptop&apos;s agent runtime checks the caps, World Agent
          Pass, the recipient&apos;s proof and your physical CONFIRM before it signs.
        </p>
      </header>
      <PayConsole />
    </main>
  );
}
