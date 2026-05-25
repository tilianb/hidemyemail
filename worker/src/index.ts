import type { Env } from "./types";
import { routeEmail } from "./email/router";
import { createApp } from "./api/app";

const app = createApp();

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await routeEmail(message, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
