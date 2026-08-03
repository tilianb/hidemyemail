import type { Env } from "./types";
import { createApp } from "./api/app";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const { purgeDeletedAccounts, pruneOldEvents, pruneExpiredRevokedSessions } = await import("./lib/purge");
    await purgeDeletedAccounts(env.DB, now);
    await pruneOldEvents(env.DB, now);
    await pruneExpiredRevokedSessions(env.DB, now);
  },
} satisfies ExportedHandler<Env>;
