import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). Type it from
// applyD1Migrations' own signature so we don't depend on a D1Migration export.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as Parameters<typeof applyD1Migrations>[1]);
