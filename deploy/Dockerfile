# syntax=docker/dockerfile:1.7
# One image for the CPay backend: glasses hub, relay, issuer (and the one-shot Railgun artifact fetch).
# Build context = repo root:  docker compose -f deploy/docker-compose.yml build
# docker-compose.yml picks the command per service. No secrets are baked in: env comes from deploy/.env
# at run time, only the variables each service needs.
FROM node:22-bookworm-slim

# openssl: Prisma's query engine. ca-certificates: TLS to Supabase / World / GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Same pnpm as the lockfile was written with (Vercel uses the same pin: deploy/vercel-build.sh).
RUN npm install -g pnpm@12.16.1 && npm cache clean --force

ENV CI=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY . .

# Only the backend workspaces and their workspace deps (+ the root, which has tsx). Dev deps included:
# the services run TypeScript through tsx, like `pnpm hub|relay|issuer`.
RUN pnpm install --frozen-lockfile \
      --filter cpay \
      --filter "@cpay/glasses-kit..." \
      --filter "@cpay/relay..." \
      --filter "@cpay/issuer..." \
  && pnpm --filter @cpay/database db:generate \
  && pnpm --filter @cpay/database exec tsc -p . --noEmit false \
  && pnpm store prune

# Target of the artifacts volume (Docker copies this ownership into a new named volume).
RUN mkdir -p /srv/railgun-artifacts && chown node:node /srv/railgun-artifacts

ENV NODE_ENV=production
USER node
