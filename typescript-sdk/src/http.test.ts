import { afterEach, describe, expect, test, vi } from "vitest";
import { NetworkError, NotFoundError, ValidationError } from "./errors.js";
import { FetchTransport, mapHttpError, withRetry } from "./http.js";
import type { HttpResponse } from "./types.js";

// ---------------------------------------------------------------------------
// FetchTransport
// ---------------------------------------------------------------------------

describe(FetchTransport, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sends a Uint8Array body as is and returns the raw response bytes", async () => {
    const payload = new Uint8Array([0, 255, 128]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 254, 0]), {
        headers: { "Content-Type": "application/octet-stream" },
        status: 200,
      }),
    );

    const res = await new FetchTransport().request({
      body: payload,
      headers: { "x-api-key": "key" },
      method: "PUT",
      url: "http://localhost:3000/v1/content/abc",
    });

    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/v1/content/abc", {
      body: payload,
      headers: { "x-api-key": "key" },
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(res.bodyBytes).toStrictEqual(new Uint8Array([1, 254, 0]));
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  test("a text response is available as UTF-8 text and as bytes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"note":"héllo"}'));

    const res = await new FetchTransport().request({
      headers: {},
      method: "GET",
      url: "http://localhost:3000/v1/records/x",
    });

    expect(res.body).toBe('{"note":"héllo"}');
    expect(res.bodyBytes).toStrictEqual(new TextEncoder().encode('{"note":"héllo"}'));
  });

  test("a request that gets no response becomes a NetworkError, which is retried", async () => {
    const refused = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:3000"),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(refused);
    const transport = new FetchTransport();
    const request = () =>
      transport.request({ headers: {}, method: "GET", url: "http://127.0.0.1:3000/v1/x" });

    await expect(request()).rejects.toThrow(NetworkError);
    await expect(request()).rejects.toThrow("ECONNREFUSED");
    await expect(withRetry(request, { attempts: 2, backoffMs: [0] })).rejects.toThrow(NetworkError);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// mapHttpError — content-library statuses
// ---------------------------------------------------------------------------

function response(status: number, message: string): HttpResponse {
  return { body: JSON.stringify({ message }), headers: {}, status };
}

describe(mapHttpError, () => {
  test.each([
    [404, "Content not found"],
    [410, "Content was deleted"],
  ])("%i raises NotFoundError carrying the server's message", (status, message) => {
    expect(() => mapHttpError(response(status, message))).toThrow(NotFoundError);
    expect(() => mapHttpError(response(status, message))).toThrow(message);
  });

  test("413 raises a ValidationError that says the payload is too large", () => {
    const res = response(413, "content exceeds the 67108864-byte limit");
    expect(() => mapHttpError(res)).toThrow(ValidationError);
    expect(() => mapHttpError(res)).toThrow(
      "Payload too large for the server: content exceeds the 67108864-byte limit",
    );
  });
});
