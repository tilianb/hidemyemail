import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { createBuiltinIngress } from "./builtin-ingress.mjs";
import { createMailQueue } from "./mail-queue.mjs";
import { scanMail, clamScan } from "./mail-scanner.mjs";
import { smtpTransportConfig } from "./smtp-transport.mjs";

const CONTROL = "x-hidemyemail-gateway-result";
const VERDICTS = new Set(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"]);

export function gatewayRecipient(to, domains) {
  return typeof to === "string" && /^[^\s<>@]+@[^\s<>@]+$/.test(to)
    && domains.includes(to.slice(to.lastIndexOf("@") + 1).toLowerCase());
}

export function gatewayMessage(raw, id, auth) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)
    || ["spf", "dmarc", "spam", "virus"].some(key => !VERDICTS.has(auth[key]))
    || !["PASS", "FAIL"].includes(auth.spam) || !["PASS", "FAIL"].includes(auth.virus)) {
    throw new Error("Gateway scan incomplete");
  }
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw Object.assign(new Error("Malformed MIME"), { permanent: true });
  const kept = [];
  let remove = false;
  for (const line of raw.subarray(0, end).toString("latin1").split("\r\n")) {
    if (!/^[ \t]/.test(line)) remove = line.slice(0, line.indexOf(":")).trim().toLowerCase() === CONTROL;
    if (!remove) kept.push(line);
  }
  kept.push(`X-HideMyEmail-Gateway-Result: v=1; id=${id}; spf=${auth.spf}; dmarc=${auth.dmarc}; spam=${auth.spam}; virus=${auth.virus}`);
  return Buffer.concat([Buffer.from(`${kept.join("\r\n")}\r\n\r\n`, "latin1"), raw.subarray(end + 4)]);
}

export async function relayGatewayMessage(payload, id, { scan, transport }) {
  const raw = Buffer.from(payload.rawBase64, "base64");
  const auth = await scan(raw, payload);
  try {
    await transport.sendMail({ envelope: { from: payload.from, to: [payload.to] }, raw: gatewayMessage(raw, id, auth) });
  } catch (error) {
    const code = Number(error.responseCode ?? 0);
    if (code >= 500 && code < 600) throw Object.assign(new Error("Gateway relay rejected"), { permanent: true });
    if (!(code >= 400 && code < 500) && (error.command === "DATA" || error.uncertain)) {
      throw Object.assign(new Error("Gateway acceptance uncertain"), { uncertain: true });
    }
    throw error;
  }
}

export async function createGateway(env) {
  const domains = (env.GATEWAY_DOMAINS || "").split(",").map(value => value.trim().toLowerCase());
  if (!domains.length || domains.some(domain => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain))) {
    throw new Error("GATEWAY_DOMAINS must list exact alias domains");
  }
  if (!env.GATEWAY_HOSTNAME || !env.GATEWAY_RELAY_USERNAME || !env.GATEWAY_RELAY_PASSWORD || !env.GATEWAY_RELAY_CA) {
    throw new Error("Gateway hostname, relay credentials, and CA certificate are required");
  }
  const config = smtpTransportConfig({
    SMTP_OUTBOUND_HOST: env.GATEWAY_RELAY_HOST || "app",
    SMTP_OUTBOUND_PORT: env.GATEWAY_RELAY_PORT || "2525",
    SMTP_OUTBOUND_TLS: "starttls",
    SMTP_OUTBOUND_USERNAME: env.GATEWAY_RELAY_USERNAME,
    SMTP_OUTBOUND_PASSWORD: env.GATEWAY_RELAY_PASSWORD,
  });
  config.name = env.GATEWAY_HOSTNAME;
  config.tls.ca = await readFile(env.GATEWAY_RELAY_CA);
  // Socket loss can report CONN after DATA. Record protocol readiness without
  // logging MIME, recipients, credentials, or SMTP transcripts.
  let dataReady = false;
  config.transactionLog = true;
  config.logger = Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].map(level => [level, (meta, text, ...args) => {
    if (meta?.tnx === "server" && /^354(?: |$)/.test(text === "%s" ? String(args[0]) : String(text))) dataReady = true;
  }]));
  const client = nodemailer.createTransport(config);
  const transport = { async sendMail(message) {
    dataReady = false;
    try { return await client.sendMail(message); }
    catch (error) { if (dataReady && !error.responseCode) error.uncertain = true; throw error; }
  } };
  const queue = await createMailQueue({
    directory: env.DATA_DIR || "/data",
    encryptionKey: env.GATEWAY_QUEUE_KEY,
    maxBytes: Number(env.MAIL_QUEUE_MAX_BYTES || 1024 ** 3),
    process: (_kind, payload, id) => relayGatewayMessage(payload, id, {
      transport,
      scan: (raw, session) => scanMail(raw, session, {
        hostname: env.GATEWAY_HOSTNAME,
        rspamdUrl: env.RSPAMD_URL || "http://rspamd:11333/checkv2",
        clam: message => clamScan(message, { host: env.CLAMAV_HOST || "clamav", port: Number(env.CLAMAV_PORT || 3310) }),
      }),
    }),
  });
  const ingress = await createBuiltinIngress({
    MAIL_HOSTNAME: env.GATEWAY_HOSTNAME, SMTP_INBOUND_HOST: "0.0.0.0", SMTP_INBOUND_PORT: "2525",
    SMTP_INBOUND_MAX_BYTES: env.GATEWAY_MAX_BYTES || "26214400",
  }, async (_operation, body) => Response.json({ accepted: gatewayRecipient(body.to, domains) }), queue);
  const checkSender = ingress.server.onMailFrom;
  ingress.server.onMailFrom = (address, session, callback) => {
    if (!address.address) return callback(Object.assign(new Error("Null return paths are not supported by gateway handoff"), { responseCode: 550 }));
    checkSender(address, session, callback);
  };
  return { ...ingress, queue, closeTransport: () => client.close() };
}
