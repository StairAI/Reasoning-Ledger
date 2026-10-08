import { call } from "@orpc/server";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "#/lib/prisma";
import { consumeTicket, hashTicket, issueTicket, ticketTtlSeconds } from "#/lib/viewer-tickets";
import { VIZ_COOKIE, endVizSession, startVizSession, viewerForSession } from "#/lib/viz-session";
import { ALL, GET, HEAD } from "#/pages/session/ticket/[ticket]";
import { handler } from "#/routes";
import { issueViewerTicket } from "#/routes/viewer";
import { TEST_ADMIN_TOKEN, ctx, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof GET>[0];

const TICKET_URL = /^\/session\/ticket\/([A-Za-z0-9_-]{43})$/;
const SIGN_IN_AGAIN = "/login?next=%2F&expired=1";

/** The ticket inside a ticket_url. */
function ticketOf(ticketUrl: string): string {
  const match = TICKET_URL.exec(ticketUrl);
  if (!match) {
    throw new Error(`not a ticket URL: ${ticketUrl}`);
  }
  return match[1];
}

/** A request to the API as an HTTP client would make it, through the real handler. */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`http://ledger.test/v1${path}`, init);
  const { response } = await handler.handle(request, {
    context: { headers: Object.fromEntries(request.headers.entries()) },
    prefix: "/v1",
  });
  if (!response) {
    throw new Error(`no route for ${path}`);
  }
  return response;
}

function postTicket(headers: Record<string, string>, body?: unknown): Promise<Response> {
  return api("/viewer/tickets", {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

/** Just enough of Astro's cookies for the sign-in page: one cookie, and what was set. */
function cookieJar(session?: string) {
  const set: { name: string; options: Record<string, unknown>; value: string }[] = [];
  return {
    cookies: {
      get: (name: string) => (name === VIZ_COOKIE && session ? { value: session } : undefined),
      set: (name: string, value: string, options: Record<string, unknown>) => {
        set.push({ name, options, value });
      },
    },
    set,
  };
}

async function openTicket(ticket: string, session?: string) {
  const jar = cookieJar(session);
  const response = (await GET({
    cookies: jar.cookies,
    params: { ticket },
  } as unknown as RouteContext)) as Response;
  return { response, set: jar.set };
}

/** Everything written to the console while `run` runs, as it would print. */
async function consoleDuring(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

describe("Viewer tickets: issuing", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
  });

  it("issues a link for the owner's API key, and stores only the ticket's hash", async () => {
    const before = Date.now();
    const issued = await call(issueViewerTicket, { next: "/traces/a/b" }, ctx(owner.apiKey));
    const ticket = ticketOf(issued.ticket_url);
    expect(issued.expires_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(issued.expires_at).toBeLessThanOrEqual(Date.now() + 60_000);

    const row = await prisma.viewerTicket.findUnique({ where: { id: hashTicket(ticket) } });
    expect(row).toMatchObject({ next: "/traces/a/b", owner_id: owner.ownerId, used_at: null });
    expect(row?.id).toBe(createHash("sha256").update(ticket).digest("hex"));
    await expect(
      prisma.viewerTicket.count({
        where: { OR: [{ id: ticket }, { next: { contains: ticket } }] },
      }),
    ).resolves.toBe(0);
  });

  it("needs an owner's API key: the administrator token mints nothing", async () => {
    for (const headers of [
      {},
      { "x-api-key": "sl_not-a-key" },
      { "x-admin-token": TEST_ADMIN_TOKEN },
      { "x-api-key": TEST_ADMIN_TOKEN },
    ]) {
      await expect(call(issueViewerTicket, {}, { context: { headers } })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    const res = await postTicket({ "x-admin-token": TEST_ADMIN_TOKEN }, { next: "/" });
    expect(res.status).toBe(401);
  });

  it("answers over HTTP, with or without a body", async () => {
    const withBody = await postTicket({ "x-api-key": owner.apiKey }, { next: "/traces/x/y" });
    expect(withBody.status).toBe(200);
    const body = (await withBody.json()) as { expires_at: number; ticket_url: string };
    expect(body.ticket_url).toMatch(TICKET_URL);
    expect(body.expires_at).toBeGreaterThan(Date.now());

    const empty = await postTicket({ "x-api-key": owner.apiKey });
    expect(empty.status).toBe(200);
    const { ticket_url } = (await empty.json()) as { ticket_url: string };
    const row = await prisma.viewerTicket.findUnique({
      where: { id: hashTicket(ticketOf(ticket_url)) },
    });
    expect(row?.next).toBe("/");
  });

  it("keeps next on this site", async () => {
    for (const next of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
      "/\t/evil.example",
      "/.//evil.example",
      "/..//evil.example",
      "/%2e//evil.example",
      "/a/..//evil.example",
      "/./\\evil.example",
      "evil.example",
      "",
      undefined,
    ]) {
      const issued = await call(issueViewerTicket, { next }, ctx(owner.apiKey));
      const row = await prisma.viewerTicket.findUnique({
        where: { id: hashTicket(ticketOf(issued.ticket_url)) },
      });
      expect(row?.next).toBe("/");
    }
  });

  it("is listed in the API reference, under Viewer, behind the API key", async () => {
    const res = await api("/spec.json");
    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>;
      security: unknown[];
      tags: { name: string }[];
    };
    const operation = spec.paths["/viewer/tickets"]?.post;
    expect(operation?.tags).toStrictEqual(["Viewer"]);
    expect(operation?.security ?? spec.security).toStrictEqual([{ ApiKey: [] }]);
    expect(spec.tags.map((t) => t.name)).toContain("Viewer");
  });

  it("lives VIZ_TICKET_TTL_SECONDS, 60 by default, between 10 and 600", () => {
    const saved = process.env.VIZ_TICKET_TTL_SECONDS;
    try {
      for (const [value, seconds] of [
        [undefined, 60],
        ["", 60],
        ["soon", 60],
        ["120", 120],
        ["1", 10],
        ["-5", 10],
        ["86400", 600],
      ] as const) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, "VIZ_TICKET_TTL_SECONDS");
        } else {
          process.env.VIZ_TICKET_TTL_SECONDS = value;
        }
        expect(ticketTtlSeconds()).toBe(seconds);
      }
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "VIZ_TICKET_TTL_SECONDS");
      } else {
        process.env.VIZ_TICKET_TTL_SECONDS = saved;
      }
    }
  });

  it("clears expired tickets when issuing", async () => {
    const old = await issueTicket(owner.ownerId, "/");
    await prisma.viewerTicket.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { id: hashTicket(old.ticket) },
    });
    await issueTicket(owner.ownerId, "/");
    await expect(
      prisma.viewerTicket.findUnique({ where: { id: hashTicket(old.ticket) } }),
    ).resolves.toBeNull();
  });
});

