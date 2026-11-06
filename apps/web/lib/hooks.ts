"use client";
import { useEffect, useState } from "react";
import { getHub, type HubStatus } from "./hub-client.js";
import { onWallet, type UnlockedWallet } from "./wallet.js";

export function useHubStatus(): HubStatus {
  const [s, set] = useState<HubStatus>(() => getHub().status);
  useEffect(() => getHub().onStatus(set), []);
  return s;
}

export function useWallet(): UnlockedWallet | null {
  const [w, set] = useState<UnlockedWallet | null>(null);
  useEffect(() => onWallet(set), []);
  return w;
}

export function glassesLabel(s: HubStatus): { text: string; tone: "ok" | "warn" | "off" } {
  if (s.conn === "no_hub") return { text: "Hub not configured", tone: "off" };
  if (s.conn === "unpaired") return { text: "Glasses not paired", tone: "off" };
  if (s.conn !== "connected") return { text: "Connecting to hub…", tone: "warn" };
  // `online` is the hub's live view (heartbeat-checked), not just "paired".
  return s.online ? { text: "Glasses online", tone: "ok" } : { text: "Glasses not connected", tone: "warn" };
}
