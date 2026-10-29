# Changelog

The server and both SDKs share one version line; a release names the packages it changes. The record schema is numbered separately: the SDKs 1.0.x and the server 1.0.x and 1.1.x write schema `0.4`; 2.0.0 and later write `0.5`.

## 2.0.2 — 2026-10-29

The server only; the SDKs stay at 2.0.0.

### Changed

- **Owners register without an e-mail.** `POST /v1/owners` no longer requires `email`: without one, the registration is anonymous (the keys are the identity; a new owner each time, admitted by the invite code as before), and the owner can claim an e-mail later with `PATCH /v1/owners/me` (`email`; 409 when another owner holds it). With an e-mail, registration stays idempotent. Owner responses now carry `email` when there is one; the viewer names an anonymous owner by its id.

## 2.0.1 — 2026-10-29

The server image only; the SDKs stay at 2.0.0.

### Fixed

- **The entrypoint checks that the server's user can really write the content directory.** It hands the directory to `rl` as before, then creates an owner directory and an object in it as `rl`, as an upload does; when that fails (a mount that accepts the change of owner and still refuses the user, as a directory created by a non-root deployment user can) it runs as root and says so, and before listening it probes the same way and stops when even that fails. Until now a probe that only created a file could pass while every upload then failed with `EACCES`.

## 2.0.0 — 2026-10-29

The release of 2.0.0-rc.1 and 2.0.0-rc.2 below, unchanged: schema 0.5 in the server and both SDKs, content encrypted on the writer's machine, registration by invitation. Writes of schema `0.4` are refused from this version on; records written earlier stay readable. The hosted ledger runs this version with `RL_REGISTRATION=invite`.

## 2.0.0-rc.2 — 2026-10-29

A pre-release of the server, the TypeScript SDK and the Python SDK, deployed to staging. Content encryption and registration by invitation.

### Added

