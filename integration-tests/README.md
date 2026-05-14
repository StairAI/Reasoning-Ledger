# integration-tests

End-to-end tests that exercise the **published** Reasoning Ledger SDKs (`reasoning-ledger-sdk` on npm, `reasoning-ledger` on PyPI) against a live deployment of the `api-server`.

These tests are isolated from the per-package unit suites (`typescript-sdk/src/*.test.ts`, `python-sdk/tests/*`) so that:

- the default `pnpm -r test` / `pytest` runs stay hermetic (no network, no staging key needed),
- CI can opt into the staging suite with a single env var,
- a regression in the HTTP contract between SDK and server is caught before it reaches users.

## Layout

```
integration-tests/
├─ typescript/          # Vitest suite that pulls reasoning-ledger-sdk from npm
│  ├─ src/
│  │  ├─ env.ts                 # env-var resolution
│  │  ├─ stagingTransport.ts    # HttpTransport that rewrites prod→staging URL
│  │  ├─ lifecycle.test.ts      # register → submit → get{Record,Session,Trace}
│  │  └─ crossSdk.test.ts       # Python writes, TS reads
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ vitest.config.ts
│
├─ python/              # pytest suite that pulls reasoning-ledger from PyPI
│  ├─ tests/
│  │  ├─ staging_transport.py   # HttpTransport wrapper, env resolution
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
| Full Observing → ToolCalling → Thinking → Acting cycle submits   | all five behaviour schemas accepted by the server              |
| `submit` is idempotent on `record_id`                            | dedup check in `records.ts`                                    |
| `submitBatch` of 3 returns 3 acks                                | batch endpoint contract                                        |
| `getRecord` returns a submitted record                           | read-after-write                                               |
| `getSession` returns every record of the session in submit order | server's ASC-by-`server_ts_utc` ordering                       |
| `getTrace` is newest-first, paginates via `next_cursor`          | cursor pagination contract                                     |
| Missing record → `NotFoundError`                                 | 404 → `not_found` mapping                                      |
| Bad API key → `AuthError`                                        | 401 → `auth_invalid` mapping                                   |

### Cross-SDK synergy (`typescript/crossSdk.test.ts`, `python/tests/test_cross_sdk.py`)

For each direction the "writer" SDK spawns a deterministic 4-record decision cycle using fixed `record_id`s, emits the IDs as JSON on stdout, and the "reader" SDK in the other language:

1. Fetches each record by ID via `getRecord`.
2. Confirms `agent_id`, `session_id`, and `behavior` match.
3. Fetches the whole session and asserts the four records are returned in submit order.
4. Confirms the `ToolCalling.upstream_record_id` edge points back at the `Observing` record and the JSON payload deserializes to the writer's value.

If (3) passes both directions we have high confidence that writes and reads through either SDK produce byte-identical records on the server.

## Prerequisites

- An owner API key issued against **`https://staging-api.stair-ai.com`** (set via `STAIRAI_STAGING_API_KEY`).
- Node.js 22+, pnpm 10.
- Python 3.12+, `uv` or `pip`.
- Network access to `staging-api.stair-ai.com`.

## Environment variables

| Variable                    | Required | Default                              | Notes                                                              |
| --------------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------ |
| `STAIRAI_STAGING_API_KEY`   | Yes      | —                                    | Owner-level key for the staging deployment.                        |
| `STAIRAI_STAGING_BASE_URL`  | No       | `https://staging-api.stair-ai.com`   | Override if staging moves.                                         |
| `STAIRAI_STAGING_AGENT_NAME`| No       | auto (`it-<lang>-<ts>-<rand>`)       | Useful to pin a name across re-runs; registration is idempotent.   |
| `PYTHON`                    | No       | `python3`                            | Interpreter invoked by the TS `crossSdk.test.ts`.                  |
| `TSX_BIN`                   | No       | `tsx`                                | Overrides the `tsx` CLI invoked by `test_cross_sdk.py`.            |

When `STAIRAI_STAGING_API_KEY` is not set, both suites mark themselves `skip` — they are safe to leave in CI.

## Running

### TypeScript suite

```sh
cd integration-tests/typescript
pnpm install
STAIRAI_STAGING_API_KEY=sl_... pnpm test
```

### Python suite

```sh
cd integration-tests/python
uv sync          # or: python -m pip install -e . pytest httpx
STAIRAI_STAGING_API_KEY=sl_... uv run pytest
```

### Cross-SDK tests only

```sh
# Python writes, TS reads
cd integration-tests/typescript
STAIRAI_STAGING_API_KEY=sl_... pnpm vitest run src/crossSdk.test.ts

# TS writes, Python reads (requires tsx on PATH or pnpm in integration-tests/typescript)
cd integration-tests/python
STAIRAI_STAGING_API_KEY=sl_... uv run pytest tests/test_cross_sdk.py
```

## Known quirks

- The shipped v0.1.0 SDKs hard-code `ENDPOINTS.production` for `registerAgent` and `resolveAgentId`. The `StagingTransport` helper (in both languages) rewrites those URLs to the staging base transparently — this is why every test wires the custom transport through. Once the SDKs honour `endpoint`/`environment` for the static factory methods, the transport shim can be deleted.
- The staging URL the user deployed to (`https://staging-api.stair-ai.com`) does **not** match the SDK's built-in `ENDPOINTS.staging` (`https://staging.api.stairai.com`). The `STAIRAI_STAGING_BASE_URL` env var (default `https://staging-api.stair-ai.com`) is what both suites resolve against.
- Each test run registers a fresh agent name by default; runs share no state. Set `STAIRAI_STAGING_AGENT_NAME` if you want re-runs to accumulate records under one agent.
