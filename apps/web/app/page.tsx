import { MAX_PAYLOAD_BYTES } from "@cpay/protocol";

// Shell only. /receive and /pay are built by the frontend agent.
export default function Home() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">CPay</h1>
      <p className="mt-2 text-neutral-400">Your face picks you out but never identifies you.</p>
      <p className="mt-6 text-xs text-neutral-600">protocol v1 · relay max payload {MAX_PAYLOAD_BYTES / 1024} KB</p>
    </main>
  );
}
