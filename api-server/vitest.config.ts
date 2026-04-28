import { defineConfig } from "vitest/config";
import path from "node:path";

const __dirname = import.meta.dirname;

export default defineConfig({
  resolve: {
    // Mirror the `#/*` path alias declared in tsconfig.json.
    alias: {
      "#/": `${path.resolve(__dirname, "src")}/`,
    },
  },
  test: {
    // Run each test file in its own worker to keep global Prisma state isolated.
    pool: "forks",
    // Load DATABASE_URL and other env vars before any test module is imported.
    setupFiles: ["dotenv/config"],
  },
});
