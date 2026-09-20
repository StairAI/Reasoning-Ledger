# integration-tests

End-to-end tests that exercise the workspace Reasoning Ledger SDKs (`typescript-sdk/`, `python-sdk/`) against a running `api-server`.

These tests are isolated from the per-package unit suites (`typescript-sdk/src/*.test.ts`, `python-sdk/tests/*`) so that:

- the unit runs stay hermetic (no network, no server),
- a regression in the HTTP contract between SDK and server is caught before it reaches users.

## Layout

```
integration-tests/
├─ typescript/          # Vitest suite against the workspace reasoning-ledger-sdk
│  ├─ src/
│  │  ├─ env.ts                 # env-var resolution
│  │  ├─ lifecycle.test.ts      # register → submit → get{Record,Session,Trace}, content, Attesting
│  │  └─ crossSdk.test.ts       # Python writes, TS reads
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ vitest.config.ts
│
├─ python/              # pytest suite against the workspace reasoning-ledger package
│  ├─ tests/
│  │  ├─ staging_env.py         # env-var resolution
│  │  ├─ conftest.py            # session-scoped fixtures
│  │  ├─ test_lifecycle.py      # register → submit → get_{record,session,trace}
│  │  └─ test_cross_sdk.py      # TS writes, Python reads
│  └─ pyproject.toml
│
└─ cross-sdk/runners/   # Standalone writer scripts spawned by the opposite SDK
   ├─ python_writer.py
   └─ typescript_writer.ts
```

## What is covered

### Per-SDK lifecycle (`typescript/lifecycle.test.ts`, `python/tests/test_lifecycle.py`)

| Step                                                             | Why we test it                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `registerAgent` returns a UUID and is idempotent on `(owner, name)` | contract on `POST /v1/agents`                                  |
| `resolveAgentId` round-trips the registered name                 | contract on `GET /v1/agents?name=...`                          |
| Full Observing → ToolCalling → Thinking → Acting cycle submits   | schema 0.4 records, with `executor` and `record_phase`, accepted |
| Raw strings and objects at content positions are uploaded first  | content library (`PUT /v1/content/{sha256}`) and reference check |
| `submitAttesting` records a person's approval with `written_by`  | the Attesting entry point; a reject without a reason fails locally |
| `submit` is idempotent on `record_id`                            | dedup check in `records.ts`                                    |
| `submitBatch` of 3 returns 3 acks                                | batch endpoint contract                                        |
| `getRecord` returns the 0.4 fields and `sequence`                | read-after-write                                               |
| `getSession` returns every record of the session in order        | the server's `sequence` order                                  |
| `getTrace` is newest-first, paginates via `next_cursor`          | cursor pagination contract                                     |
| `putContent` / `getContent` round-trip the bytes                 | content upload and read                                        |
| Missing record or content → `NotFoundError`                      | 404 → `not_found` mapping                                      |
| Bad API key → `AuthError`                                        | 401 → `auth_invalid` mapping                                   |

### Cross-SDK synergy (`typescript/crossSdk.test.ts`, `python/tests/test_cross_sdk.py`)

For each direction the "writer" SDK writes the same 4-record decision cycle (Observing → ToolCalling → Thinking → Acting), emits the IDs as JSON on stdout, and the "reader" SDK in the other language:

1. Fetches each record by ID via `getRecord`.
2. Confirms `agent_id`, `session_id`, and `behavior` match.
3. Fetches the whole session and asserts the four records are returned in write order.
4. Confirms the `ToolCalling.upstream_record_id` edge points back at the `Observing` record.
5. Reads the uploaded content back: `ToolCalling.input_payload` parses as the JSON object the writer passed, and `Thinking.prompt` decodes to the writer's text.

If these pass in both directions, both SDKs write records and content the server stores and serves the same way.

## Running locally (default)

From the repository root:

```sh
pnpm test:local            # static checks + unit + integration
pnpm test:integration      # integration only
pnpm test:unit             # unit only
pnpm test:static           # lint, format and type checks only
```

`scripts/test-local.mts` creates a throwaway Postgres database and a runtime role, applies the migrations and the runtime privileges, builds the SDKs and the api-server, starts the server on a free local port as the runtime role, registers a fresh owner, smoke-tests the trace viewer, runs both suites against the server, then stops it and drops the database and the role. It needs:

- a local Postgres whose user may `CREATE DATABASE` and `CREATE ROLE`: `RL_TEST_ADMIN_URL`, or `DATABASE_URL` in `api-server/.env` (its database is swapped for `postgres`);
- Node.js 24+, pnpm 11+, Python 3.12+ and `uv`.

Set `RL_TEST_KEEP_DB=1` to keep the database and the content directory after the run.

Pull requests and pushes run this same gate on GitHub, against a PostgreSQL service container ([`.github/workflows/tests.yml`](../.github/workflows/tests.yml)).

## Running against a deployed server

Use this after deploying, to check that server against the SDKs on this branch. The [`Integration Tests (deployed server)`](../.github/workflows/integration-tests.yml) workflow does the same on GitHub and is started by hand, with the server's base URL as its input.

| Variable                     | Required | Default                          | Notes                                                              |
| ---------------------------- | -------- | -------------------------------- | ------------------------------------------------------------------ |
| `STAIRAI_STAGING_API_KEY`    | Yes      | —                                | Owner-level key for the target deployment.                        |
| `STAIRAI_STAGING_BASE_URL`   | No       | `https://stg-api.stair-ai.com`   | Target server.                                                     |
| `STAIRAI_STAGING_AGENT_NAME` | No       | auto (`it-<lang>-<ts>-<rand>`)   | Useful to pin a name across re-runs; registration is idempotent.   |
| `PYTHON`                     | No       | `python3`                        | Interpreter invoked by the TS `crossSdk.test.ts`.                  |
| `TSX_BIN`                    | No       | `tsx`                            | Overrides the `tsx` CLI invoked by `test_cross_sdk.py`.            |

When `STAIRAI_STAGING_API_KEY` is not set, both suites mark themselves `skip`.

### TypeScript suite

```sh
pnpm --dir typescript-sdk build
cd integration-tests/typescript
STAIRAI_STAGING_API_KEY=sl_... pnpm test
```

### Python suite

```sh
cd integration-tests/python
uv sync --locked
STAIRAI_STAGING_API_KEY=sl_... uv run --locked pytest
```

### Cross-SDK tests only

```sh
# Python writes, TS reads
cd integration-tests/typescript
STAIRAI_STAGING_API_KEY=sl_... pnpm vitest run src/crossSdk.test.ts

# TS writes, Python reads (requires tsx on PATH or pnpm in integration-tests/typescript)
cd integration-tests/python
STAIRAI_STAGING_API_KEY=sl_... uv run --locked pytest tests/test_cross_sdk.py
```

## Notes

- The suites pass the base URL to the SDKs as `endpoint`; the SDKs have no built-in hosts.
- A deployed server must run the same api-server version as the SDKs under test: SDK 1.0 writes schema `0.4`, which older servers reject.
- Each test run registers a fresh agent name by default; runs share no state. Set `STAIRAI_STAGING_AGENT_NAME` if you want re-runs to accumulate records under one agent.
