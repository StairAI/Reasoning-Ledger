# syntax=docker/dockerfile:1
# BuildKit `--mount=type=cache` (below) requires this syntax directive.
FROM node:24-slim

WORKDIR /app

# openssl is required by the Prisma engines; curl fetches the RDS CA bundle.
# Cache the apt archive so repeat builds skip re-downloading the .debs.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl

RUN npm install -g pnpm@11

# Install deps first (separate layer) so this step is only re-run when
# package.json changes — source edits below don't bust the install cache.
COPY package.json ./
# No lockfile here (the pnpm workspace lockfile lives at the repo root, outside
# this build context). --dangerously-allow-all-builds lets the postinstall
# scripts run (prisma engines, esbuild) that the workspace config normally
# approves via allowBuilds. `--store-dir` pins the content-addressable store to
# the BuildKit cache mount, so unchanged deps are reused across builds instead
# of being refetched (pnpm copies from the store into node_modules, so the
# image stays self-contained after the cache mount is detached).
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --dangerously-allow-all-builds --store-dir=/pnpm-store

COPY . .

# prisma.config.ts requires DATABASE_URL just to load; generate never connects,
# so a placeholder is enough at build time. The node adapter (standalone) emits
# dist/server/entry.mjs, launched below.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm prisma generate \
    && pnpm build

RUN curl -sSf https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem

# Astro standalone server reads HOST/PORT from the environment.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["sh", "-c", "pnpm prisma db push && node ./dist/server/entry.mjs"]
