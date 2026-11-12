/**
 * A small stand-in for an S3-compatible service, for the content store's
 * tests: path-style requests to one bucket; PUT with `If-None-Match: *` and
 * `Content-MD5`, GET, HEAD and DELETE; and switches that make it refuse
 * writes, reads or deletions the way a service does when it is down or the
 * credential lacks a permission. It answers with the status codes and error
 * documents of S3, which is what the AWS SDK reads.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  /** The bucket's objects by key. */
  objects: Map<string, Buffer>;
  /** Set to make the service refuse that kind of request. */
  refuse: { writes: boolean; reads: boolean; deletes: boolean };
  /** Every request, in order. */
  requests: { method: string; key: string; ifNoneMatch?: string }[];
  close: () => Promise<void>;
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  );
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startFakeS3(bucket = "test-content"): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const refuse = { deletes: false, reads: false, writes: false };
  const requests: FakeS3["requests"] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const [, inBucket, ...parts] = url.pathname.split("/");
    const key = decodeURIComponent(parts.join("/"));
    const body = await bodyOf(req);
    const ifNoneMatch = req.headers["if-none-match"];
    requests.push({ ifNoneMatch, key, method: req.method ?? "" });
    if (inBucket !== bucket) {
      fail(res, 404, "NoSuchBucket", "The specified bucket does not exist");
      return;
    }
    const object = objects.get(key);
    switch (req.method) {
      case "PUT": {
        if (refuse.writes) {
          fail(res, 503, "ServiceUnavailable", "Please reduce your request rate.");
          return;
        }
        if (ifNoneMatch === "*" && object) {
          fail(
            res,
            412,
            "PreconditionFailed",
            "At least one of the pre-conditions you specified did not hold",
          );
          return;
        }
        const md5 = req.headers["content-md5"];
        if (md5 && createHash("md5").update(body).digest("base64") !== md5) {
          fail(
            res,
            400,
            "BadDigest",
            "The Content-MD5 you specified did not match what we received.",
          );
          return;
        }
        objects.set(key, body);
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        res.end();
        return;
      }
      case "GET":
      case "HEAD": {
        if (refuse.reads) {
          fail(res, 503, "ServiceUnavailable", "Please reduce your request rate.");
          return;
        }
        if (!object) {
          fail(res, 404, "NoSuchKey", "The specified key does not exist.");
          return;
        }
        res.writeHead(200, {
          "content-length": String(object.length),
          "content-type": "application/octet-stream",
        });
        res.end(req.method === "GET" ? object : undefined);
        return;
      }
      case "DELETE": {
        if (refuse.deletes) {
          fail(res, 403, "AccessDenied", "Access Denied");
          return;
        }
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      default: {
        fail(res, 405, "MethodNotAllowed", "The specified method is not allowed");
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      fail(res, 500, "InternalError", String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    bucket,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    refuse,
    requests,
  };
}
