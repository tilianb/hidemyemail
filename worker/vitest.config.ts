import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Async lives INSIDE cloudflareTest so the plugin registers synchronously and
    // the Workers pool actually activates (wrapping defineConfig in async breaks this).
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // test-only binding so a setup file can apply migrations
        miniflare: { 
          bindings: { 
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret",
            ACTION_SECRET: "test-action-secret",
            DESTINATION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=" // 32-byte valid base64 key
          } 
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"], passWithNoTests: true },
});
