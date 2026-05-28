import type { Env } from "../types";
import * as q from "../db/queries";
import { utf8 } from "../lib/bytes";
import { decryptDestination, encryptDestination } from "../lib/crypto";

function buf2hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// HMAC input is `${action}:${payload}`. For the legacy "disable" verb, payload
// is the numeric alias id stringified — keeps signatures from migration 0014
// identical to those produced before the verb expansion, so existing forwarded
// emails carrying List-Unsubscribe links keep working.
export async function signAction(action: string, payload: string | number, env: Env): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.ACTION_SECRET || env.SESSION_SECRET);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, utf8(`${action}:${payload}`));
  return buf2hex(signature).slice(0, 32);
}

function constantTimeEqual(a: string, b: string): boolean {
  let match = a.length === b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) match = false;
  }
  return match;
}

async function verify(action: string, payload: string, sig: string, env: Env): Promise<boolean> {
  const expected = await signAction(action, payload, env);
  return constantTimeEqual(expected, sig);
}

export async function handleAction(message: ForwardableEmailMessage, env: Env, actionType: string, payload: string): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  switch (actionType) {
    case "disable": {
      // Payload: "<aliasId>_<sig>"
      const [idStr, sig] = payload.split("_");
      if (!idStr || !sig) return;
      const aliasId = parseInt(idStr, 10);
      if (isNaN(aliasId)) return;
      if (!await verify("disable", String(aliasId), sig, env)) {
        console.warn("Invalid disable signature for alias", aliasId);
        return;
      }
      const alias = await q.getAliasById(db, aliasId);
      if (!alias || alias.active === 0) return;
      await db.prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(aliasId).run();
      await q.insertEvent(db, { alias_id: aliasId, type: "block", external_sender: message.from, detail: "disabled via List-Unsubscribe", ts: now });
      return;
    }

    case "block": {
      // Payload: "<aliasId>_<encodedSender>_<sig>". encodedSender is base64url(message.from-time-of-send).
      // Signing the sender into the payload binds the action to the exact "From" the forwarded
      // email surfaced — stops a leaked link from blocking some other sender.
      const firstSep = payload.indexOf("_");
      const lastSep = payload.lastIndexOf("_");
      if (firstSep <= 0 || lastSep <= firstSep) return;
      const idStr = payload.slice(0, firstSep);
      const encSender = payload.slice(firstSep + 1, lastSep);
      const sig = payload.slice(lastSep + 1);
      const aliasId = parseInt(idStr, 10);
      if (isNaN(aliasId)) return;
      if (!await verify("block", `${aliasId}:${encSender}`, sig, env)) {
        console.warn("Invalid block signature for alias", aliasId);
        return;
      }
      const sender = decodeSender(encSender);
      if (!sender) return;
      const alias = await q.getAliasById(db, aliasId);
      if (!alias) return;
      await db.prepare(
        "INSERT INTO blocks (user_id, alias_id, pattern, created_at) VALUES (?,?,?,?)"
      ).bind(alias.user_id, aliasId, sender, now).run();
      await q.insertEvent(db, { alias_id: aliasId, type: "block", external_sender: sender, detail: "blocked via inline action", ts: now });
      return;
    }

    case "mute7": {
      // Payload: "<aliasId>_<sig>"
      const [idStr, sig] = payload.split("_");
      if (!idStr || !sig) return;
      const aliasId = parseInt(idStr, 10);
      if (isNaN(aliasId)) return;
      if (!await verify("mute7", String(aliasId), sig, env)) {
        console.warn("Invalid mute7 signature for alias", aliasId);
        return;
      }
      const alias = await q.getAliasById(db, aliasId);
      if (!alias) return;
      const until = now + 7 * 24 * 3600_000;
      await db.prepare("UPDATE aliases SET muted_until = ? WHERE id = ?").bind(until, aliasId).run();
      await q.insertEvent(db, { alias_id: aliasId, type: "block", external_sender: message.from, detail: "muted 7d via inline action", ts: now });
      return;
    }

    case "route": {
      // Payload: "<aliasId>_<destId>_<sig>". destId resolves to one of the user's verified destinations.
      const parts = payload.split("_");
      if (parts.length < 3) return;
      const sig = parts.pop()!;
      const destIdStr = parts.pop()!;
      const idStr = parts.join("_");
      const aliasId = parseInt(idStr, 10);
      const destId = parseInt(destIdStr, 10);
      if (isNaN(aliasId) || isNaN(destId)) return;
      if (!await verify("route", `${aliasId}:${destId}`, sig, env)) {
        console.warn("Invalid route signature for alias", aliasId);
        return;
      }
      const alias = await q.getAliasById(db, aliasId);
      if (!alias) return;
      const dest = await db.prepare(
        "SELECT email FROM destinations WHERE id = ? AND user_id = ? AND verified_at IS NOT NULL"
      ).bind(destId, alias.user_id).first<{ email: string }>();
      if (!dest) {
        console.warn("Route target not owned or unverified", destId);
        return;
      }
      const plain = await decryptDestination(dest.email, env.DESTINATION_ENCRYPTION_KEY);
      const enc = await encryptDestination(plain, env.DESTINATION_ENCRYPTION_KEY);
      await db.prepare("UPDATE aliases SET destination = ? WHERE id = ?").bind(enc, aliasId).run();
      await q.insertEvent(db, { alias_id: aliasId, type: "forward", external_sender: message.from, detail: `rerouted via inline action to dest#${destId}`, ts: now });
      return;
    }

    default:
      return;
  }
}

function decodeSender(encoded: string): string | null {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const bytes = atob(padded + pad);
    return bytes.includes("@") ? bytes.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function encodeSender(sender: string): string {
  return btoa(sender).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
