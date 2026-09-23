// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  // Standalone Node server — `astro build` emits `dist/server/entry.mjs`, which
  // the Dockerfile runs after `db:deploy`.
  adapter: node({ mode: "standalone" }),
  output: "server",
  // Astro's built-in origin check rejects every cross-site POST/PUT/PATCH/DELETE
  // with a form-like content type, including text/plain. That blocks API
  // clients uploading text to /v1/content (they send no Origin), and behind a
  // TLS-terminating proxy it can reject the login form too. The viewer's own
  // form endpoints check the origin themselves (src/lib/viz-session.ts,
  // fromThisSite); the /v1 API authenticates every request with X-API-Key.
  security: { checkOrigin: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
