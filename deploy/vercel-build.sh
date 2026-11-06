#!/usr/bin/env bash
# Vercel install + build for apps/web (Root Directory = apps/web). Called from apps/web/vercel.json:
#   bash ../../deploy/vercel-build.sh install   -> pnpm install at the monorepo root
#   bash ../../deploy/vercel-build.sh build     -> Prisma client, @cpay/database dist, Kohaku WASM, next build
# pnpm is pinned (Vercel would otherwise pick pnpm 9/10 from the lockfile, or pnpm 6 for an override).
# The ~225 MB Railgun circuits are NOT built here: the browser loads them from
# NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL (our EC2 Caddy, deploy/README.md). Nothing here prints env values.
set -euo pipefail
PNPM_VERSION=12.16.1
pnpm_() { npx --yes "pnpm@${PNPM_VERSION}" "$@"; }
cd "$(dirname "$0")/.."

case "${1:-}" in
  install)
    pnpm_ install --frozen-lockfile
    ;;
  build)
    if [ -z "${NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL:-}" ]; then
      echo "vercel-build: NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL is not set (Railgun circuits would 404)" >&2
      exit 1
    fi
    pnpm_ --filter @cpay/database db:generate
    pnpm_ --filter @cpay/database exec tsc -p . --noEmit false
    pnpm_ --filter @cpay/railgun artifacts --wasm-only
    pnpm_ --filter @cpay/web build
    ;;
  *)
    echo "usage: vercel-build.sh install|build" >&2
    exit 2
    ;;
esac
