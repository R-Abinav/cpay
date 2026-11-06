// @cpay/railgun: real Railgun (Kohaku) private balance for the phone. See README.md for the hosts
// it contacts and how artifacts are self-hosted.
export type {
  RailgunConfig,
  RailgunStorage,
  TxData,
  NoteStatus,
  PrivateBalances,
  RailgunClient,
} from "./types.js";
export { initRailgun, TAIL_BLOCKS } from "./client.js";
export { FEE_RESERVE_WEI, UNSHIELD_FEE_BPS, canPayFrom, grossOf, privateNeeds, type CanPay, type PrivateNeeds } from "./needs.js";
export { ARTIFACT_VARIANTS, ARTIFACT_FILES, KOHAKU_ARTIFACT_PREFIX, rewriteArtifactUrl } from "./artifacts.js";
// Web Worker: serveRailgun() runs in the worker; the page imports "@cpay/railgun/worker-client" (no Kohaku).
export { serveRailgun } from "./worker-host.js";
export { isFromWorker, isToWorker, type FromWorker, type ToWorker, type WorkerConfig, type PayStage } from "./worker-protocol.js";
