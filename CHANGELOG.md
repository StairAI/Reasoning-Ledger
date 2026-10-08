# Changelog

The server and both SDKs share one version line; a patch release names the packages it changes. The record schema is numbered separately: SDK and server 1.0.x write schema `0.4`.

## Unreleased

Server only.

### Added

- **One-time sign-in links for the trace viewer.** `POST /v1/viewer/tickets`, called with an owner's API key, returns a `ticket_url` that signs a browser into the viewer as that owner and opens the page given as `next`. An application that keeps the key on its server can send people to their traces without the key ever reaching a browser. A link works once and expires after 60 seconds (`VIZ_TICKET_TTL_SECONDS`, between 10 and 600); only an owner's key mints one, never the administrator token. The database keeps the SHA-256 of each ticket, and every issuance and use is logged as one `viewer_ticket` line with the owner and the outcome. See [Signing a person into the viewer from your application](./api-server/README.md#signing-a-person-into-the-viewer-from-your-application).
- The sign-in page says when it was reached through a link that has expired or was already used.
- Signed in as an owner, the viewer's header names the owner, as it already did for the administrator. A one-time link signs a browser in with one click, so the account a page reads as is always in view; see what this [trades away](./api-server/README.md#signing-a-person-into-the-viewer-from-your-application).

### Fixed

- **Signing in can no longer send a person to another site.** The page to open after signing in (`next`) was checked before its dot segments were resolved, so `/login?next=/.//evil.example` opened `//evil.example`, another site, right after a successful sign-in. The resolved path is checked now, and anything that would leave the site opens `/`.
- Expired viewer sessions are deleted whenever someone signs in. Before, a session whose cookie the browser no longer held stayed in `viz_sessions` for good.

### Upgrading

- A new migration adds the `viewer_tickets` table. `db:deploy` applies it, and the runtime account's privileges with it.

## 1.0.1 — 2026-09-23

Server only; the SDKs stay at 1.0.0.

### Security

- **The server no longer writes requests to its error log.** Every failed API call was logged together with its request, headers included, so the API key or administrator token of a failing request ended up in the log in plain text, although the database keeps only a hash of each key. The log now says the status, the error code, the method and the path, and keeps a stack only for faults in the server. If you ran an earlier version, treat keys found in its logs as exposed: restrict access to those logs and rotate the keys.

## 1.0.0 — 2026-09-23

The first stable release. Records are append-only for the account the server runs as, raw content moves out of records into a content library addressed by SHA-256, and every read is scoped to the owner that makes it.

### Breaking changes

- **The SDKs have no default server.** `endpoint` is required when constructing a client and when registering or resolving an agent. The `environment` option and the `ENDPOINTS` constant are gone; their built-in hosts never resolved.
- **Writes accept schema `0.4` only.** Every record states `executor` (`ai`, `det` or `human`) and `record_phase` (`pre_execution`, `concurrent` or `post_execution`). `ToolCalling.success` is replaced by the required `outcome`. Records written as `0.1`–`0.3` stay readable. The label `1.0`, which SDK 0.1.0 stamped on what is now `0.2`, is rejected with an upgrade hint and will not be reused.
- **Prompts, payloads and internal reasoning are content references.** A record holds `{ sha256, bytes, media_type }` at those positions. The SDKs accept raw values there and upload them first.
- **Reads need an API key and return only the caller's data.** Another owner's agent, record or session answers `404`. The trace viewer asks for a sign-in.
- **Registering an owner needs a token** (`RL_ADMIN_TOKEN` or `RL_REGISTRATION_TOKEN`), unless the operator sets `RL_REGISTRATION=open`, which is rate-limited per client address.
- **Schema changes are applied by migrations**, not `prisma db push`. A database created by `db push` is baselined once; see [Upgrading an existing database](./api-server/README.md#upgrading-an-existing-database).

### Added

- Schema `0.4`: `executor`, `record_phase`, `outcome`, `duration_ms`, `sources`, `verdict`.
- `Attesting`, a new behavior: a person's approval, rejection or edit of a pending action, with `decision`, `effects` and `seen_digest`. SDK: `submitAttesting` / `submit_attesting`.
- Content library: `PUT`, `GET` and `HEAD /v1/content/{sha256}`, idempotent by hash, 64 MiB per object by default (`CONTENT_MAX_BYTES`). SDK: `putContent` / `put_content`, `getContent` / `get_content`. On submit the server checks that referenced content was uploaded by the same owner.
- Content deletion as an operator command, logged in `content_deletions`; reading deleted content answers `410` and the record keeps the hash.
- A server-assigned `sequence` on every record: one total order across the ledger.
- Separate migration and runtime database accounts. The runtime account can append records but never update or delete them.
- `export-records`: records exported in batches with a SHA-256 manifest for write-once storage, and `--verify` to check an export against its manifest and the database.
- An instance administrator (`RL_ADMIN_TOKEN`) who can read across owners, through the API and in the trace viewer; every such read is logged.
- `GET /health`: `200` while the database is reachable, `503` when it is not.
- The SDKs check the cross-field rules before sending anything.

### Fixed

- Batch submission: the 0.x SDKs posted to `/v1/records:batch`, which the server does not serve. `submitBatch` / `submit_batch` now use `/v1/records/batch`.

### Development

- One local gate, `pnpm test:local`: static checks, the unit suites, then the integration suites (TypeScript, Python and cross-SDK) against a server it builds and starts on a throwaway database. GitHub runs the same gate on every pull request.
- Pre-releases publish from `develop` (npm tag `next`, PyPI pre-release); releases publish from `master`. See [Releasing the SDKs](./README.md#releasing-the-sdks).

## 0.3.0 and earlier

Published without a changelog. 0.3.0 wrote schema `0.3`; 0.1.0 wrote the format now called `0.2` under the retired label `1.0`.
