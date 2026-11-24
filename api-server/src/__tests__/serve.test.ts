import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";

// serve.mjs runs a module exporting startServer(), as the built entry does; this one answers at once (/), after
// 700 ms (/slow) or never (/hang), and tells whether autostart was off when it was loaded (/autostart).
const dir = mkdtempSync(path.join(tmpdir(), "rl-serve-test-"));
const entry = path.join(dir, "entry.mjs");
writeFileSync(
  entry,
  `import http from "node:http";
const autostart = process.env.ASTRO_NODE_AUTOSTART;
export function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/autostart") return res.end(String(autostart));
    if (req.url === "/slow") return setTimeout(() => res.end("slow, answered"), 700);
    if (req.url === "/hang") return;
    res.end("fast");
  });
  server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening"));
  return { server: { server }, done: new Promise(() => {}) };
}
`,
);
const serveScript = path.join(import.meta.dirname, "..", "..", "serve.mjs");

async function freePort(): Promise<number> {
  const srv = createServer().listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as AddressInfo;
  srv.close();
  await once(srv, "close");
  return port;
}

interface Running {
  base: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  port: number;
}

async function start(env: Record<string, string> = {}): Promise<Running> {
  const port = await freePort();
  const child = spawn(process.execPath, [serveScript], {
    env: { ...process.env, PORT: String(port), RL_SERVER_ENTRY: entry, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const collect = (d: Buffer) => {
    out += d.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  // "close" comes once the output is all in, after "exit".
  const exited = once(child, "close").then(([code]) => code as number | null);
  // The fake entry prints "listening" first, once its port is open.
  await once(child.stdout as NodeJS.ReadableStream, "data");
  if (!out.includes("listening")) {
    throw new Error(`serve.mjs did not start: ${out}`);
  }
  return { base: `http://127.0.0.1:${port}`, child, exited, output: () => out, port };
}

async function connectionRefused(port: number): Promise<boolean> {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    socket.destroy();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
  }
}

describe("serve.mjs", () => {
  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("starts the server itself, with the adapter's autostart off", async () => {
    const s = await start();
    const res = await fetch(`${s.base}/autostart`);
    await expect(res.text()).resolves.toBe("disabled");
    s.child.kill("SIGTERM");
    await expect(s.exited).resolves.toBe(0);
  });

  it("answers the request in flight at SIGTERM, refuses new connections, then exits with status 0", async () => {
    const s = await start();
    const slow = fetch(`${s.base}/slow`).then(async (res) => ({
      body: await res.text(),
      status: res.status,
    }));
    await sleep(150);
    const signalled = Date.now();
    s.child.kill("SIGTERM");
    await sleep(100);
    await expect(connectionRefused(s.port)).resolves.toBeTruthy();
    await expect(slow).resolves.toStrictEqual({ body: "slow, answered", status: 200 });
    await expect(s.exited).resolves.toBe(0);
    expect(Date.now() - signalled).toBeLessThan(2500);
    expect(s.output()).toContain(
      "serve: SIGTERM: taking no new connections; 1 request(s) in flight",
    );
    expect(s.output()).toContain("serve: every request answered; exiting");
  });

  it("does not wait for a kept-alive connection that sits idle", async () => {
    const s = await start();
    const res = await fetch(`${s.base}/`);
    await expect(res.text()).resolves.toBe("fast");
    const signalled = Date.now();
    s.child.kill("SIGINT");
    await expect(s.exited).resolves.toBe(0);
    expect(Date.now() - signalled).toBeLessThan(1500);
    expect(s.output()).toContain(
      "serve: SIGINT: taking no new connections; 0 request(s) in flight",
    );
  });

  it("closes what is still open once RL_SHUTDOWN_GRACE_MS has passed", async () => {
    const s = await start({ RL_SHUTDOWN_GRACE_MS: "300" });
    const hang = fetch(`${s.base}/hang`).then(
      () => "answered",
      () => "cut off",
    );
    await sleep(100);
    const signalled = Date.now();
    s.child.kill("SIGTERM");
    await expect(hang).resolves.toBe("cut off");
    await expect(s.exited).resolves.toBe(0);
    expect(Date.now() - signalled).toBeLessThan(2000);
    expect(s.output()).toContain("serve: closing the connections still open after 300 ms");
  });

  it("refuses an RL_SHUTDOWN_GRACE_MS that is not a number of milliseconds", async () => {
    const child = spawn(process.execPath, [serveScript], {
      env: { ...process.env, RL_SERVER_ENTRY: entry, RL_SHUTDOWN_GRACE_MS: "soon" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const [code] = await once(child, "close");
    expect(code).toBe(1);
    expect(err).toContain("RL_SHUTDOWN_GRACE_MS must be a number of milliseconds, not soon");
  });
});
