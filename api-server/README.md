# Reasoning Ledger — API Server

The Trace Service: the HTTP API that receives, stores, and serves reasoning records submitted by Stair AI SDK clients.

## Tech stack

| Layer                | Technology                                                          |
| -------------------- | ------------------------------------------------------------------- |
| HTTP / RPC           | [oRPC](https://orpc.io) 1.x with OpenAPI plugin                     |
| ORM                  | Prisma 7 with `@prisma/adapter-pg` (direct `pg` pool, no PgBouncer) |
| Database             | PostgreSQL 14+                                                      |
| Validation           | Zod 4                                                               |
| Runtime              | Node.js 22+ (ESM)                                                   |
| Build                | tsup                                                                |
| Tests                | Vitest (integration tests against a live DB)                        |
| Linting / formatting | oxlint + oxfmt via `ultracite`                                      |

## Prerequisites

- **Node.js** 22+ (ESM required)
- **pnpm** 10.x — `npm i -g pnpm`
- **PostgreSQL** 14+ running and accessible

## Setup

### 1. Install dependencies

```sh
pnpm install
```

### 2. Configure environment

Copy `.env.example` to `.env` (or create `.env`) and set:

```sh
DATABASE_URL="postgres://user:password@host:5432/reasoning_ledger"
```

`DATABASE_URL` must be a direct `postgres://` connection string. Pooling proxies (e.g. PgBouncer in transaction mode) are not supported because Prisma uses advisory locks during migrations.

### 3. Run database migrations

```sh
npx prisma migrate deploy
```

For local development, `prisma migrate dev` creates a new migration file when the schema changes:

```sh
npx prisma migrate dev --name <description>
```

### 4. Generate the Prisma client

Migrations run `generate` automatically. If you need to regenerate manually:

```sh
npx prisma generate
```

## Running

### Development (watch mode)

```sh
pnpm dev
```

Builds with `tsup --watch` and restarts `node dist/index.js` on each change.

### Production

```sh
pnpm build
pnpm start
```

## Testing

Tests are integration tests that run against a real PostgreSQL database. Set `DATABASE_URL` in `.env` before running:

```sh
pnpm test
```

The test suite creates and tears down isolated data per test. Vitest runs all tests in `src/__tests__/`.

## Linting and formatting

```sh
pnpm check   # lint + format check (non-destructive)
pnpm fix     # auto-fix lint + format issues
```

## Database schema

The schema is defined in [`prisma/schema.prisma`](./prisma/schema.prisma). Key models:

| Model         | Table           | Description                                                                                    |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `Owner`       | `owners`        | One per partner org; holds `api_key_hash` (SHA-256 of raw key), wallet address, wallet mode    |
| `Agent`       | `agents`        | One per reasoning-producing entity; unique on `(owner_id, name)`; holds `agent_wallet_address` |
| `TraceRecord` | `trace_records` | One per submitted record; `record_id` is SDK-generated UUID v4 and the idempotency key         |

`api_key` values are never stored raw — only the SHA-256 hex digest (`api_key_hash`) is persisted. The raw key is shown to the owner once at registration and is not recoverable server-side.

## API endpoints

All routes are under `/v1`. Authentication uses the `Authorization: Bearer sl_<64 hex chars>` header.

| Method  | Path                       | Description                                         |
| ------- | -------------------------- | --------------------------------------------------- |
| `POST`  | `/v1/owners`               | Register a new owner (out-of-band; not SDK surface) |
| `PATCH` | `/v1/owners/me`            | Update owner metadata                               |
| `POST`  | `/v1/owners/me/rotate-key` | Rotate the owner's API key                          |
| `POST`  | `/v1/agents`               | Register a new agent (SDK: `registerAgent`)         |
| `GET`   | `/v1/agents`               | Look up an agent by name (SDK: `resolveAgentId`)    |
| `POST`  | `/v1/records`              | Submit a single record (SDK: `submit`)              |
| `POST`  | `/v1/records/batch`        | Submit up to 50 records (SDK: `submitBatch`)        |
| `GET`   | `/v1/records/:record_id`   | Fetch a single record (SDK: `getRecord`)            |
| `GET`   | `/v1/sessions/:session_id` | Fetch all records in a session (SDK: `getSession`)  |
| `GET`   | `/v1/traces`               | Paginated agent trace (SDK: `getTrace`)             |

An OpenAPI 3.1 spec is served at `/openapi.json`.

## Environment variables

| Variable       | Required | Description                             |
| -------------- | -------- | --------------------------------------- |
| `DATABASE_URL` | Yes      | `postgres://` connection string         |
| `PORT`         | No       | HTTP port to listen on (default `3000`) |

## License

MIT
