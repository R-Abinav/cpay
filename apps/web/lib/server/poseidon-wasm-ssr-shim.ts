// Railgun's browser WASM loaders resolve their asset URLs from window.location. During Next's
// server-side rendering there is no document origin, so let the SDK use its JavaScript fallbacks.
export default undefined;
export const poseidon = undefined;
export const poseidonHex = undefined;
