/**
 * Loads `api-server/.env` into `process.env` for the operator commands, the way
 * `prisma.config.ts` does for the Prisma CLI. Import it first: ES modules run
 * their imports in order, so every later module already sees the variables.
 *
 * Variables already set win over the file, so a platform that injects the
 * environment (the Docker image has no `.env`) is unaffected.
 */
import dotenv from "dotenv";

dotenv.config({ quiet: true });
