// Starts the built server (dist/server/entry.mjs) and stops it without dropping a request.
//
// A rolling update, like `docker stop`, sends SIGTERM and kills the container once its stop timeout runs out. The
// built server, started directly, has no handler for SIGTERM, and in a container it is process 1, which ignores a
// signal it does not handle: every stop waited out the timeout and then killed the server, cutting off the request
// in flight. Started here instead, on SIGTERM or SIGINT the server takes no new connections, answers the requests in
// flight (one that arrives on a kept-alive connection is still answered, with `Connection: close`), closes connections
// as they fall idle, and exits with status 0. Connections still open after RL_SHUTDOWN_GRACE_MS milliseconds (default
// 8000, inside Docker's default stop timeout of 10 seconds) are closed then, so a platform's stop timeout should be
// longer than that.
//
// RL_SERVER_ENTRY names another module exporting startServer(), for the tests.
import { pathToFileURL } from "node:url";

// Read when the entry module is first evaluated: the server starts below, once the handlers are in place.
process.env.ASTRO_NODE_AUTOSTART = "disabled";

const entry = process.env.RL_SERVER_ENTRY
  ? pathToFileURL(process.env.RL_SERVER_ENTRY).href
  : new URL("dist/server/entry.mjs", import.meta.url).href;
const graceMs = Number(process.env.RL_SHUTDOWN_GRACE_MS ?? 8000);
if (!Number.isFinite(graceMs) || graceMs < 0) {
  console.error(
    `serve: RL_SHUTDOWN_GRACE_MS must be a number of milliseconds, not ${process.env.RL_SHUTDOWN_GRACE_MS}`,
  );
  process.exit(1);
}

// Filled in once the server is up; a signal before then has nothing to wait for.
const running = { http: undefined };
let inFlight = 0;
let stopping = false;
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const { startServer } = await import(entry);
running.http = startServer().server.server;
// Runs before the application's own handler, so the header is set before anything is written.
running.http.prependListener("request", (_req, res) => {
  inFlight += 1;
  res.once("close", () => {
    inFlight -= 1;
  });
  if (stopping) {
    res.setHeader("connection", "close");
  }
});

function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  const { http } = running;
  if (!http) {
    console.log(`serve: ${signal} before the server started; exiting`);
    process.exit(0);
  }
  console.log(`serve: ${signal}: taking no new connections; ${inFlight} request(s) in flight`);
  const sweep = setInterval(() => http.closeIdleConnections(), 250);
  const deadline = setTimeout(() => {
    console.log(`serve: closing the connections still open after ${graceMs} ms`);
    http.closeAllConnections();
  }, graceMs);
  setTimeout(() => {
    console.error("serve: the server did not close; exiting anyway");
    process.exit(1);
  }, graceMs + 5000).unref();
  http.close(() => {
    clearInterval(sweep);
    clearTimeout(deadline);
    console.log("serve: every request answered; exiting");
    process.exit(0);
  });
  http.closeIdleConnections();
}
