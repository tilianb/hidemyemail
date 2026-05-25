import type { Env } from "./types";
import { routeEmail } from "./email/router";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await routeEmail(message, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("ok"); // replaced in Task 14
  },
} satisfies ExportedHandler<Env>;
