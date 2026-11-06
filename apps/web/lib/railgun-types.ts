// Types of the real @cpay/railgun package (Kohaku). Type-only: lib/railgun.ts still loads the runtime lazily.
import type { RailgunClient, RailgunConfig } from "@cpay/railgun";
export type { RailgunStorage, RailgunConfig, TxData, PrivateBalances, RailgunClient } from "@cpay/railgun";
export type PrivatePayStage = "proving" | "submitting" | "confirming";
export type InitRailgun = (cfg: RailgunConfig) => Promise<RailgunClient>;
