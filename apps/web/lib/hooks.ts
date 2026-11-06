"use client";
import { useEffect, useState } from "react";
import { onWallet, type UnlockedWallet } from "./wallet.js";

export { glassesLabel, useHubStatus } from "./hub-hooks.js";

export function useWallet(): UnlockedWallet | null {
  const [w, set] = useState<UnlockedWallet | null>(null);
  useEffect(() => onWallet(set), []);
  return w;
}
