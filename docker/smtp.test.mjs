import assert from "node:assert/strict";
import test from "node:test";
import { SMTPServer } from "smtp-server";
import { createSmtpTransportHandler, smtpTransportConfig } from "./smtp-transport.mjs";
import { parseGatewayMessage } from "./smtp-ingress.mjs";

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
