# syntax=docker/dockerfile:1
# BuildKit `--mount=type=cache` (below) requires this syntax directive.
#
# IMPORTANT: this Dockerfile expects the BUILD CONTEXT to be the REPO ROOT
# (the pnpm workspace root), not api-server/, so the workspace lockfile is
# reachable and the install can be pinned with --frozen-lockfile.
#
# Docker CLI: `docker build -f api-server/Dockerfile .` from the repo root.
# A platform that builds from source: set the build context (base directory)
# to the repo root and the Dockerfile path to `api-server/Dockerfile`.
#
# The image serves the /v1 API and the trace viewer (one Astro server). Its
# entrypoint, api-server/docker-entrypoint.sh, takes one subcommand:
#   start (default)  migrate, then serve
#   migrate          migrate and exit, as the migration account
#   serve            serve only, as the runtime account
# Releases are published as ghcr.io/stairai/reasoning-ledger by
# .github/workflows/server-image.yml.

# An exact Node release, so a rebuild gets the same runtime; bump it on purpose.
# bookworm is the Debian release the floating `node:24-slim` tag points at.
FROM node:24.21.0-bookworm-slim

# The pnpm major the CI workflows use (pnpm/action-setup, version 11).
ARG PNPM_VERSION=11.28.2

LABEL org.opencontainers.image.title="Reasoning Ledger server" \
      org.opencontainers.image.description="Reasoning Ledger API and trace viewer" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# openssl is required by the Prisma engines; curl fetches the RDS CA bundle and
# runs the health check.
# Cache the apt archive so repeat builds skip re-downloading the .debs.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl

RUN npm install -g "pnpm@${PNPM_VERSION}"

# The server runs as this unprivileged user. The entrypoint starts as root only
# to hand it the content directory, then drops to it with setpriv (util-linux,
# part of the base image; checked here so that a base image without it fails
# the build, not the first start). A container started with `--user 10001`
# never runs as root; its content directory must then be writable by 10001.
RUN groupadd --system --gid 10001 rl \
    && useradd --system --uid 10001 --gid rl --home-dir /home/rl --create-home \
       --shell /usr/sbin/nologin rl \
    && command -v setpriv

# CI=true stops pnpm from ever prompting (e.g. modules-purge confirmation).
# SKIP_INSTALL_SIMPLE_GIT_HOOKS turns the root `prepare` (simple-git-hooks) into
# a no-op, and SKIP_SIMPLE_GIT_HOOKS any hook it runs — .git is not in the image.
ENV CI=true
ENV SKIP_INSTALL_SIMPLE_GIT_HOOKS=1
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
# api-server/dist/server/entry.mjs, which the entrypoint launches.
#
# Then, in the same layer:
# - COPY keeps the build context's modes, so a checkout made under a
#   restrictive umask (027, 077) would be unreadable for rl. Only what rl
#   cannot read is changed, so a usual checkout adds nothing to this layer.
# - Without CONTENT_DIR, content is stored where the server has always kept it:
#   data/content in its working directory, /app/data/content. /app/data belongs
#   to rl, so the server can create its content directory there without a
#   volume, and a named volume mounted there starts out the same way. Its group
#   is root and may write, so a container that runs as root without
#   capabilities (which cannot override permissions) still can, as with earlier
#   images. api-server/data points at it, so operator commands, which run in
#   api-server/ (`pnpm --dir api-server ...`), find the same content.
# - The build fails unless rl can read everything under /app.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm --filter "{./api-server}" exec prisma generate \
    && pnpm --filter "{./api-server}" run build \
    && find /app \( -type d ! -perm -0005 -o -type f ! -perm -0004 \) \
       -exec chmod a+rX {} + \
    && install -d -o rl -g root -m 0775 /app/data \
    && ln -sT ../data /app/api-server/data \
    && setpriv --reuid=10001 --regid=10001 --clear-groups -- sh -euc ' \
       test -r api-server/docker-entrypoint.sh; \
       test -r api-server/dist/server/entry.mjs; \
       test -r api-server/node_modules/pg/package.json; \
       unreadable=$(find /app ! -type l \( ! -readable -o -type d ! -executable \) -print -quit); \
       test -z "$unreadable" || { echo "rl cannot read $unreadable" >&2; exit 1; }'

RUN curl -sSf https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem

# Astro standalone server reads HOST/PORT from the environment.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

# /health answers 200 while the server can reach its database. The start period
# covers the migrations `start` runs before the server listens.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-4321}/health" || exit 1

# Run through sh, so the script needs no execute bit in the build context.
ENTRYPOINT ["sh", "/app/api-server/docker-entrypoint.sh"]
CMD ["start"]
