// @cpay/wallet: the on-device wallet. Keys are derived on the phone from the passkey (PRF) and
// never leave it; signing happens here. See docs/ARCHITECTURE.md "Implementation notes -> Wallet".
export { type Token, toBaseUnits, fromBaseUnits, USDC_DECIMALS } from "./amount.js";
export { type WalletKeys, deriveKeys, INFO, PRF_SALT } from "./keys.js";
export {
  type WalletHandle,
  hasWallet,
  walletMode,
  createWallet,
  unlock,
  lock,
  currentWallet,
  prfSupported,
  exportBackup,
  importBackup,
  forgetWallet,
} from "./passkey.js";
export {
  type ChainConfig,
  chainFromEnv,
  chainOf,
  balances,
  payDirect,
  txUrl,
  shieldAgentToRailgun,
  payFromRailgunToStealth,
} from "./chain.js";
export {
  deriveRailgunKeys,
  RAILGUN_SMART_WALLET_SEPOLIA,
  USDC_SEPOLIA,
  type RailgunWalletKeys,
} from "@cpay/railgun";
export { type QrResult, parseQr, addressQr } from "./qr.js";
export {
  type PolicySettings,
  type PolicyResult,
  evaluate,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsRaise,
  spentToday,
  recordSpend,
} from "./policy.js";
export { newConfirmCode, matchConfirm } from "./confirm.js";
export {
  type OneTimeDestination,
  type StealthKeys,
  type StoredDestination,
  type DestinationBalance,
  type SweepOneTimeParams,
  type PayOneTimeParams,
  DEFAULT_GAS_DROP_WEI,
  ONETIME_PREFIX,
  deriveStealthKeys,
  newOneTimeDestination,
  listOneTimeDestinations,
  oneTimeBalances,
  sweepOneTime,
  payOneTime,
} from "./onetime.js";
export { type AnswerQuoteParams, type Claim2Check, type VerifyClaim2Params, answerQuote, verifyClaim2 } from "./quote.js";
export {
  type ApprovalBinding,
  type ApprovalPayload,
  type ApprovalCheck,
  type JtiStore,
  verifyApprovalToken,
  signApprovalToken,
  approvalPublicKey,
} from "./approval.js";