- **Encrypted content.** A `ContentRef` may carry `enc`: the bytes the ledger holds are AES-256-GCM ciphertext made on the writer's machine with a data key, one per session, named by `enc.key_id`; `enc` also carries the plaintext's digest, size and media type ([schema](./schema/SCHEMA.md#encrypted-content--enc)). The wrapped data key, under the owner's master key, is registered at `PUT /v1/content-keys/{key_id}` and read back at `GET /v1/content-keys` and `GET /v1/content-keys/{key_id}`; a record whose encrypted content names an unregistered key is rejected. The master key never reaches the ledger.
- **The viewer decrypts in the browser.** Encrypted content renders as a placeholder; the page carries the ciphertext and the wrapped keys, and the browser decrypts with the master key from the sign-in link's fragment (`#k=`), which the ticket page keeps in the tab's sessionStorage and never sends. Without the key, a note says how to open the viewer with one.
- **Python SDK: `ContentEncryption`.** `LedgerClientConfig.encryption` encrypts every content position before upload and registers each session's wrapped key first; `open_content()` reads a reference back and decrypts it; `put_content_key`, `get_content_key`, `list_content_keys` and the master key helpers (`generate_master_key`, `save_master_key`, `load_master_key`, `master_key_fragment`) are new. The SDK now depends on `cryptography`. The TypeScript SDK accepts references with `enc` and does not encrypt yet.
- **Invite codes.** `RL_REGISTRATION=invite` asks a self-service registration for an `invite_code` (`POST /v1/owners`), spent in the transaction that creates the owner and recorded on it; the administrator makes, lists and revokes codes at `/v1/admin/invites`. `open` keeps working as before, and still records a code when one is given.

### Changed

- `ContentRef.sha256` and `bytes` describe the bytes the ledger holds, which for encrypted content are the ciphertext; the reference is closed to these three keys plus `enc`.

## 2.0.0-rc.1 — 2026-10-28

A pre-release of the server, the TypeScript SDK and the Python SDK, deployed to staging. Schema 0.5, in the server and both SDKs. The field-level reference is [`schema/SCHEMA.md`](./schema/SCHEMA.md); the `0.4` schema is kept under [`schema/history/0.4/`](./schema/history/0.4/).

### Changed

- **Eleven behaviors instead of eight.** `Planning` stays, with its `0.4` fields (`goal`, `steps`, `contingencies`) and a new optional `revision_of`, the earlier plan it revises. Three behaviors are new: `Escalating` (the agent hands a decision to a person: a question, a permission request, a plan to approve, a handoff), `Delegating` (a goal handed to another agent, which runs its own session) and `Memorizing` (a write to memory, rules, skills, settings or a knowledge base, which outlives the cycle).
- **Every record can say who wrote it and how it was classified.** `written_by` moves from `Attesting` to every record (still required on `Attesting`); `on_behalf_of_agent_id` names the agent when a platform writes for it; `classification` says whether the behavior was declared by the writer or inferred by a rule, a model or a person, and how confidently.
- **Results.** `outcome` is required on `Acting`, `Attesting`, `Escalating`, `Delegating` and `Memorizing` as well as `ToolCalling`, and gains the value `cancelled`; `error_type` carries a low-cardinality error class when the outcome is not `success`.
- **Model calls.** `ModelInvocation.invocation_kind` separates live calls from replays, cache hits and simulations (`provider` and `model_name` may be null on a replay or simulation, and `replay_of` points at what was replayed); `cache_read_tokens`, `cache_creation_tokens` and `request_id` are new; `model_version` is gone.
- **Tool calls.** `tool_meta` is typed: `name` is required, `call_id`, `tool_type`, `namespace`, `server` and `version` are known keys, unknown keys are still allowed; `description` is optional; `effect` says whether the call read, wrote or executed.
- **Acting.** `action_type` is a namespaced `<domain>.<verb>`; `dry_run` is gone (`execution_status: "simulated"` already says it); `parameters` is optional; `execution_status` gains `cancelled`.
- **Attesting.** `disposition` gains `cancel` and `no_response`; `channel` and `seen_completeness` are new; `evidence_refs` is gone (use `sources`). `no_response` requires `outcome: "timeout"` and `cancel` requires `outcome: "cancelled"`; the server and both SDKs enforce these like the existing rules.
- **Observing.** `trigger_type` gains `human_trigger`, `outcome_trigger` and `agent_trigger`; `external_trigger_id` is gone.
- `Reflecting.kind` (`process`, `evaluation`, `settlement`), `Other.proposed_behavior`, `Verdict.decided_by` as a fixed vocabulary (`human`, `model`, `rule`, `policy`, `classifier`, `config`, `consensus`).
- **Removed fields:** `parent_record_id`, `Verdict.sources`, `Verdict.counterfactual`, `Verdict.dissent`, `SourceDescriptor.record_id`, `Thinking.prompt` and `Thinking.inputs` are now optional.
- **Requirement levels.** Fields are required, recommended or optional; the schema reference marks the recommended ones. Completeness (the share of recommended fields filled) and the session shape (opened by an `Observing`, closed by an `Acting`) are measured, not enforced.
- Writes accept schema `0.5` only, as `0.4` was accepted only before; the database gains the three behavior values and `cancelled`, with no new columns.
- **Unknown top-level fields are rejected** by the server and the TypeScript SDK, as the schema's closed records say and as the Python SDK already did. The generated Zod schemas are closed objects now instead of intersections, which let an unknown key through and dropped it.

## 1.1.0 — 2026-10-08

The server and its image; the SDKs stay at 1.0.0.

### Added

- **One-time sign-in links for the trace viewer.** `POST /v1/viewer/tickets`, called with an owner's API key, returns a `ticket_url` that signs a browser into the viewer as that owner and opens the page given as `next`. An application that keeps the key on its server can send people to their traces without the key ever reaching a browser. A link works once and expires after 60 seconds (`VIZ_TICKET_TTL_SECONDS`, between 10 and 600); only an owner's key mints one, never the administrator token. The database keeps the SHA-256 of each ticket, and every issuance and use is logged as one `viewer_ticket` line with the owner and the outcome. See [Signing a person into the viewer from your application](./api-server/README.md#signing-a-person-into-the-viewer-from-your-application).
- The sign-in page says when it was reached through a link that has expired or was already used.
- Signed in as an owner, the viewer's header names the owner, as it already did for the administrator. A one-time link signs a browser in with one click, so the account a page reads as is always in view; see what this [trades away](./api-server/README.md#signing-a-person-into-the-viewer-from-your-application).
- **A published server image**, `ghcr.io/stairai/reasoning-ledger`, with the API and the trace viewer. A version tag publishes `<version>`, and `latest` for the highest release; pull requests that touch the server build the image and smoke-test it against a throwaway database. See [Running the published image](./api-server/README.md#running-the-published-image).
- Image subcommands: `start` (the default, as before: migrate, then serve), `migrate` (migrate and exit) and `serve` (serve only). With `migrate` and `serve`, the long-running server never holds the migration account's credentials.
- A `HEALTHCHECK` on `/health`.

### Changed

- The server in the image runs as an unprivileged user (`rl`, uid 10001). Started as root, as by default, the container first gives the content directory and its per-owner directories to that user when they belong to someone else, such as a bind mount owned by root (stored objects keep their owner), and stops with an error when the directory is not writable. A container that cannot switch users, or cannot give the content directory to `rl`, for example one started with all capabilities dropped, says so in its log and runs as root, as before.
- Content stays in `/app/data/content` unless `CONTENT_DIR` says otherwise. `/app/data` now exists in the image and belongs to `rl`, so a named volume mounted there starts out writable for the server.
- The server process no longer inherits `MIGRATION_DATABASE_URL`, with `start` as with `serve`.
- The image is built on an exact Node.js release (24.21.0, Debian bookworm) and pnpm version (11.28.2) instead of floating tags.

### Fixed

- **Signing in can no longer send a person to another site.** The page to open after signing in (`next`) was checked before its dot segments were resolved, so `/login?next=/.//evil.example` opened `//evil.example`, another site, right after a successful sign-in. The resolved path is checked now, and anything that would leave the site opens `/`.
- Expired viewer sessions are deleted whenever someone signs in. Before, a session whose cookie the browser no longer held stayed in `viz_sessions` for good.
- Operator commands run in the container (`docker exec <container> pnpm --dir api-server …`) find content where the server keeps it. Without `CONTENT_DIR` they looked in `/app/api-server/data/content`, so `delete-content` marked content deleted but left its bytes on disk.

### Upgrading

- A new migration adds the `viewer_tickets` table. `db:deploy` applies it, and the runtime account's privileges with it.
- Keep the content volume where it is mounted, and `CONTENT_DIR` if you set it.
- Deploy this image the first time by replacing the running container (stop-first) rather than starting the new one beside it, or restart the new container once the old one is gone. The new container gives the content directories to `rl` as it starts; meanwhile the old one, which runs as root, can create a directory for an owner's first upload that `rl` cannot write, and that owner's uploads then fail until the next start. Later upgrades are not affected.

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
