// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  // Standalone Node server — `astro build` emits `dist/server/entry.mjs` and a
  // `dist/index.js` launcher, which the Dockerfile runs with `node dist/index.js`.
  output: "server",
  adapter: node({ mode: "standalone" }),
  vite: {
    plugins: [tailwindcss()],
  },
});
