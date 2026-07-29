# syntax=docker/dockerfile:1
# BuildKit `--mount=type=cache` (below) requires this syntax directive.
#
# IMPORTANT: this Dockerfile expects the BUILD CONTEXT to be the REPO ROOT
# (the pnpm workspace root), not api-server/, so the workspace lockfile is
# reachable and the install can be pinned with --frozen-lockfile.
#
# Coolify: set "Base Directory" to `/` and "Dockerfile Location" to
# `/api-server/Dockerfile`.
# Docker CLI: `docker build -f api-server/Dockerfile .` from the repo root.
FROM node:24-slim

WORKDIR /app

# openssl is required by the Prisma engines; curl fetches the RDS CA bundle.
# Cache the apt archive so repeat builds skip re-downloading the .debs.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl

RUN npm install -g pnpm@11

# CI=true stops pnpm from ever prompting (e.g. modules-purge confirmation).
# SKIP_SIMPLE_GIT_HOOKS neutralises the root `prepare` (simple-git-hooks), which
# would otherwise fail — .git is not in the image.
ENV CI=true
ENV SKIP_SIMPLE_GIT_HOOKS=1

# --- deps layer -----------------------------------------------------------
# Copy ONLY the workspace manifests + lockfile first, so this layer (the slow
# install) is reused whenever source changes but dependencies don't.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api-server/package.json ./api-server/
COPY typescript-sdk/package.json ./typescript-sdk/
COPY integration-tests/typescript/package.json ./integration-tests/typescript/
COPY integration-tests/cross-sdk/package.json ./integration-tests/cross-sdk/

# --frozen-lockfile pins to the committed lockfile (reproducible, and it lets
# pnpm verify deps instead of trying to reinstall at build/run time).
# `{./api-server}...` selects the package in ./api-server plus any workspace
# deps it needs (pnpm filters by dir with the {} syntax, not by folder name).
# The cache mount persists the pnpm store across builds; pnpm copies from it
# into node_modules, so the image stays self-contained once it detaches.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --frozen-lockfile --dangerously-allow-all-builds \
    --filter "{./api-server}..." --store-dir=/pnpm-store

# --- build ----------------------------------------------------------------
COPY . .

# prisma.config.ts requires DATABASE_URL just to load; generate never connects,
# so a placeholder is enough at build time. The node adapter (standalone) emits
# api-server/dist/server/entry.mjs, launched below.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm --filter "{./api-server}" exec prisma generate \
    && pnpm --filter "{./api-server}" run build

RUN curl -sSf https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem

# Astro standalone server reads HOST/PORT from the environment.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["sh", "-c", "pnpm --filter \"{./api-server}\" exec prisma db push && node api-server/dist/server/entry.mjs"]
