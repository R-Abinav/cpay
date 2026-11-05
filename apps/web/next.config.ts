import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@cpay/protocol",
    "@cpay/stealth",
    "@cpay/credential",
    "@cpay/world",
    "@cpay/zerog",
    "@cpay/glasses-kit",
  ],
  poweredByHeader: false,
  webpack(config) {
    // Workspace TS uses `.js` import specifiers (NodeNext style).
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    // BBS (crypto-wasm-ts) is WASM. onnxruntime-web is loaded from /ort (self-hosted), not bundled.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No referrer leaks to third parties (CROPS); camera/mic only from our own origin.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
