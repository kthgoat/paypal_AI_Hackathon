import { defineConfig } from "prisma/config";

// Prisma 7 does not load env files by itself. Our convention is .env.local, so
// load it here (it never overrides variables that are already set).
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local yet: fall back to the default URL below.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Runs after `prisma migrate reset`, and via `prisma db seed`.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "file:./dev.db",
  },
});
