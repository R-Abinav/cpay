// The Railgun (Kohaku) client's own thread: sync and proving run here so the page never freezes.
// Started by lib/railgun.ts; the seed arrives by postMessage and stays in this worker's memory only.
// Nothing here logs. Artifact fetches are rewritten to our origin inside this worker (installArtifactFetch).
import { initRailgun, serveRailgun } from "@cpay/railgun";

serveRailgun(self as unknown as Parameters<typeof serveRailgun>[0], initRailgun);
