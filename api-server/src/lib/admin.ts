/**
 * The instance administrator (design §4.2, added in 1.1).
 *
 * Two separate tokens, so the ability to read everything is not handed to
 * whoever only needs to create owners:
 *
 *   RL_ADMIN_TOKEN         reads any owner's records, sessions and content,
 *                          and registers owners. Held by the operator.
 *   RL_REGISTRATION_TOKEN  registers owners, reads nothing. Held by the
 *                          application that signs people up.
 *
 * Reading everything is not a new power — whoever runs the server already has
 * the database and the content directory — but it is worth seeing, so every
 * read made as the administrator is logged.
 */

import { timingSafeEqual } from "node:crypto";

type Headers = Record<string, string | string[] | undefined>;

export function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time compare; false when either side is missing. */
export function sameSecret(given: string | undefined, expected: string | undefined): boolean {
  if (!(given && expected)) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Appended to the description of every read endpoint in the OpenAPI document. */
export const ADMIN_READS =
  " The administrator's token (`X-Admin-Token`) reads across every owner; each such read is logged.";

/** True when this is the administrator's token. */
export function isAdminToken(given: string | null | undefined): boolean {
  return sameSecret(given ?? undefined, process.env.RL_ADMIN_TOKEN);
}

/** True when the request carries the administrator token. */
export function isAdminRequest(headers: Headers): boolean {
  return isAdminToken(headerValue(headers, "x-admin-token"));
}

/** True when the request may register owners: either token does. */
export function mayRegisterOwners(headers: Headers): boolean {
  const given = headerValue(headers, "x-admin-token");
  return (
    sameSecret(given, process.env.RL_ADMIN_TOKEN) ||
    sameSecret(given, process.env.RL_REGISTRATION_TOKEN)
  );
}

/**
 * Record that the administrator read something. One line per read, on stdout,
 * where the deployment's log drain picks it up.
 */
export function logAdminRead(what: string, detail: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event: "admin_read", what, ...detail }),
  );
}