describe("Viewer tickets: exchanging", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
  });

  it("works once, and only once", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/traces/a/b");
    await expect(consumeTicket(ticket)).resolves.toStrictEqual({
      next: "/traces/a/b",
      ownerId: owner.ownerId,
    });
    await expect(consumeTicket(ticket)).resolves.toBeUndefined();
    const row = await prisma.viewerTicket.findUnique({ where: { id: hashTicket(ticket) } });
    expect(row?.used_at).toBeInstanceOf(Date);
  });

  it("lets exactly one of several simultaneous exchanges through", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/");
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeTicket(ticket)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses an expired ticket", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/");
    await prisma.viewerTicket.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { id: hashTicket(ticket) },
    });
    await expect(consumeTicket(ticket)).resolves.toBeUndefined();
  });

  it("refuses unknown and malformed tickets", async () => {
    for (const ticket of [undefined, "", "x", "A".repeat(43), "A".repeat(44), "../../etc"]) {
      await expect(consumeTicket(ticket)).resolves.toBeUndefined();
    }
  });

  it("dies with its owner", async () => {
    const doomed = await makeTestOwner();
    const { ticket } = await issueTicket(doomed.ownerId, "/");
    await doomed.cleanup();
    await expect(
      prisma.viewerTicket.findUnique({ where: { id: hashTicket(ticket) } }),
    ).resolves.toBeNull();
  });
});

