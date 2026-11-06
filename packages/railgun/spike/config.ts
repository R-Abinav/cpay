// Prints the Sepolia chain config baked into @kohaku-eth/railgun (no secrets).
import { initKohaku } from "./common.js";
import * as rg from "@kohaku-eth/railgun";

await initKohaku();
console.log(JSON.stringify(rg.chainConfigSepolia(), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
