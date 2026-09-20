import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Migrations run as the migration account (MIGRATION_DATABASE_URL); the server
// itself connects with DATABASE_URL as the runtime account (see src/lib/prisma.ts).
// Single-account setups, such as local development, may set only DATABASE_URL.
export default defineConfig({
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
  },
  schema: "prisma/schema.prisma",
});
