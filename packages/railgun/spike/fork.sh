#!/usr/bin/env bash
# Local anvil fork of Sepolia for the no-funds proof dry run. Fork txs are NOT real txs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rpc="$(grep -E '^SEPOLIA_RPC_URL=' "$here/../../../apps/web/.env" | cut -d= -f2- | tr -d "\"'")"
exec anvil --fork-url "$rpc" --port "${PORT:-8546}" --silent
