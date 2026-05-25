import type { Env, ParsedReverse, ReplyAuth } from "../types";
import { handleInbound as defInbound } from "./inbound";
import { handleReply as defReply } from "./reply";
import { parseReverse } from "../lib/reverse";

interface Deps {
  handleInbound: (m: ForwardableEmailMessage, env: Env) => Promise<void>;
  handleReply: (m: ForwardableEmailMessage, env: Env, parsed: ParsedReverse, auth?: ReplyAuth) => Promise<void>;
}

export async function routeEmail(
  message: ForwardableEmailMessage, env: Env,
  deps: Deps = { handleInbound: defInbound, handleReply: defReply },
  auth?: ReplyAuth,
): Promise<void> {
  const localPart = message.to.slice(0, message.to.lastIndexOf("@"));
  const parsed = parseReverse(localPart);
  if (parsed) return deps.handleReply(message, env, parsed, auth);
  return deps.handleInbound(message, env);
}
