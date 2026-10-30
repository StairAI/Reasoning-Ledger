/**
 * The page a sign-in link answers with (pages/session/ticket, pages/session/grant):
 * it keeps the key the link carries in its fragment, if any, in the tab's
 * sessionStorage, and moves on to a page of this site by itself.
 */

import { createHash } from "node:crypto";

/**
 * The link's token is in the page's address: keep the response out of every cache,
 * and the address out of the Referer header of whatever the browser loads next.
 */
export const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * The page's only script. It reads the destination from the link rather than
 * holding it, so it never changes and the Content-Security-Policy below can
 * allow exactly this script and nothing else.
 *
 * First it keeps the content master key, when the link carries one in its
 * fragment (`#k=`, which the browser never sends to the server), in the tab's
 * sessionStorage: the viewer pages decrypt content with it (scripts/decrypt.ts).
 */
export const NAVIGATE =
  'try{var k=location.hash;if(k.slice(0,3)==="#k="){sessionStorage.setItem("rl_mk",k.slice(3));}}catch(e){}' +
  'location.replace(document.getElementById("next").getAttribute("href"));';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(NAVIGATE).digest("base64")}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Escape for an HTML attribute value or text. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Navigate to `next`, a path on this site (safeNext). location.replace keeps
 * the ticket's address out of the back button; the meta refresh covers a
 * browser without scripts, and the link one that does neither.
 */
export function navigationPage(next: string): string {
  const href = escapeHtml(next);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url=${href}">
<title>Reasoning Ledger</title>
</head>
<body>
<p><a id="next" href="${href}">Continue to Reasoning Ledger</a></p>
<script>${NAVIGATE}</script>
</body>
</html>
`;
}
