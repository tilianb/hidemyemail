import { Hono } from "hono";
import type { AppEnv } from "../app";
import { hashDestination, encryptDestination, decryptDestination } from "../../lib/crypto";
import { getNumericSetting } from "../../lib/settings";

// Validate email local part (RFC 5321 safe subset)
function isValidLocalPart(s: string): boolean {
  if (!s || s.length > 64) return false;
  // Allow lowercase alphanumeric, dots, hyphens; no leading/trailing dot/hyphen, no consecutive dots
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(s) && !s.includes("..");
}

export function aliasRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/aliases", async (c) => {
    const userId = c.get("userId");
    const query = c.req.query("q");
    const sql = query
      ? "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.user_id = ? AND a.full_address LIKE ? ORDER BY a.created_at DESC LIMIT 500"
      : "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 500";
    const stmt = query ? c.env.DB.prepare(sql).bind(userId, `%${query}%`) : c.env.DB.prepare(sql).bind(userId);
    const rows = await stmt.all<any>();
    
    const results = [];
    for (const row of rows.results ?? []) {
      if (row.destination) {
        row.destination = await decryptDestination(row.destination, c.env.DESTINATION_ENCRYPTION_KEY);
      }
      results.push(row);
    }
    return c.json(results);
  });

  r.post("/aliases", async (c) => {
    const userId = c.get("userId");
    const b = await c.req.json<{ domain_id: number; local_part: string; destination?: string; label?: string }>();
    const dom = await c.env.DB.prepare("SELECT domain, is_global, user_id, allow_custom_aliases, active, verified_at FROM domains WHERE id=?").bind(b.domain_id).first<{ domain: string, is_global: number, user_id: number, allow_custom_aliases: number, active: number, verified_at: number | null }>();
    if (!dom) return c.json({ error: "Unknown domain" }, 400);
    
    const maxTotal = await getNumericSetting(c.env.DB, "max_total_aliases");
    if (maxTotal >= 0) {
      const totalCount = await c.env.DB.prepare("SELECT COUNT(*) as count FROM aliases WHERE user_id = ?").bind(userId).first<{ count: number }>();
      if (totalCount && totalCount.count >= maxTotal) {
        return c.json({ error: "Total alias quota exceeded" }, 400);
      }
    }

    if (dom.is_global === 0 && dom.user_id !== userId) {
      return c.json({ error: "Not your domain" }, 403);
    }
    if (dom.is_global === 1 && (dom.active !== 1 || !dom.verified_at)) {
      return c.json({ error: "Domain unavailable" }, 400);
    }

    let destinationToUse = b.destination;
    if (!destinationToUse && dom.is_global === 1) {
      const defaultDest = await c.env.DB.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(userId).first<{ email: string }>();
      if (!defaultDest) {
        return c.json({ error: "You must select a destination or set a default destination" }, 400);
      }
      destinationToUse = await decryptDestination(defaultDest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    }

    if (destinationToUse) {
      const emailHash = await hashDestination(destinationToUse.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
      const destVerified = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email_hash = ? AND verified_at IS NOT NULL").bind(userId, emailHash).first();
      if (!destVerified) return c.json({ error: "Destination email not verified" }, 400);
    }

    let localPart = b.local_part.toLowerCase();
    if (dom.is_global === 1 && !dom.allow_custom_aliases) {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      const arr = new Uint8Array(8);
      crypto.getRandomValues(arr);
      localPart = Array.from(arr).map(x => chars[x % chars.length]).join("");
    } else {
      if (localPart.startsWith("r.")) return c.json({ error: "Reserved prefix" }, 400);
      if (!isValidLocalPart(localPart)) {
        return c.json({ error: "Invalid local part — use only letters, numbers, dots, hyphens" }, 400);
      }
    }
    
    const full = `${localPart}@${dom.domain}`;
    
    try {
      const destEnc = destinationToUse ? await encryptDestination(destinationToUse.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY) : null;
      const destHash = destinationToUse ? await hashDestination(destinationToUse.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY) : null;

      const row = await c.env.DB.prepare(
        "INSERT INTO aliases (domain_id, user_id, local_part, full_address, destination, destination_hash, label, active, source, created_at) " +
        "VALUES (?,?,?,?,?,?,?,1,'dashboard',?) RETURNING *"
      ).bind(b.domain_id, userId, localPart, full, destEnc, destHash, b.label ?? null, Date.now()).first<any>();
      
      if (row && row.destination) {
        row.destination = await decryptDestination(row.destination, c.env.DESTINATION_ENCRYPTION_KEY);
      }
      return c.json(row);
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Alias already exists" }, 409);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  r.patch("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const b = await c.req.json<{ active?: number; destination?: string | null; label?: string | null }>();
    
    if (b.destination) {
      const emailHash = await hashDestination(b.destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
      const destVerified = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email_hash = ? AND verified_at IS NOT NULL").bind(userId, emailHash).first();
      if (!destVerified) return c.json({ error: "Destination email not verified" }, 400);
    }

    const sets: string[] = []; const vals: unknown[] = [];
    if (b.active !== undefined) {
      if (b.active !== 0 && b.active !== 1) return c.json({ error: "Active must be 0 or 1" }, 400);
      sets.push("active=?"); vals.push(b.active);
    }
    if (b.destination !== undefined) {
      let destinationToUse = b.destination;
      if (!destinationToUse) {
        const aliasInfo = await c.env.DB.prepare("SELECT d.is_global FROM aliases a JOIN domains d ON a.domain_id = d.id WHERE a.id = ? AND a.user_id = ?").bind(id, userId).first<{ is_global: number }>();
        if (aliasInfo?.is_global === 1) {
          const defaultDest = await c.env.DB.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(userId).first<{ email: string }>();
          if (!defaultDest) {
            return c.json({ error: "You must select a destination or set a default destination" }, 400);
          }
          destinationToUse = await decryptDestination(defaultDest.email, c.env.DESTINATION_ENCRYPTION_KEY);
        }
      }

      if (destinationToUse) {
        sets.push("destination=?"); vals.push(await encryptDestination(destinationToUse.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY));
        sets.push("destination_hash=?"); vals.push(await hashDestination(destinationToUse.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY));
      } else {
        sets.push("destination=?"); vals.push(null);
        sets.push("destination_hash=?"); vals.push(null);
      }
    }
    if (b.label !== undefined) { sets.push("label=?"); vals.push(b.label); }
    if (!sets.length) return c.json({ error: "No fields" }, 400);
    vals.push(id, userId);
    
    const res = await c.env.DB.prepare(`UPDATE aliases SET ${sets.join(", ")} WHERE id=? AND user_id=?`).bind(...vals).run();
    if (res.meta.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  r.delete("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    try {
      const exists = await c.env.DB.prepare("SELECT id FROM aliases WHERE id=? AND user_id=?").bind(id, userId).first();
      if (!exists) return c.json({ error: "Alias not found" }, 404);
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM reverse_map WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM blocks WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM events WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM aliases WHERE id=? AND user_id=?").bind(id, userId),
      ]);
      return c.json({ ok: true });
    } catch (err) {
      console.error("alias delete failed:", err);
      return c.json({ error: "Delete failed" }, 500);
    }
  });

  r.get("/aliases/:id/events", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const rows = await c.env.DB.prepare(
      "SELECT e.* FROM events e JOIN aliases a ON e.alias_id = a.id WHERE e.alias_id=? AND a.user_id=? ORDER BY e.ts DESC LIMIT 200"
    ).bind(id, userId).all();
    return c.json(rows.results ?? []);
  });

  return r;
}
