import type { Env } from "../types";
import { handleInbound as defInbound } from "./inbound";
import { handleReply as defReply } from "./reply";
import { parseReverse } from "../lib/reverse";

interface Deps {
  handleInbound: (m: ForwardableEmailMessage, env: Env) => Promise<void>;
  handleReply: (m: ForwardableEmailMessage, env: Env, token: string) => Promise<void>;
}

export async function routeEmail(
  message: ForwardableEmailMessage, env: Env,
  deps: Deps = { handleInbound: defInbound, handleReply: defReply }
): Promise<void> {
  const localPart = message.to.slice(0, message.to.lastIndexOf("@"));
  const token = parseReverse(localPart);
  if (token) return deps.handleReply(message, env, token);
  return deps.handleInbound(message, env);
}
