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

| Variable                 | Required | Description                                                                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes      | `postgres://` connection string the server uses (the runtime account)                                                |
| `MIGRATION_DATABASE_URL` | No       | Account that runs migrations and operator commands; falls back to `DATABASE_URL`                                     |
| `RL_RUNTIME_ROLE`        | No       | Role name of the runtime account; when set, `db:deploy` applies its privileges after migrating                       |
| `CONTENT_DIR`            | No       | Where uploaded content is stored (default `data/content` in the working directory: `/app/data/content` in the image) |
| `CONTENT_MAX_BYTES`      | No       | Largest accepted upload, in bytes (default 64 MiB)                                                                   |
| `RL_REGISTRATION`        | No       | Who may register owners: `admin` (default) or `open`                                                                 |
| `RL_ADMIN_TOKEN`         | No       | The instance administrator's token: reads every owner's data, and registers owners. Keep it to the operator          |
| `RL_REGISTRATION_TOKEN`  | No       | Registers owners and reads nothing. Give this one to the application that signs people up                            |
| `RL_REGISTRATION_RATE`   | No       | With `RL_REGISTRATION=open`, registration attempts allowed per client address per hour (default 5)                   |
| `VIZ_SESSION_TTL_HOURS`  | No       | Lifetime of a trace viewer sign-in (default 12)                                                                      |
| `HOST`, `PORT`           | No       | Where the built server listens (Astro defaults: `localhost`, `4321`)                                                 |

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

`db:deploy` is safe to run on every start; the image's default command does so before serving. For local development a single account is enough: set only `DATABASE_URL` and leave `RL_RUNTIME_ROLE` unset.

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

