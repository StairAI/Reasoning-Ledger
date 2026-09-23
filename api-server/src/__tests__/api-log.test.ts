import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logApiError } from "#/lib/api-log";
import { handler } from "#/routes";

/** Everything the API writes to the console while `run` runs, as it would print. */
async function consoleDuring(run: () => Promise<unknown> | unknown): Promise<string> {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  await run();
  return lines.join("\n");
}

describe("API error log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the failed call but never writes the caller's credentials", async () => {
    const apiKey = "sl_this-key-must-not-reach-a-log-file";
    const adminToken = "this-token-must-not-reach-a-log-file";
    const request = new Request("http://ledger.test/v1/owners", {
      body: JSON.stringify({ email: "someone@example.com" }),
      headers: {
        "content-type": "application/json",
        "x-admin-token": adminToken,
        "x-api-key": apiKey,
      },
      method: "POST",
    });

    let status: number | undefined;
    const logged = await consoleDuring(async () => {
      const { response } = await handler.handle(request, {
        context: { headers: Object.fromEntries(request.headers.entries()) },
        prefix: "/v1",
      });
      status = response?.status;
    });

    expect(status).toBe(403);
    expect(logged).toContain("POST /v1/owners");
    expect(logged).toContain("403");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(adminToken);
  });

  it("keeps the stack of a fault in the server", async () => {
    const logged = await consoleDuring(() =>
      logApiError(new Error("database went away"), {
        request: { method: "GET", url: new URL("http://ledger.test/v1/records/abc") },
      }),
    );

    expect(logged).toContain("api 500 GET /v1/records/abc");
    expect(logged).toContain("database went away");
    expect(logged).toContain("api-log.test.ts");
  });
});
