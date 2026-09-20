/**
 * Local test gate: lint, format and type checks, then every suite against a
 * throwaway Postgres database and an api-server started on this machine.
 * Nothing here talks to a deployed environment.
 *
 *   pnpm test:local          # static checks + unit + integration
 *   pnpm test:static         # static checks only (no database)
 *   pnpm test:unit           # unit suites only
 *   pnpm test:integration    # integration suites only
 *
 * The flags --static, --unit and --integration combine; with none, everything runs.
 *
 * Postgres: the user in RL_TEST_ADMIN_URL must be allowed to CREATE DATABASE and
 * CREATE ROLE. Migrations run as that user; the api-server runs as a separate
 * runtime role, created with a random password (so this works where Postgres
 * asks for one) and the privileges from api-server/prisma/grants.sql.
 * When RL_TEST_ADMIN_URL is unset, DATABASE_URL (from the environment or
 * api-server/.env) is used with its database swapped for "postgres".
 * Each run creates `rl_test_<random>`, a runtime role and a temporary content
 * directory, and removes them at the end; set RL_TEST_KEEP_DB=1 to keep the
 * database and content directory for debugging.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const requireFromApi = createRequire(path.join(root, "api-server/package.json"));
const { Client } = requireFromApi("pg");

const args = new Set(process.argv.slice(2));
const chosen = ["--static", "--unit", "--integration"].filter((flag) => args.has(flag));
const runs = (flag: string) => chosen.length === 0 || args.has(flag);
const runStatic = runs("--static");
const runUnit = runs("--unit");
const runIntegration = runs("--integration");

interface Result {
  label: string;
  ok: boolean;
  seconds: number;
}
const results: Result[] = [];
let serverLog: string | undefined;

function readDotenv(file: string): Record<string, string> {
  if (!existsSync(file)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) {
      out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function adminUrl(): URL {
  if (process.env.RL_TEST_ADMIN_URL) {
    return new URL(process.env.RL_TEST_ADMIN_URL);
  }
  const fromEnv =
    process.env.DATABASE_URL ?? readDotenv(path.join(root, "api-server/.env")).DATABASE_URL;
  if (!fromEnv) {
    throw new Error(
      "No Postgres to test against: set RL_TEST_ADMIN_URL, or DATABASE_URL in api-server/.env.",
    );
  }
  const url = new URL(fromEnv);
  url.pathname = "/postgres";
  return url;
}

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl().toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function step(label: string, cmd: string, cmdArgs: string[], env: Record<string, string> = {}) {
  console.log(`\n▶ ${label}\n  $ ${cmd} ${cmdArgs.join(" ")}`);
  const started = Date.now();
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const ok = r.status === 0;
  results.push({ label, ok, seconds: (Date.now() - started) / 1000 });
  return ok;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The server closes idle keep-alive sockets after a few seconds; a request that
 * picks a closed one up from the pool fails with a network error, so try again
 * on a fresh connection.
 */
