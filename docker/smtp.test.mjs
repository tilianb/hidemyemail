import assert from "node:assert/strict";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { createSmtpTransportHandler, smtpTransportConfig } from "./smtp-transport.mjs";
import { createSmtpIngress, parseGatewayMessage } from "./smtp-ingress.mjs";

const ingressEnv = (overrides = {}) => ({
  SMTP_INBOUND_ENABLED: "true",
  SMTP_INBOUND_USERNAME: "gateway",
  SMTP_INBOUND_PASSWORD: "secret",
  SMTP_INBOUND_GATEWAY_ID: "gateway-1",
  ...overrides,
});

test("inbound message size uses the 25 MiB default for blank config and accepts an explicit limit", async () => {
  const blank = await createSmtpIngress(ingressEnv({ SMTP_INBOUND_MAX_BYTES: "" }), async () => Response.json({ accepted: true }));
  const explicit = await createSmtpIngress(ingressEnv({ SMTP_INBOUND_MAX_BYTES: "1048576" }), async () => Response.json({ accepted: true }));
  assert.equal(blank.server.options.size, 25 * 1024 * 1024);
  assert.equal(explicit.server.options.size, 1_048_576);
});

test("recipient lookup maps infrastructure failures to temporary SMTP rejection", async () => {
  const outcomes = [
    async () => { throw new Error("dispatch unavailable"); },
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("not json", { status: 200 }),
  ];
  for (const dispatch of outcomes) {
    const { server } = await createSmtpIngress(ingressEnv(), dispatch);
    const error = await new Promise((resolve) => {
      server.options.onRcptTo({ address: "alias@example.com" }, { envelope: { rcptTo: [] } }, resolve);
    });
    assert.equal(error.responseCode, 451);
  }
});

test("recipient lookup preserves permanent rejection for invalid recipients", async () => {
  const { server } = await createSmtpIngress(ingressEnv(), async () => Response.json({ accepted: false }));
  const error = await new Promise((resolve) => {
    server.options.onRcptTo({ address: "alias@example.com" }, { envelope: { rcptTo: [] } }, resolve);
  });
  assert.equal(error.responseCode, 550);
});

