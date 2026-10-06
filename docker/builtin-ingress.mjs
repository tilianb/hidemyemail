import { SMTPServer } from "smtp-server";
import { normalizeIp } from "./client-ip.mjs";

const ADDRESS = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+$/;

export async function createBuiltinIngress(env, dispatch, queue) {
  const max = Number(env.SMTP_INBOUND_MAX_BYTES);
  const maxBytes = Number.isInteger(max) && max > 0 ? max : 25 * 1024 * 1024;
  const server = new SMTPServer({
    name: env.MAIL_HOSTNAME,
    secure: false,
    authOptional: true,
    disabledCommands: env.SMTP_INBOUND_TLS_CERT ? ["AUTH"] : ["AUTH", "STARTTLS"],
    ...(env.SMTP_INBOUND_TLS_CERT ? {
      cert: env.SMTP_INBOUND_TLS_CERT_CONTENT,
      key: env.SMTP_INBOUND_TLS_KEY_CONTENT,
    } : {}),
    size: maxBytes,
    maxClients: 100,
    socketTimeout: 60_000,
    closeTimeout: 30_000,
    hidePIPELINING: true,
    disableReverseLookup: true,
    onMailFrom(address, _session, callback) {
      // RFC 5321 delivery status notifications use an empty return path (`MAIL FROM:<>`).
      if (address.address && !ADDRESS.test(address.address)) return callback(Object.assign(new Error("Invalid sender"), { responseCode: 550 }));
      callback();
    },
    async onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length > 0) return callback(Object.assign(new Error("One recipient per transaction"), { responseCode: 452 }));
      if (!ADDRESS.test(address.address)) return callback(Object.assign(new Error("Invalid recipient"), { responseCode: 550 }));
      try {
        const response = await dispatch("smtp-recipient", { to: address.address });
        if (response.status >= 500) throw new Error();
        const result = await response.json();
        callback(response.ok && result.accepted ? undefined : Object.assign(new Error("Recipient rejected"), { responseCode: 550 }));
      } catch { callback(Object.assign(new Error("Recipient lookup unavailable"), { responseCode: 451 })); }
    },
    onData(stream, session, callback) {
      const chunks = [];
      let size = 0;
      stream.on("data", chunk => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); });
      stream.once("error", callback);
      stream.once("end", async () => {
        try {
          if (stream.sizeExceeded || size > maxBytes) throw Object.assign(new Error("Message too large"), { responseCode: 552 });
          const from = session.envelope.mailFrom.address;
          const to = session.envelope.rcptTo[0]?.address;
          if (!to) throw Object.assign(new Error("Missing recipient"), { responseCode: 550 });
          await queue.enqueue("inbound", {
            ip: normalizeIp(session.remoteAddress) || session.remoteAddress,
            helo: session.hostNameAppearsAs || "unknown",
            from: from.toLowerCase(), to: to.toLowerCase(),
            rawBase64: Buffer.concat(chunks).toString("base64"),
          });
          callback(null, "Queued for processing");
        } catch (error) {
          callback(error?.responseCode ? error : Object.assign(new Error("Temporary queue failure"), { responseCode: 451 }));
        }
      });
    },
  });
  return { server, host: env.SMTP_INBOUND_HOST || "0.0.0.0", port: Number(env.SMTP_INBOUND_PORT || 2525) };
}