async function fetchRetrying(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function waitUntilReady(baseUrl: string, server: ChildProcess): Promise<void> {
  // An authenticated endpoint answers 401 without a key once the server is up.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`api-server exited early with code ${server.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/v1/owners/me`);
      if (res.status === 401) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("api-server did not become ready within 30s");
}

async function registerOwner(baseUrl: string, adminToken: string): Promise<string> {
  const res = await fetchRetrying(`${baseUrl}/v1/owners`, {
    body: JSON.stringify({
      email: `it-${randomBytes(6).toString("hex")}@example.com`,
      wallet_mode: "custodial",
    }),
    headers: { "content-type": "application/json", "x-admin-token": adminToken },
    method: "POST",
  });
  const body = (await res.json()) as { api_key?: string };
  if (!res.ok || !body.api_key) {
    throw new Error(`owner registration failed: HTTP ${res.status}`);
  }
  return body.api_key;
}

/**
 * The trace viewer on the built server: pages need a sign-in, the API
 * reference stays public, sign-in never redirects off-site, the owner's
 * session pages render with their referenced content, sign-out ends the
 * session. Runs after the integration suites, whose sessions it opens.
 */
async function viewerSmoke(baseUrl: string, apiKey: string): Promise<boolean> {
  console.log("\n▶ smoke: trace viewer");
  const started = Date.now();
  const problems: string[] = [];
  const want = (ok: boolean, what: string) => {
    if (!ok) {
      problems.push(what);
    }
  };
  const request = (pathname: string, init: RequestInit = {}) =>
    fetchRetrying(`${baseUrl}${pathname}`, {
      ...init,
      // The viewer rejects cross-site form posts; a browser on the page sends its own origin.
      headers: { origin: baseUrl, ...init.headers },
      redirect: "manual",
    });
  const form = (fields: Record<string, string>) => ({
    body: new URLSearchParams(fields),
    method: "POST",
  });
  const { version } = JSON.parse(readFileSync(path.join(root, "api-server/package.json"), "utf8"));

  const anonymous = await request("/");
  want(
    anonymous.status === 302 && (anonymous.headers.get("location") ?? "").startsWith("/login"),
    `/ without a session: expected a redirect to /login, got ${anonymous.status}`,
  );
  const health = await request("/health");
  want(health.status === 200, `/health: expected 200, got ${health.status}`);
  const reference = await request("/v1");
  want(reference.status === 200, `/v1 API reference: expected 200, got ${reference.status}`);
  const spec = await request("/v1/spec.json");
  const specVersion = spec.ok ? ((await spec.json()) as { info?: { version?: string } }).info?.version : undefined;
  want(specVersion === version, `/v1/spec.json: expected version ${version}, got ${specVersion}`);

  const crossSite = await request("/session", {
    ...form({ next: "/", token: apiKey }),
    headers: { origin: "https://evil.example" },
  });
  want(crossSite.status === 403, `sign-in from another site: expected 403, got ${crossSite.status}`);
  const wrongKey = await request("/session", form({ next: "/", token: "sl_wrong" }));
  want(
    wrongKey.status === 303 && (wrongKey.headers.get("location") ?? "").startsWith("/login?error=1"),
    `sign-in with a wrong key: expected a redirect to /login?error=1, got ${wrongKey.status}`,
  );
  const signIn = await request("/session", form({ next: "/\\evil.example", token: apiKey }));
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  want(
    signIn.status === 303 && signIn.headers.get("location") === "/",
    `sign-in: expected a redirect to / (never off-site), got ${signIn.status} ${signIn.headers.get("location")}`,
  );
  want(cookie.startsWith("rl_viz="), "sign-in: expected the rl_viz cookie");
  const signedIn = await request("/", { headers: { cookie } });
  want(signedIn.status === 200, `/ with a session: expected 200, got ${signedIn.status}`);
  const links = [
    ...new Set([...(await signedIn.text()).matchAll(/href="(\/traces\/[^"]+)"/g)].map((m) => m[1])),
  ];
  want(links.length > 0, "/ with a session: expected links to the owner's sessions");
  const pages: { link: string; status: number; text: string }[] = [];
  for (const link of links) {
    const res = await request(link.replaceAll("&amp;", "&"), { headers: { cookie } });
    pages.push({ link, status: res.status, text: await res.text() });
  }
  for (const page of pages.filter((p) => p.status !== 200)) {
    want(false, `${page.link}: expected 200, got ${page.status}`);
  }
  console.log(`  ${pages.length} session page(s) checked`);
  const rendered = pages.map((p) => p.text).join("\n");
  // Written by the cross-SDK fixture as raw text, so shown only if the page read the content.
  want(rendered.includes("Should we act?"), "session pages: expected the uploaded prompt text");
  want(rendered.includes("ATTESTING"), "session pages: expected an Attesting record");
  want(
    !rendered.includes("[content not available") && !rendered.includes("[content failed"),
    "session pages: some referenced content could not be shown",
  );
  const signOut = await request("/logout", { headers: { cookie }, method: "POST" });
  want(signOut.status === 303, `sign-out: expected 303, got ${signOut.status}`);
  const afterSignOut = await request("/", { headers: { cookie } });
  want(afterSignOut.status === 302, `/ after sign-out: expected a redirect, got ${afterSignOut.status}`);

  for (const problem of problems) {
    console.log(`  ✗ ${problem}`);
  }
  const ok = problems.length === 0;
  results.push({ label: "smoke: trace viewer", ok, seconds: (Date.now() - started) / 1000 });
  return ok;
}

function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), 5000).unref();
  });
}

function staticChecks() {
  step("lint: api-server", "pnpm", ["--dir", "api-server", "check"]);
  step("types: api-server", "pnpm", ["--dir", "api-server", "typecheck"]);
  step("lint: typescript-sdk", "pnpm", ["--dir", "typescript-sdk", "check"]);
  step("types: typescript-sdk", "pnpm", ["--dir", "typescript-sdk", "typecheck"]);
  const py = ["run", "--locked", "--directory", "python-sdk"];
  step("lint: python-sdk", "uv", [...py, "ruff", "check"]);
  step("format: python-sdk", "uv", [...py, "ruff", "format", "--check"]);
  step("types: python-sdk", "uv", [...py, "ty", "check"]);
}

