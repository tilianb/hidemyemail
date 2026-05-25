import type { Env } from "./types";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 10
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("ok"); // replaced in Task 14
  },
} satisfies ExportedHandler<Env>;
