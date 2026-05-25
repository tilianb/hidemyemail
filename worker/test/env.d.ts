import type { Env as WorkerEnv } from "../src/types";

// `cloudflare:test` types `env` as `Cloudflare.Env`; augment it with our bindings
// so `env.DB`, `env.TEST_MIGRATIONS`, etc. are typed across all test files.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
