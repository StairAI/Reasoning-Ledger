# Reasoning Ledger — API Server

The Trace Service: receives, stores and serves the records submitted by the SDKs, holds the raw content those records reference, and renders a trace viewer for signed-in owners.

## Tech stack

| Layer                | Technology                                                          |
| -------------------- | ------------------------------------------------------------------- |
| Server               | [Astro](https://astro.build) 7 with the Node adapter (standalone)   |
| HTTP API             | [oRPC](https://orpc.io) 1.x OpenAPI handler, mounted at `/v1`       |
| ORM                  | Prisma 7 with `@prisma/adapter-pg` (direct `pg` pool, no PgBouncer) |
| Database             | PostgreSQL 14+                                                      |
| Validation           | Zod 4, generated from [`schema/records.schema.json`](../schema/)    |
| Runtime              | Node.js 24                                                          |
| Tests                | Vitest, against a real PostgreSQL database                          |
| Linting / formatting | oxlint + oxfmt via `ultracite`                                      |

## Setup

Requires Node.js 24, pnpm 11 and PostgreSQL. Install from the repository root:

```sh
pnpm install
```

### Environment

| Variable                 | Required | Description                                                                                        |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes      | `postgres://` connection string the server uses (the runtime account)                              |
| `MIGRATION_DATABASE_URL` | No       | Account that runs migrations and operator commands; falls back to `DATABASE_URL`                   |
| `RL_RUNTIME_ROLE`        | No       | Role name of the runtime account; when set, `db:deploy` applies its privileges after migrating     |
| `CONTENT_DIR`            | No       | Where uploaded content is stored (default `data/content`, relative to `api-server/`)               |
| `CONTENT_MAX_BYTES`      | No       | Largest accepted upload, in bytes (default 64 MiB)                                                 |
| `RL_REGISTRATION`        | No       | Who may register owners: `admin` (default) or `open`                                               |
| `RL_ADMIN_TOKEN`         | No       | With `RL_REGISTRATION=admin`, owner registration needs this value in the `X-Admin-Token` header    |
| `RL_REGISTRATION_RATE`   | No       | With `RL_REGISTRATION=open`, registration attempts allowed per client address per hour (default 5) |
| `VIZ_SESSION_TTL_HOURS`  | No       | Lifetime of a trace viewer sign-in (default 12)                                                    |
| `HOST`, `PORT`           | No       | Where the built server listens (Astro defaults: `localhost`, `4321`)                               |

Uploaded content lives on the server's filesystem, so `CONTENT_DIR` needs storage that survives a restart or redeploy (a mounted volume in a container), and belongs in the same backup schedule as the database: a record keeps the hash of content whose bytes are gone, but the bytes cannot be recovered from it.

Connection strings must be direct `postgres://` connections. Pooling proxies in transaction mode are not supported: migrations take advisory locks.

### Database accounts

Production runs with two accounts. The migration account owns the schema and runs `db:deploy` and the operator commands. The runtime account is what the server connects as: it can append records but can never update or delete them, cannot write the content deletion log, and cannot read the migration history ([`prisma/grants.sql`](./prisma/grants.sql)). Create the runtime role once:

```sql
CREATE ROLE rl_runtime LOGIN PASSWORD '<password>';
```

Then migrate and apply its privileges, and point `DATABASE_URL` at `rl_runtime`:

```sh
MIGRATION_DATABASE_URL=postgres://<owner>@<host>/<db> RL_RUNTIME_ROLE=rl_runtime pnpm --dir api-server db:deploy
```

`db:deploy` is safe to run on every start; the Docker image does so before serving. For local development a single account is enough: set only `DATABASE_URL` and leave `RL_RUNTIME_ROLE` unset.

### Upgrading an existing database

A database created before migrations were used (by `prisma db push`) has no migration history. Baseline it once, then deploy as usual:

```sh
pnpm --dir api-server exec prisma migrate resolve --applied 20260428075327_init_schema
pnpm --dir api-server db:deploy
```

The 1.0 migrations keep all existing records. They relabel records stamped with the retired schema label `1.0` as `0.2`, and number existing records in the order the server received them.

## Running

```sh
pnpm --dir api-server dev                    # development server
pnpm --dir api-server build                  # production build
node api-server/dist/server/entry.mjs        # serve the build (reads HOST and PORT)
```

The [Dockerfile](./Dockerfile) builds from the repository root and runs `db:deploy` before starting the server.

## Testing

Run the whole gate from the repository root:

```sh
pnpm test:local
```

It creates a throwaway database, a runtime role and a content directory, runs the static checks and the unit suites, starts a built server on this machine, runs the integration suites against it, and removes everything afterwards. `pnpm test:static`, `pnpm test:unit` and `pnpm test:integration` run one part. See the comment at the top of [`scripts/test-local.mts`](../scripts/test-local.mts) for the Postgres it needs.

`pnpm test` in this package runs the unit suites alone; it needs `DATABASE_URL` pointing at a migrated database.

## Linting and type checking

```sh
pnpm check       # lint + format check (non-destructive)
pnpm fix         # auto-fix lint + format issues
pnpm typecheck   # TypeScript, after astro sync
```

## Operator commands

Both run on the server's host, with the same environment as the server.

```sh
# Delete stored content. Records keep their reference; reading the content then answers 410.
pnpm --dir api-server delete-content --owner <owner_id> --sha256 <hex> --reason "<why>" --operator "<who>"

# Export records for write-once storage, then verify an export against the database.
pnpm --dir api-server export-records --out <dir> [--batch 10000] [--settle-seconds 60]
pnpm --dir api-server export-records --verify <dir>
```

Deletion is deliberately not an API endpoint. It runs as the migration account and writes every deletion to the `content_deletions` log.

Export continues after the last batch already in `<dir>` and never overwrites a file. Each batch is a `records-<first>-<last>.jsonl` file in sequence order with a manifest holding its count and SHA-256. Records received within the last `--settle-seconds` are left for the next run. Copy `<dir>` to write-once storage (for example object storage with an object lock); `--verify` checks each batch against its manifest and against the database.

## Database schema

The schema is defined in [`prisma/schema.prisma`](./prisma/schema.prisma), with hand-written migrations in [`prisma/migrations/`](./prisma/migrations/). Key models:

| Model             | Table               | Description                                                                                                  |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Owner`           | `owners`            | One per account; holds `api_key_hash` (SHA-256 of the raw key)                                               |
| `Agent`           | `agents`            | One per reasoning-producing entity; unique on `(owner_id, name)`                                             |
| `TraceRecord`     | `trace_records`     | One per record; `record_id` is SDK-generated and the idempotency key; `sequence` is the server's total order |
| `ContentObject`   | `content_objects`   | Which owner uploaded which content hash, and whether it was deleted                                          |
| `ContentDeletion` | `content_deletions` | Append-only log of content deletions: owner, hash, reason, operator                                          |
| `VizSession`      | `viz_sessions`      | Trace viewer sign-ins                                                                                        |

`api_key` values are never stored raw — only the SHA-256 hex digest is persisted. The raw key is shown once at registration and cannot be recovered.

Records written as schema `0.1`–`0.3` keep their original shape. A database constraint requires the 0.4 fields (`executor`, `record_phase`) on every record stamped `0.4`.

## API endpoints

Authenticate with the owner's API key in the `X-API-Key` header. The API reference is served at `/v1` and the OpenAPI document at `/v1/spec.json`.

| Method         | Path                        | Description                                                                    |
| -------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `POST`         | `/v1/owners`                | Register an owner (see `RL_REGISTRATION`; not SDK surface)                     |
| `GET`          | `/v1/owners/me`             | The calling owner                                                              |
| `PATCH`        | `/v1/owners/me`             | Update owner metadata                                                          |
| `POST`         | `/v1/owners/me/rotate-key`  | Rotate the owner's API key                                                     |
| `POST`         | `/v1/agents`                | Register an agent (SDK: `registerAgent`)                                       |
| `GET`          | `/v1/agents?name=`          | Look up an agent by name (SDK: `resolveAgentId`)                               |
| `GET`, `PATCH` | `/v1/agents/{agent_id}`     | Read or update an agent                                                        |
| `POST`         | `/v1/records`               | Submit one record (SDK: `submit`)                                              |
| `POST`         | `/v1/records/batch`         | Submit up to 50 records, 1 MB in total (SDK: `submitBatch`)                    |
| `GET`          | `/v1/records/{record_id}`   | One record (SDK: `getRecord`)                                                  |
| `GET`          | `/v1/sessions/{session_id}` | The records of a session, in sequence order (SDK: `getSession`)                |
| `GET`          | `/v1/traces/{agent_id}`     | An agent's records, newest first, paginated by cursor (SDK: `getTrace`)        |
| `GET`          | `/v1/traces`                | The calling owner's sessions, most recent first                                |
| `PUT`          | `/v1/content/{sha256}`      | Upload raw content; the body's SHA-256 must equal the path (SDK: `putContent`) |
| `GET`, `HEAD`  | `/v1/content/{sha256}`      | Read uploaded content (SDK: `getContent`); `410` once deleted                  |

Every read is limited to the calling owner's data: another owner's agent, record or session answers `404`.

Records are written only as schema `0.4`. The server checks each record against the schema and the [cross-field rules](../schema/SCHEMA.md#cross-field-rules), and checks that the content it references was uploaded by the same owner.

## Trace viewer

The pages at `/` list the signed-in owner's sessions and render each session as a graph. Sign in at `/login` with an API key; the viewer keeps a server-side session in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie and shows only that owner's data. The `/v1` API does not use the cookie.

Content that records reference is read from the signed-in owner's content store and shown inline when it is text or JSON of up to 256 KiB; other content is described by its size and media type, and deleted content is marked as deleted. Sign-in and sign-out accept form posts only from the site's own pages (Astro's global origin check is off because it also blocks API clients; see `astro.config.mjs`).

## License

MIT
