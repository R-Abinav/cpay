import type { Metadata, Viewport } from "next";
import { ReceiveApp } from "./receive-app.js";

export const metadata: Metadata = { title: "CPay · Receive" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0a0a" };

export default function ReceivePage() {
  return (
    <main className="mx-auto max-w-md space-y-4 p-4 pb-16">
      <header>
        <h1 className="text-2xl font-bold">CPay · Receive</h1>
        <p className="text-sm text-neutral-400">Private by default. Your keys, card and face template stay on this phone.</p>
      </header>
      <ReceiveApp />
    </main>
  );
}
