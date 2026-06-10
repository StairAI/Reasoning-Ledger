FROM node:24-slim

WORKDIR /app

# openssl is required by the Prisma engines; curl fetches the RDS CA bundle.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11

COPY package.json ./
# No lockfile here (the pnpm workspace lockfile lives at the repo root, outside
# this build context). --dangerously-allow-all-builds lets the postinstall
# scripts run (prisma engines, esbuild) that the workspace config normally
# approves via allowBuilds.
RUN pnpm install --dangerously-allow-all-builds

COPY . .

# prisma.config.ts requires DATABASE_URL just to load; generate never connects,
# so a placeholder is enough at build time.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm prisma generate \
    && pnpm build

RUN curl -sSf https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem

CMD ["sh", "-c", "pnpm prisma db push && node dist/index.js"]
