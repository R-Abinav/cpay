"use client";
// Hub-only hooks. Kept apart from lib/hooks.ts so the app shell (header + tabs, on every route) does not
// pull the wallet code into its first load.
import { useEffect, useState } from "react";
import { getHub, type HubStatus } from "./hub-client.js";

export function useHubStatus(): HubStatus {
  const [s, set] = useState<HubStatus>(() => getHub().status);
  useEffect(() => getHub().onStatus(set), []);
  return s;
}

export function glassesLabel(s: HubStatus): { text: string; tone: "ok" | "warn" | "off" } {
  if (s.conn === "no_hub") return { text: "Hub not configured", tone: "off" };
  if (s.conn === "unpaired") return { text: "Glasses not paired", tone: "off" };
  if (s.conn !== "connected") return { text: "Connecting to hub…", tone: "warn" };
  // `online` is the hub's live view (heartbeat-checked), not just "paired".
  return s.online ? { text: "Glasses online", tone: "ok" } : { text: "Glasses not connected", tone: "warn" };
}
