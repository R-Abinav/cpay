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
export { ARTIFACT_VARIANTS, ARTIFACT_FILES, KOHAKU_ARTIFACT_PREFIX, rewriteArtifactUrl } from "./artifacts.js";
