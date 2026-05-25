import type { Env, ReplyAuth } from "./types";
import { routeEmail } from "./email/router";
import { createApp } from "./api/app";

const app = createApp();

function parseAuthResults(headers: Headers): ReplyAuth {
  const authHeader = headers.get("Authentication-Results") || headers.get("ARC-Authentication-Results") || "";
  
  const spfMatch = /\bspf=([a-z]+)\b/i.exec(authHeader);
  const spf = spfMatch ? spfMatch[1].toUpperCase() : undefined;
  
  const dmarcMatch = /\bdmarc=([a-z]+)\b/i.exec(authHeader);
  const dmarc = dmarcMatch ? dmarcMatch[1].toUpperCase() : undefined;
  
  return { spf, dmarc };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const auth = parseAuthResults(message.headers);
    await routeEmail(message, env, undefined, auth);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
