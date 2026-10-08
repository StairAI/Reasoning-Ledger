import * as z from "zod";
import { authed } from "#/lib/auth";
import { TICKET_PATH, issueTicket } from "#/lib/viewer-tickets";

// ---------------------------------------------------------------------------
// POST /v1/viewer/tickets
// Mint a one-time link that signs a browser into the trace viewer as the
// calling owner (lib/viewer-tickets.ts).
//
// `authed`, not `reader`: the administrator token must not mint tickets. A
// ticket opens a viewer session, and the administrator's session reads every
// owner — that view is signed into by the operator, at /login, and nowhere else.
// ---------------------------------------------------------------------------

export const issueViewerTicket = authed
  .route({
    description:
      "Mint a one-time link that signs a person's browser into the trace viewer as the owner identified by the `X-API-Key` header, so an application can send people to their traces without the key ever reaching a browser. " +
      "Call it from your server when the person clicks through, and send the browser to `ticket_url` (relative to this server's origin) straight away, with a GET: a 302 or 303 redirect, or a link. " +
      "Not a 307 or 308 redirect in answer to a POST, which makes the browser repeat the POST: any method other than GET or HEAD answers 405 and does not sign in. " +
      "The link works once and expires at `expires_at` (epoch milliseconds), 60 seconds after it was issued unless the operator sets `VIZ_TICKET_TTL_SECONDS`; opened again, or too late, it lands on the sign-in page. " +
      "`next` is the viewer page to open, a path on this server such as `/traces/{agent_id}/{session_id}`; anything else, including another origin, becomes `/`. " +
      "Only an owner's API key mints tickets: the administrator token does not.",
    method: "POST",
    path: "/viewer/tickets",
    summary: "Issue viewer sign-in link",
    tags: ["Viewer"],
  })
  // The body is optional: without one, the viewer opens at its index.
  .input(z.object({ next: z.string().max(2048).optional() }).optional())
  .output(
    z.object({
      /** Epoch milliseconds, like every other timestamp in the API. */
      expires_at: z.number(),
      ticket_url: z.string(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { ticket, expiresAt } = await issueTicket(context.ownerId, input?.next);
    return { expires_at: expiresAt.getTime(), ticket_url: `${TICKET_PATH}${ticket}` };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const viewerRouter = {
  issueViewerTicket,
};
