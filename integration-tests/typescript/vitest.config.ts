import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Staging round-trips through Cloudflare + Postgres — give each test breathing room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run serially: shared agent + session state per file.
    fileParallelism: false,
  },
});
