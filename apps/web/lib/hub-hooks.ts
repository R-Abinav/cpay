"use client";
// Hub-only hooks. Kept apart from lib/hooks.ts so the app shell (header + tabs, on every route) does not
// pull the wallet code into its first load.
import { useEffect, useState } from "react";
import { getHub, glassesState, type HubStatus } from "./hub-client.js";

export function useHubStatus(): HubStatus {
  const [s, set] = useState<HubStatus>(() => getHub().status);
  useEffect(() => getHub().onStatus(set), []);
  return s;
}

export function glassesLabel(s: HubStatus): { text: string; tone: "ok" | "warn" | "off" } {
  // Short pill text; same states as glassesState() (hub-client.ts). `online` is heartbeat-checked by the hub.
  if (s.conn === "connecting") return { text: "Connecting…", tone: "warn" };
  const st = glassesState(s);
  if (st === "paired") return { text: "Glasses paired", tone: "ok" };
  if (st === "offline") return { text: "Glasses offline", tone: "warn" };
  if (st === "restarted") return { text: "Glasses restarted", tone: "warn" };
  if (st === "unpaired") return { text: "Glasses not paired", tone: "off" };
  return { text: "Hub not configured", tone: "off" };
}
