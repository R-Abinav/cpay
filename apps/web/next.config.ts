import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The monorepo keeps one .env at the repo root (see .env.example). Next only reads apps/web/.env*,
// so load the root file too. Existing env vars win (loadEnvFile never overrides).
const repoRoot = resolve(process.cwd(), "../..");
const rootEnv = resolve(repoRoot, ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.CPAY_REPO_ROOT ??= repoRoot;

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@cpay/protocol",
    "@cpay/stealth",
    "@cpay/credential",
    "@cpay/world",
    "@cpay/zerog",
    "@cpay/glasses-kit",
    "@cpay/wallet",
    "@cpay/railgun",
  ],
  // Prisma must load from node_modules at runtime (generated client + engine), not be bundled.
  serverExternalPackages: ["@cpay/database", "@prisma/client"],
  // Serverless hosts (Vercel) ship only traced files. Webpack still bundles the generated client, so the
  // tracer misses Prisma's query engine + schema under pnpm's .pnpm folder: include them for the API
  // routes (zg_evidence). The bundled client looks for them at <cwd>/../../node_modules/.pnpm/...
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    "/api/**/*": [
      "../../node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/schema.prisma",
      "../../node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/libquery_engine-*",
    ],
  },
  poweredByHeader: false,
  agentRules: false,
  webpack(config, { isServer, webpack }) {
    // @kohaku-eth/railgun has a Node-only WASM loader branch (dynamic node: imports); the browser
    // passes the WASM explicitly, so stub those modules out of client bundles.
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:(fs\/promises|url|path)$/, (r: { request: string }) => {
          r.request = r.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = { ...config.resolve.fallback, "fs/promises": false };
    }
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
