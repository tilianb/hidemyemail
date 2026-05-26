import type { Env, ParsedReverse, ReplyAuth } from "../types";
import { handleInbound as defInbound } from "./inbound";
import { handleReply as defReply } from "./reply";
import { handleAction as defAction } from "./action";
import { parseReverse } from "../lib/reverse";

interface Deps {
  handleInbound: (m: ForwardableEmailMessage, env: Env) => Promise<void>;
  handleReply: (m: ForwardableEmailMessage, env: Env, parsed: ParsedReverse, auth?: ReplyAuth) => Promise<void>;
  handleAction: (m: ForwardableEmailMessage, env: Env, actionType: string, payload: string) => Promise<void>;
}

export async function routeEmail(
  message: ForwardableEmailMessage, env: Env,
  deps: Deps = { handleInbound: defInbound, handleReply: defReply, handleAction: defAction },
  auth?: ReplyAuth,
): Promise<void> {
  const localPart = message.to.slice(0, message.to.lastIndexOf("@"));
  
  if (localPart.startsWith("action+")) {
    const actionPart = localPart.slice(7); // "action+".length
    const eq = actionPart.indexOf("=");
    if (eq > 0) {
      const actionType = actionPart.slice(0, eq);
      const payload = actionPart.slice(eq + 1);
      return deps.handleAction(message, env, actionType, payload);
    }
  }

  const parsed = parseReverse(localPart);
  if (parsed) return deps.handleReply(message, env, parsed, auth);
  return deps.handleInbound(message, env);
}
