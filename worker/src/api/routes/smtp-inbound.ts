import { Hono } from "hono";
import type { AppEnv } from "../app";
import { routeEmail } from "../../email/router";
import { parseReverse } from "../../lib/reverse";
import { getBoolSetting, getEnvWithOverride, getNumericSetting } from "../../lib/settings";
import { MailRetryableError, MailUncertainError } from "../../lib/mail-provider";
import * as q from "../../db/queries";

const ADDRESS = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+$/;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const VERDICTS = new Set(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"]);

async function authorized(request: Request, secret?: string): Promise<boolean> {
  const supplied = request.headers.get("x-hidemyemail-internal-secret") ?? "";
  if (!secret || !supplied) return false;
  const [a, b] = await Promise.all([secret, supplied].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  return crypto.subtle.timingSafeEqual(a!, b!);
}

async function recipientAccepted(db: D1Database, to: string): Promise<boolean> {
  const at = to.lastIndexOf("@");
  if (at <= 0 || !ADDRESS.test(to)) return false;
  const local = to.slice(0, at).toLowerCase();
  const domainName = to.slice(at + 1).toLowerCase();
  const domain = await q.getDomain(db, domainName) as (import("../../types").DomainRow & { user_id: number }) | null;
  if (!domain || domain.active !== 1) return false;
  if (local.startsWith("action+")) return /^action\+(disable|mute)=/.test(local);
  const reverse = parseReverse(local);
  const address = `${reverse?.aliasLocal ?? local}@${domainName}`;
  const alias = await q.getAlias(db, address);
  if (alias?.active === 1) return true;
  return !reverse && (domain.catch_all != null ? domain.catch_all === 1 : await getBoolSetting(db, "catch_all_auto_create"));
}

export function smtpInboundRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (c, next) => {
    if (!(await authorized(c.req.raw, c.env.SMTP_INGRESS_SECRET))) return c.notFound();
    await next();
  });

  routes.post("/smtp-recipient", async (c) => {
    const { to } = await c.req.json<{ to?: string }>().catch((): { to?: string } => ({}));
    if (!to || !ADDRESS.test(to)) return c.json({ accepted: false }, 400);
    return c.json({ accepted: await recipientAccepted(c.env.DB, to.toLowerCase()) });
  });

  routes.post("/smtp-config", async (c) => {
    const keys = [
      "ses_region", "ses_access_key_id", "ses_secret_access_key",
      "mail_outbound_provider", "smtp_outbound_host", "smtp_outbound_port", "smtp_outbound_tls",
      "smtp_outbound_username", "smtp_outbound_password", "smtp_inbound_enabled", "smtp_inbound_host",
      "smtp_inbound_port", "smtp_inbound_tls", "smtp_inbound_username", "smtp_inbound_password",
      "smtp_inbound_gateway_id", "smtp_inbound_trusted_peers", "smtp_inbound_max_bytes",
    ];
    const config: Record<string, string> = {};
    for (const key of keys) config[key.toUpperCase()] = await getEnvWithOverride(c.env.DB, c.env, key);
    return c.json(config);
  });

  routes.post("/smtp-ingest", async (c) => {
    type IngestBody = {
      gateway?: string; deliveryId?: string; from?: string; to?: string; rawBase64?: string;
      auth?: { spf?: string; dmarc?: string; spam?: string; virus?: string };
    };
    const body = await c.req.json<IngestBody>().catch((): IngestBody => ({}));
    if (!body.gateway || !DELIVERY_ID.test(body.gateway) || !body.deliveryId || !DELIVERY_ID.test(body.deliveryId)
      || !body.from || !ADDRESS.test(body.from) || !body.to || !ADDRESS.test(body.to) || !body.rawBase64) {
      return c.json({ error: "Invalid SMTP delivery" }, 400);
    }
    if (!(await recipientAccepted(c.env.DB, body.to.toLowerCase()))) return c.json({ error: "Recipient rejected" }, 400);
    const raw = Uint8Array.from(atob(body.rawBase64), (char) => char.charCodeAt(0));
    if (raw.length > await getNumericSetting(c.env.DB, "max_inbound_bytes")) return c.json({ error: "Message too large" }, 413);
    const authEntries = Object.entries(body.auth ?? {});
    const authKeys = ["spf", "dmarc", "spam", "virus"];
    if (authEntries.length !== authKeys.length || authEntries.some(([key, value]) => !authKeys.includes(key) || !VERDICTS.has(value))) {
      return c.json({ error: "Invalid gateway verdicts" }, 400);
    }
    const auth = body.auth as import("../../types").ReplyAuth;
    const id = `smtp:${body.gateway}:${body.deliveryId}:${body.to.toLowerCase()}`;
    const claim = await q.claimDelivery(c.env.DB, id, "inbound", Date.now(), id);
    if (claim.status !== "claimed") {
      return claim.status === "completed" ? c.json({ ok: true, duplicate: true }) : c.json({ error: "Already processing" }, 503);
    }

    const message = {
      from: body.from.toLowerCase(), to: body.to.toLowerCase(), rawSize: raw.length,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      headers: new Headers(), setReject() {}, async forward() {}, async reply() {},
    } as unknown as ForwardableEmailMessage;
    try {
      await routeEmail(message, c.env, undefined, auth, { id, token: claim.token });
      const row = await c.env.DB.prepare("SELECT state FROM mail_deliveries WHERE external_id=? AND claim_token=?")
        .bind(id, claim.token).first<{ state: string }>();
      if (row?.state !== "completed" && !(await q.completeDelivery(c.env.DB, id, claim.token, Date.now()))) {
        return c.json({ error: "Delivery lease lost" }, 503);
      }
      return c.json({ ok: true }, 202);
    } catch (error) {
      if (!(error instanceof MailUncertainError)) await q.releaseDelivery(c.env.DB, id, claim.token);
      const status = error instanceof MailRetryableError || error instanceof MailUncertainError ? 503 : 500;
      return c.json({ error: "Processing failed" }, status);
    }
  });
  return routes;
}
