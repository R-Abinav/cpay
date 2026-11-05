import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cpay/protocol", "@cpay/stealth", "@cpay/credential", "@cpay/world", "@cpay/zerog"],
  webpack(config) {
    // Workspace TS uses `.js` import specifiers (NodeNext style).
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    // BBS (crypto-wasm-ts) and onnxruntime-web are WASM.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };
    return config;
  },
};

export default nextConfig;