test("authenticated SMTP socket strips gateway metadata and does not acknowledge processing failures", async (t) => {
  const deliveries = [];
  let unavailable = false;
  const { server } = await createSmtpIngress(ingressEnv({ SMTP_INBOUND_MAX_BYTES: "" }), async (path, body) => {
    if (path === "smtp-recipient") return Response.json({ accepted: true });
    deliveries.push(body);
    return Response.json({ ok: !unavailable }, { status: unavailable ? 503 : 202 });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = nodemailer.createTransport({
    host: "127.0.0.1", port: server.server.address().port, requireTLS: true,
    auth: { user: "gateway", pass: "secret" },
    // Test-only loopback server uses smtp-server's self-signed fixture certificate.
    tls: { rejectUnauthorized: false },
  });
  t.after(() => client.close());
  const message = {
    envelope: { from: "sender@example.net", to: ["alias@example.com"] },
    raw: Buffer.from("From: sender@example.net\r\nX-HideMyEmail-Gateway-Result: v=1; id=queue-99; spf=PASS; dmarc=PASS; spam=PASS; virus=PASS\r\nSubject: gateway test\r\n\r\nnonempty body"),
  };
  assert.deepEqual((await client.sendMail(message)).accepted, ["alias@example.com"]);
  assert.equal(deliveries[0].deliveryId, "queue-99");
  assert.equal(deliveries[0].from, "sender@example.net");
  assert.doesNotMatch(Buffer.from(deliveries[0].rawBase64, "base64").toString(), /Gateway-Result/i);
  assert.match(Buffer.from(deliveries[0].rawBase64, "base64").toString(), /nonempty body/);
  unavailable = true;
  await assert.rejects(client.sendMail(message), error => error.responseCode === 451);
});

test("custom SMTP requires explicit TLS and verified certificates", () => {
  const starttls = smtpTransportConfig({ SMTP_OUTBOUND_HOST: "smtp.example", SMTP_OUTBOUND_PORT: "587" });
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.tls.rejectUnauthorized, true);
  assert.equal(starttls.opportunisticTLS, false);
  assert.throws(() => smtpTransportConfig({ SMTP_OUTBOUND_HOST: "smtp.example", SMTP_OUTBOUND_PORT: "587", SMTP_OUTBOUND_TLS: "trusted-cleartext" }), /port-25/);
});

test("outbound handler preserves raw MIME and explicit envelope", async () => {
  let sent;
  const handler = createSmtpTransportHandler({ SMTP_OUTBOUND_HOST: "smtp.example" }, () => ({
    async sendMail(message) { sent = message; return { messageId: "accepted-id" }; },
  }));
  const raw = Buffer.from("From: Alias <alias@example.com>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nattachment\r\n--x--");
  const response = await handler(new Request("http://smtp.internal/send", {
    method: "POST", body: JSON.stringify({ from: "Alias <alias@example.com>", to: "person@example.net", rawBase64: raw.toString("base64") }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(sent.envelope, { from: "alias@example.com", to: ["person@example.net"] });
  assert.deepEqual(sent.raw, raw);
});

test("outbound maps known rejection and uncertain DATA loss separately", async () => {
  const run = async (error) => createSmtpTransportHandler({ SMTP_OUTBOUND_HOST: "smtp.example" }, () => ({
    async sendMail() { throw error; },
  }))(new Request("http://smtp.internal/send", { method: "POST", body: JSON.stringify({ from: "a@example.com", to: "b@example.net", rawBase64: "eA==" }) }));
  assert.equal((await run({ responseCode: 550 })).status, 400);
  assert.equal((await run({ responseCode: 451 })).status, 421);
  assert.equal((await run({ command: "DATA" })).status, 504);
});

test("trusted gateway metadata is exact, validated, and stripped", () => {
  const raw = Buffer.from("From: sender@example.com\r\nX-HideMyEmail-Gateway-Result: v=1; id=queue-42; spf=PASS; dmarc=FAIL; spam=PASS; virus=PASS\r\nSubject: hello\r\n\r\nbody");
  const parsed = parseGatewayMessage(raw, "stalwart-1");
  assert.equal(parsed.deliveryId, "queue-42");
  assert.deepEqual(parsed.auth, { spf: "PASS", dmarc: "FAIL", spam: "PASS", virus: "PASS" });
  assert.doesNotMatch(parsed.raw.toString(), /Gateway-Result/i);
  assert.match(parsed.raw.toString(), /Subject: hello\r\n\r\nbody/);
  assert.throws(() => parseGatewayMessage(Buffer.from("From: a@b\r\n\r\nx"), "mta"), /Exactly one/);
  assert.throws(() => parseGatewayMessage(Buffer.from("X-HideMyEmail-Gateway-Result: v=1; id=x; spf=PASS\r\nX-HideMyEmail-Gateway-Result: v=1; id=y; spf=PASS\r\n\r\nx"), "mta"), /Exactly one/);
  assert.throws(() => parseGatewayMessage(Buffer.from("X-HideMyEmail-Gateway-Result: v=1; id=x; spf=PASS; dmarc=PASS; spam=PASS\r\n\r\nx"), "mta"), /fields/);
});

test("actual SMTP socket refuses mail when STARTTLS is unavailable", async (t) => {
  const server = new SMTPServer({ disabledCommands: ["STARTTLS", "AUTH"], authOptional: true, onData(stream, _session, callback) { stream.resume(); callback(); } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.server.address().port;
  const handler = createSmtpTransportHandler({ SMTP_OUTBOUND_HOST: "127.0.0.1", SMTP_OUTBOUND_PORT: String(port), SMTP_OUTBOUND_TLS: "starttls" });
  const response = await handler(new Request("http://smtp.internal/send", { method: "POST", body: JSON.stringify({ from: "a@example.com", to: "b@example.net", rawBase64: "RnJvbTogYUBleGFtcGxlLmNvbQ0KDQpib2R5" }) }));
  assert.equal(response.status, 421);
});
