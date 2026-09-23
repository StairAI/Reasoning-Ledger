import { describe, expect, it } from "vitest";
import { GET } from "#/pages/health";

type RouteContext = Parameters<typeof GET>[0];

describe("GET /health", () => {
  it("answers 200 while the database is reachable", async () => {
    const res = (await GET({} as RouteContext)) as Response;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({ status: "ok" });
  });
});
