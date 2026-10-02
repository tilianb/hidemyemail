import nodemailer from "nodemailer";

const ADDRESS = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+$/;

function envelopeFrom(value) {
  const match = value.match(/<([^<>]+)>\s*$/);
  const address = (match?.[1] ?? value).trim();
  if (!ADDRESS.test(address)) throw Object.assign(new Error("Invalid envelope sender"), { responseCode: 550 });
  return address;
}

export function smtpTransportConfig(env) {
  const host = env.SMTP_OUTBOUND_HOST;
  const port = Number(env.SMTP_OUTBOUND_PORT ?? 587);
  const mode = env.SMTP_OUTBOUND_TLS ?? "starttls";
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP outbound host or port");
  if (!["implicit", "starttls", "trusted-cleartext"].includes(mode)) throw new Error("Invalid SMTP_OUTBOUND_TLS");
  if (mode === "trusted-cleartext" && port !== 25) throw new Error("trusted-cleartext is restricted to an explicitly configured port-25 relay");
  const user = env.SMTP_OUTBOUND_USERNAME;
  const pass = env.SMTP_OUTBOUND_PASSWORD;
  if (!!user !== !!pass) throw new Error("SMTP outbound username and password must be configured together");
  return {
    host, port, secure: mode === "implicit", requireTLS: mode === "starttls",
    ignoreTLS: mode === "trusted-cleartext", opportunisticTLS: false,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized: true, servername: env.SMTP_OUTBOUND_TLS_SERVERNAME || host },
    connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 240_000,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
  };
}

export function createSmtpTransportHandler(env, createTransport = nodemailer.createTransport) {
  const transport = createTransport(smtpTransportConfig(env));
  return async (request) => {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let message;
    try { message = await request.json(); } catch { return new Response("Invalid request", { status: 400 }); }
    if (!message || typeof message.from !== "string" || typeof message.to !== "string"
      || !ADDRESS.test(message.to) || typeof message.rawBase64 !== "string") {
      return new Response("Invalid message", { status: 400 });
    }
    try {
      const info = await transport.sendMail({
        envelope: { from: envelopeFrom(message.from), to: [message.to] },
        raw: Buffer.from(message.rawBase64, "base64"),
      });
      return Response.json({ providerId: info.messageId || undefined }, { status: 202 });
    } catch (error) {
      const code = Number(error?.responseCode ?? 0);
      if (smtpTransportConfig(env).requireTLS && (error?.code === "ETLS" || error?.command === "STARTTLS")) {
        return new Response("SMTP TLS required", { status: 421 });
      }
      if (code >= 500) return new Response("SMTP permanently rejected message", { status: 400 });
      if (code >= 400) return new Response("SMTP temporarily rejected message", { status: 421 });
      if (error?.command === "DATA") return new Response("SMTP acceptance is uncertain", { status: 504 });
      return new Response("SMTP transport unavailable", { status: 421 });
    }
  };
}