describe("Viewer tickets: the sign-in page", () => {
  let owner: TestOwner;
  let other: TestOwner;

  beforeAll(async () => {
    [owner, other] = await Promise.all([makeTestOwner(), makeTestOwner()]);
  });

  afterAll(async () => {
    await prisma.vizSession.deleteMany({
      where: { owner_id: { in: [owner.ownerId, other.ownerId] } },
    });
    await Promise.all([owner.cleanup(), other.cleanup()]);
  });

  it("signs the browser in and moves on with a page of this site, not a redirect", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/traces/a/b");
    const { response, set } = await openTicket(ticket);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      name: VIZ_COOKIE,
      options: { httpOnly: true, path: "/", sameSite: "strict", secure: true },
    });
    await expect(viewerForSession(set[0].value)).resolves.toMatchObject({
      admin: false,
      ownerId: owner.ownerId,
    });

    const html = await response.text();
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=/traces/a/b">');
    expect(html).toContain('<a id="next" href="/traces/a/b">');
    expect(html).toContain("location.replace(");
    // The policy allows the page's one script, by hash, and nothing else.
    const script = /<script>([^<]*)<\/script>/.exec(html)?.[1] ?? "";
    const hash = createHash("sha256").update(script).digest("base64");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
  });

  it("escapes where it goes next", async () => {
    const { ticket } = await issueTicket(owner.ownerId, '/traces/it\'s/a?b=1&c=<2>#"x"');
    const { response } = await openTicket(ticket);
    const html = await response.text();
    expect(html).toContain('href="/traces/it&#39;s/a?b=1&amp;c=%3C2%3E#%22x%22"');
    expect(html).not.toContain("it's");
    expect(html).not.toContain("<2>");
  });

  it("keeps a session the browser already has for the same owner", async () => {
    const existing = await startVizSession(owner.ownerId);
    const { ticket } = await issueTicket(owner.ownerId, "/");
    const { response, set } = await openTicket(ticket, existing.id);
    expect(response.status).toBe(200);
    expect(set).toHaveLength(0);
    await expect(viewerForSession(existing.id)).resolves.toMatchObject({ ownerId: owner.ownerId });
    await endVizSession(existing.id);
  });

  it("replaces another owner's or the administrator's session, and ends it", async () => {
    for (const previous of [await startVizSession(other.ownerId), await startVizSession(null)]) {
      const { ticket } = await issueTicket(owner.ownerId, "/");
      const { set } = await openTicket(ticket, previous.id);
      expect(set).toHaveLength(1);
      await expect(viewerForSession(set[0].value)).resolves.toMatchObject({
        admin: false,
        ownerId: owner.ownerId,
      });
      await expect(viewerForSession(previous.id)).resolves.toBeUndefined();
    }
  });

  it("sends an unknown, used or expired ticket to the sign-in page, saying nothing more", async () => {
    const used = await issueTicket(owner.ownerId, "/traces/secret/place");
    await consumeTicket(used.ticket);
    const expired = await issueTicket(owner.ownerId, "/traces/secret/place");
    await prisma.viewerTicket.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { id: hashTicket(expired.ticket) },
    });
    for (const ticket of ["A".repeat(43), used.ticket, expired.ticket, "not-a-ticket"]) {
      const { response, set } = await openTicket(ticket);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(SIGN_IN_AGAIN);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(set).toHaveLength(0);
    }
  });

  it("does not spend the ticket on a HEAD request", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/");
    const head = (await HEAD({ params: { ticket } } as unknown as RouteContext)) as Response;
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
    await expect(consumeTicket(ticket)).resolves.toMatchObject({ ownerId: owner.ownerId });
  });

  it("answers any other method 405, without spending the ticket", async () => {
    const { ticket } = await issueTicket(owner.ownerId, "/");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const jar = cookieJar();
      const response = (await ALL({
        cookies: jar.cookies,
        params: { ticket },
        request: new Request(`http://ledger.test/session/ticket/${ticket}`, { method }),
      } as unknown as RouteContext)) as Response;
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(jar.set).toHaveLength(0);
    }
    await expect(consumeTicket(ticket)).resolves.toMatchObject({ ownerId: owner.ownerId });
  });
});

describe("Viewer tickets: the log", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await prisma.vizSession.deleteMany({ where: { owner_id: owner.ownerId } });
    await owner.cleanup();
  });

  it("says who and what happened, once per issuance and per use, never the ticket", async () => {
    let ticket = "";
    const logged = await consoleDuring(async () => {
      const res = await postTicket({ "x-api-key": owner.apiKey }, { next: "/traces/a/b" });
      ticket = ticketOf(((await res.json()) as { ticket_url: string }).ticket_url);
      await openTicket(ticket);
      await openTicket(ticket);
    });

    expect(ticket).not.toBe("");
    expect(logged).not.toContain(ticket);
    expect(logged).not.toContain(owner.apiKey);
    const events = logged
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "viewer_ticket");
    expect(events.map(({ outcome, owner_id }) => ({ outcome, owner_id }))).toStrictEqual([
      { outcome: "issued", owner_id: owner.ownerId },
      { outcome: "used", owner_id: owner.ownerId },
      { outcome: "already_used", owner_id: owner.ownerId },
    ]);
    for (const event of events) {
      expect(Date.parse(String(event.at))).not.toBeNaN();
    }
  });
});
