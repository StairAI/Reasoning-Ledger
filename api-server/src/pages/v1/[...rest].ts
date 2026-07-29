import type { APIRoute } from "astro";
import { handler } from "#/routes";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  const headersObj: Record<string, string | string[] | undefined> = {};
  for (const pair of request.headers.entries()) {
    // oxlint-disable-next-line prefer-destructuring
    headersObj[pair[0]] = pair[1];
  }
  const { matched, response } = await handler.handle(request, {
    context: {
      headers: headersObj,
    },
    prefix: "/v1",
  });

  return matched ? response : new Response("Not found", { status: 404 });
};
