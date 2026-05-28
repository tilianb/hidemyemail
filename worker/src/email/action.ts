import type { Env } from "../types";
import * as q from "../db/queries";
import { utf8 } from "../lib/bytes";
import { parseMime, getHeader } from "../lib/mime";

// Create a simple hex string representation of an ArrayBuffer
function buf2hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function signAction(action: string, aliasId: number, env: Env): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.ACTION_SECRET || env.SESSION_SECRET);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, utf8(`${action}:${aliasId}`));
  return buf2hex(signature).slice(0, 32); // 32 hex chars is enough entropy for this
}

export async function handleAction(message: ForwardableEmailMessage, env: Env, actionType: string, payload: string): Promise<void> {
  const db = env.DB;
  
  if (actionType !== "disable") {
    return; // Currently only 'disable' is supported
  }

  // Payload format for disable: <alias_id>_<signature>
  const parts = payload.split("_");
  const [idStr, sig] = parts;
  if (!idStr || !sig) return;

  const aliasId = parseInt(idStr, 10);
  if (isNaN(aliasId)) return;

  const expectedSig = await signAction("disable", aliasId, env);
  
  // Basic constant-time comparison
  let match = expectedSig.length === sig.length;
  for (let i = 0; i < expectedSig.length; i++) {
    if (expectedSig[i] !== sig[i]) match = false;
  }
  if (!match) {
    console.warn("Invalid action signature for alias", aliasId);
    return;
  }

  const alias = await q.getAliasById(db, aliasId);
  if (!alias) return;

  if (alias.active === 1) {
    await db.prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(aliasId).run();
    await q.insertEvent(db, {
      alias_id: aliasId,
      type: "block", // using block event or create a new 'system' type event? 'reject' with 'disabled' might be better for tracking
      external_sender: message.from,
      detail: "disabled via List-Unsubscribe",
      ts: Date.now()
    });
  }
}