The [Dockerfile](./Dockerfile) builds from the repository root (`docker build -f api-server/Dockerfile .`); see [Running the published image](#running-the-published-image) for what the image runs.

Behind a reverse proxy, let request bodies through up to `CONTENT_MAX_BYTES` (64 MiB by default); nginx, for one, stops at 1 MB unless `client_max_body_size` says otherwise, and content uploads then fail with `413` before they reach the server. Point the proxy's or platform's health check at `/health`.

## Running the published image

Each server release is published as `ghcr.io/stairai/reasoning-ledger:<version>`, and the highest release also as `latest` (pre-releases only under their version). The image holds the `/v1` API and the trace viewer, which are one server. It is built from the [Dockerfile](./Dockerfile) by [`server-image.yml`](../.github/workflows/server-image.yml), which smoke-tests every build before publishing it. Pin a version in production.

The image takes one subcommand:

| Command           | What it does                                                        | Environment                                                                        |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `start` (default) | Migrates, then serves, in one container                             | `DATABASE_URL`; with two accounts also `MIGRATION_DATABASE_URL`, `RL_RUNTIME_ROLE` |
| `migrate`         | Runs `db:deploy` and exits                                          | `MIGRATION_DATABASE_URL` (or `DATABASE_URL`), `RL_RUNTIME_ROLE`                    |
| `serve`           | Serves only; the server process never sees `MIGRATION_DATABASE_URL` | `DATABASE_URL`                                                                     |

Any other command runs as given, for example `docker run --rm -it <image> sh` to look around. The rest of the [environment](#environment) applies as usual; the image sets `HOST=0.0.0.0` and `PORT=4321`, and its working directory is `/app`.

`start` keeps a deployment to one container. With `migrate` and `serve`, the migration account's credentials live only in a container that exits once the schema is current, and the long-running server holds the runtime account's alone.

Content is stored in `/app/data/content`, as with earlier images (`data/content` in the working directory): mount a volume at `/app/data`, or at `/app/data/content`, or set `CONTENT_DIR` to where yours is mounted. Without a volume, content is lost when the container is replaced. The container starts as root, gives the content directory and its per-owner directories to the image's unprivileged user `rl` (uid 10001) when they belong to someone else (a new bind mount usually belongs to root), and then runs everything as `rl`; stored objects keep their owner and only need to be readable. It stops with an error when the directory is not writable. To never run as root, start the container with `--user 10001` and make the directory writable for that uid yourself. A container that cannot switch users, or cannot give the content directory to `rl`, says so in its log and runs as root, as earlier images did: that happens without the `SETUID`, `SETGID` or `CHOWN` capability, for example with all capabilities dropped.

The first time you deploy this image over one that ran as root, replace the old container rather than start the new one beside it (a stop-first deploy, not a rolling update), or restart the new container once the old one is gone. While both run, the old one can create a directory for an owner's first upload that `rl` cannot write; the next start fixes it.

The image's health check calls `/health` on `$PORT`, and Docker reports the container healthy once the server answers.

### A single-host example

`compose.yaml`, with a `.env` file beside it that sets `DB_PASSWORD`, `RUNTIME_PASSWORD` and `RL_ADMIN_TOKEN` (for example from `openssl rand -hex 32`; hex keeps the passwords valid inside a URL):

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: ledger
      POSTGRES_USER: ledger # owns the database; the migration account
      POSTGRES_PASSWORD: ${DB_PASSWORD:?}
    volumes:
      - db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ledger -d ledger"]
      interval: 5s
      retries: 10

  # On every `docker compose up`, runs to completion before the server starts:
  # applies new migrations and re-applies the runtime account's privileges.
  migrate:
    image: ghcr.io/stairai/reasoning-ledger:<version>
    command: migrate
    environment:
      MIGRATION_DATABASE_URL: postgres://ledger:${DB_PASSWORD:?}@db:5432/ledger
      RL_RUNTIME_ROLE: ledger_runtime
    depends_on:
      db:
        condition: service_healthy

  # The image's health check on /health applies here.
  server:
    image: ghcr.io/stairai/reasoning-ledger:<version>
    command: serve
    environment:
      DATABASE_URL: postgres://ledger_runtime:${RUNTIME_PASSWORD:?}@db:5432/ledger
      RL_ADMIN_TOKEN: ${RL_ADMIN_TOKEN:?}
    volumes:
      - content:/app/data
    ports:
      - "127.0.0.1:4321:4321" # for a reverse proxy on this host; see below
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

volumes:
  db:
  content:
```

Create the runtime account once, then start everything:

```sh
docker compose up -d db
docker compose exec db psql -U ledger -d ledger -c "CREATE ROLE ledger_runtime LOGIN"
docker compose exec db psql -U ledger -d ledger -c "\password ledger_runtime"   # enter RUNTIME_PASSWORD
docker compose up -d
```

To upgrade, change `<version>` and run `docker compose up -d` again: `migrate` finishes before the new server starts. Back up the `db` and `content` volumes together (see [Environment](#environment)).

Register the first owner with the administrator token from `.env`. The response holds the owner's `api_key`, shown once:

```sh
curl -sS http://127.0.0.1:4321/v1/owners \
  -H "content-type: application/json" \
  -H "x-admin-token: $RL_ADMIN_TOKEN" \
  -d '{"email": "you@example.com"}'
```

Sign in to the [trace viewer](#trace-viewer) at `/login` with that key, or with `RL_ADMIN_TOKEN` to see every owner's data. An application that signs people up gets `RL_REGISTRATION_TOKEN`, which registers owners and reads nothing, rather than the administrator token.

Serve the viewer over HTTPS: its sign-in cookie is `Secure`, and browsers do not keep such a cookie for a plain-HTTP site (they differ on whether `http://localhost` counts), so signing in seems to do nothing. In the example the port is bound to `127.0.0.1` only, for a reverse proxy on the same host that terminates TLS; let it pass request bodies up to `CONTENT_MAX_BYTES` (see [Running](#running)).

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

Both run on the server's host, with the same environment as the server: they read the process environment, and `api-server/.env` when there is one (as does `db:deploy`). In a container, run them with `docker exec`; where the server container holds only the runtime account, pass the migration account to the command (`docker exec -e MIGRATION_DATABASE_URL=… <container> pnpm --dir api-server delete-content …`).

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

The read endpoints also accept the administrator's token in `X-Admin-Token`, which reads across every owner; each such read is logged as one `admin_read` line on stdout. Writes always need an owner's API key: a record belongs to an owner, so there is nobody to attribute an administrator's write to.

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

## Health check

`GET /health` answers `200` while the server can reach its database and `503` when it cannot. It needs no API key: point the platform's health check at it. A check on `/` would follow the viewer's redirect to the login page and look unhealthy.

## Trace viewer

The pages at `/` list the signed-in visitor's sessions and render each session as a graph. Sign in at `/login` with an owner's API key, which shows that owner's data and nothing else, or with `RL_ADMIN_TOKEN`, which lists every owner's sessions and opens any trace — the header then reads "Administrator · all owners". The viewer keeps a server-side session in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; the `/v1` API does not use the cookie.

Content that records reference is read from the content store of the owner those records belong to, and shown inline when it is text or JSON of up to 256 KiB; other content is described by its size and media type, and deleted content is marked as deleted. Sign-in and sign-out accept form posts only from the site's own pages (Astro's global origin check is off because it also blocks API clients; see `astro.config.mjs`).

## License

MIT