async function databaseSuites(): Promise<void> {
  const dbName = `rl_test_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const dbUrl = adminUrl();
  dbUrl.pathname = `/${dbName}`;
  const runtimeRole = `${dbName}_rt`;
  const runtimePassword = randomBytes(12).toString("hex");
  const runtimeUrl = new URL(dbUrl);
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = runtimePassword;
  const contentDir = mkdtempSync(path.join(tmpdir(), `${dbName}-content-`));
  const dbEnv = { CONTENT_DIR: contentDir, DATABASE_URL: dbUrl.toString() };
  let server: ChildProcess | undefined;

  const cleanup = async () => {
    await stopServer(server);
    if (process.env.RL_TEST_KEEP_DB === "1") {
      console.log(`\nkept database ${dbName} and content directory ${contentDir}`);
      return;
    }
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    rmSync(contentDir, { force: true, recursive: true });
  };
  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  await admin(`CREATE DATABASE "${dbName}"`);
  await admin(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`);
  console.log(`database ${dbName} and runtime role ${runtimeRole} created`);
  try {
    const deployEnv = { ...dbEnv, MIGRATION_DATABASE_URL: dbUrl.toString(), RL_RUNTIME_ROLE: runtimeRole };
    if (!step("migrate", "pnpm", ["--dir", "api-server", "db:deploy"], deployEnv)) {
      return;
    }

    if (runUnit) {
      step("unit: api-server", "pnpm", ["--dir", "api-server", "test"], {
        ...dbEnv,
        RL_TEST_RUNTIME_URL: runtimeUrl.toString(),
      });
      step("unit: typescript-sdk", "pnpm", ["--dir", "typescript-sdk", "test"]);
      step("unit: python-sdk", "uv", ["run", "--locked", "--directory", "python-sdk", "pytest", "-q"]);
    }

    if (runIntegration) {
      const sdkBuilt = step("build: typescript-sdk", "pnpm", ["--dir", "typescript-sdk", "build"]);
      if (sdkBuilt) {
        // The integration suites import the built SDK, so they are type-checked after the build.
        step("types: integration-tests/typescript", "pnpm", [
          "--dir",
          "integration-tests/typescript",
          "exec",
          "tsc",
          "-p",
          ".",
        ]);
      }
      const built =
        sdkBuilt &&
        step("build: api-server", "pnpm", ["--dir", "api-server", "build"]) &&
        step("sync: integration-tests/python", "uv", [
          "sync",
          "--locked",
          "--directory",
          "integration-tests/python",
        ]);
      if (built) {
        const port = await freePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const adminToken = randomBytes(16).toString("hex");
        serverLog = path.join(tmpdir(), `${dbName}-api-server.log`);
        const logFd = openSync(serverLog, "w");
        server = spawn("node", [path.join(root, "api-server/dist/server/entry.mjs")], {
          cwd: path.join(root, "api-server"),
          env: {
            ...process.env,
            ...dbEnv,
            DATABASE_URL: runtimeUrl.toString(),
            HOST: "127.0.0.1",
            PORT: String(port),
            RL_ADMIN_TOKEN: adminToken,
          },
          stdio: ["ignore", logFd, logFd],
        });
        closeSync(logFd);
        await waitUntilReady(baseUrl, server);
        console.log(`\napi-server ready at ${baseUrl} (log: ${serverLog})`);

        const apiKey = await registerOwner(baseUrl, adminToken);
        const itEnv = {
          PYTHON: path.join(root, "integration-tests/python/.venv/bin/python"),
          STAIRAI_STAGING_API_KEY: apiKey,
          STAIRAI_STAGING_BASE_URL: baseUrl,
          TSX_BIN: path.join(root, "integration-tests/typescript/node_modules/.bin/tsx"),
        };
        step("integration: typescript", "pnpm", ["--dir", "integration-tests/typescript", "test"], itEnv);
        step(
          "integration: python",
          "uv",
          ["run", "--locked", "--directory", "integration-tests/python", "pytest", "-q"],
          itEnv,
        );
        await viewerSmoke(baseUrl, apiKey);
      }
    }
  } finally {
    await cleanup();
  }
}

async function main(): Promise<number> {
  if (runStatic) {
    staticChecks();
  }
  if (runUnit || runIntegration) {
    await databaseSuites();
  }

  console.log("\nsummary");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(34)} ${r.seconds.toFixed(1)}s`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 && serverLog) {
    console.log(`\napi-server log: ${serverLog}`);
  }
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
