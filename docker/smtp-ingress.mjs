import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { normalizeIp, trustedProxySet } from "./client-ip.mjs";

const CONTROL = "x-hidemyemail-gateway-result";
const ADDRESS = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+$/;
const VALUES = new Set(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"]);

function equal(a, b) {
  const left = Buffer.from(a ?? "");
  const right = Buffer.from(b ?? "");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseGatewayMessage(raw, gateway) {
  const split = raw.indexOf("\r\n\r\n");
  const separatorLength = 4;
  const fallback = split < 0 ? raw.indexOf("\n\n") : split;
  const end = split < 0 ? fallback : split;
  if (end < 0) throw new Error("Malformed MIME headers");
  const headerText = raw.subarray(0, end).toString("latin1");
  const lines = headerText.split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  const controls = unfolded.filter((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === CONTROL);
  if (controls.length !== 1) throw new Error("Exactly one trusted gateway result header is required");
  const entries = controls[0].slice(controls[0].indexOf(":") + 1).split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  });
  const required = ["v", "id", "spf", "dmarc", "spam", "virus"];
  if (entries.length !== required.length || new Set(entries.map(([key]) => key)).size !== required.length
    || entries.some(([key]) => !required.includes(key))) throw new Error("Invalid gateway result fields");
  const fields = Object.fromEntries(entries);
  if (fields.v !== "1" || !/^[A-Za-z0-9._:-]{1,200}$/.test(fields.id ?? "")) throw new Error("Invalid gateway result header");
  const auth = {};
  for (const key of ["spf", "dmarc", "spam", "virus"]) {
    if (!VALUES.has(fields[key])) throw new Error("Invalid gateway verdict");
    auth[key] = fields[key];
  }
  const kept = unfolded.filter((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() !== CONTROL);
  const bodyStart = end + (split < 0 ? 2 : separatorLength);
  const sanitized = Buffer.concat([Buffer.from(`${kept.join("\r\n")}\r\n\r\n`, "latin1"), raw.subarray(bodyStart)]);
  return { gateway, deliveryId: fields.id, auth, raw: sanitized };
}

export async function createSmtpIngress(env, dispatch) {
  if (env.SMTP_INBOUND_ENABLED !== "true") return null;
  const host = env.SMTP_INBOUND_HOST ?? "127.0.0.1";
  const port = Number(env.SMTP_INBOUND_PORT ?? 2525);
  const mode = env.SMTP_INBOUND_TLS ?? "starttls";
  const local = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!env.SMTP_INBOUND_USERNAME || !env.SMTP_INBOUND_PASSWORD || !env.SMTP_INBOUND_GATEWAY_ID) throw new Error("SMTP inbound auth and gateway id are required");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !["implicit", "starttls"].includes(mode)) throw new Error("Invalid SMTP inbound listener configuration");
  if (!local && (!env.SMTP_INBOUND_TLS_CERT || !env.SMTP_INBOUND_TLS_KEY)) throw new Error("Nonlocal SMTP inbound listeners require configured TLS certificates");
  const tls = env.SMTP_INBOUND_TLS_CERT ? {
    cert: await readFile(env.SMTP_INBOUND_TLS_CERT), key: await readFile(env.SMTP_INBOUND_TLS_KEY),
  } : {};
  const peers = trustedProxySet(env.SMTP_INBOUND_TRUSTED_PEERS);
  const configuredMaxBytes = Number(env.SMTP_INBOUND_MAX_BYTES);
  const maxBytes = Number.isInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : 25 * 1024 * 1024;
  const server = new SMTPServer({
    ...tls, secure: mode === "implicit", authOptional: false, size: maxBytes,
    socketTimeout: 60_000, closeTimeout: 30_000, hidePIPELINING: true,
    onConnect(session, callback) {
      const peer = normalizeIp(session.remoteAddress);
      if (peers.size && (!peer || !peers.has(peer))) return callback(Object.assign(new Error("Untrusted SMTP peer"), { responseCode: 554 }));
      callback();
    },
    onAuth(auth, _session, callback) {
      if (!equal(auth.username, env.SMTP_INBOUND_USERNAME) || !equal(auth.password, env.SMTP_INBOUND_PASSWORD)) {
        return callback(Object.assign(new Error("Authentication failed"), { responseCode: 535 }));
      }
      callback(null, { user: env.SMTP_INBOUND_GATEWAY_ID });
    },
    onMailFrom(address, session, callback) {
      if (mode === "starttls" && !session.secure) return callback(Object.assign(new Error("STARTTLS required"), { responseCode: 530 }));
      if (!ADDRESS.test(address.address)) return callback(Object.assign(new Error("Invalid sender"), { responseCode: 550 }));
      callback();
    },
    async onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length > 0) return callback(Object.assign(new Error("One recipient per transaction"), { responseCode: 452 }));
      if (!ADDRESS.test(address.address)) return callback(Object.assign(new Error("Invalid recipient"), { responseCode: 550 }));
      try {
        const response = await dispatch("smtp-recipient", { to: address.address });
        if (response.status >= 500) {
          return callback(Object.assign(new Error("Recipient lookup unavailable"), { responseCode: 451 }));
        }
        const result = await response.json();
        callback(response.ok && result.accepted ? undefined : Object.assign(new Error("Recipient rejected"), { responseCode: 550 }));
      } catch {
        callback(Object.assign(new Error("Recipient lookup unavailable"), { responseCode: 451 }));
      }
    },
    onData(stream, session, callback) {
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); });
      stream.on("error", callback);
      stream.on("end", async () => {
        try {
          if (stream.sizeExceeded || size > maxBytes) throw Object.assign(new Error("Message too large"), { responseCode: 552 });
          const parsed = parseGatewayMessage(Buffer.concat(chunks), env.SMTP_INBOUND_GATEWAY_ID);
          const response = await dispatch("smtp-ingest", {
            gateway: parsed.gateway, deliveryId: parsed.deliveryId,
            from: session.envelope.mailFrom.address, to: session.envelope.rcptTo[0].address,
            rawBase64: parsed.raw.toString("base64"), auth: parsed.auth,
          });
          if (!response.ok) throw Object.assign(new Error("Temporary processing failure"), { responseCode: response.status >= 500 ? 451 : 550 });
          callback(null, "Accepted for forwarding");
        } catch (error) { callback(error); }
      });
    },
  });
  return { server, host, port };
}
