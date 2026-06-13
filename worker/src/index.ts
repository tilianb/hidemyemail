import type { Env } from "./types";
import { createApp } from "./api/app";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { purgeDeletedAccounts } = await import("./lib/purge");
    await purgeDeletedAccounts(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env>;
