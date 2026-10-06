import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import nodemailer from "nodemailer";
import { createGateway, gatewayMessage, gatewayRecipient, relayGatewayMessage } from "./gateway.mjs";
import { createSmtpIngress, parseGatewayMessage } from "./smtp-ingress.mjs";

test("gateway removes forged folded control headers and preserves binary MIME", () => {
  const raw = Buffer.concat([
    Buffer.from("From: sender@example.net\r\nX-HideMyEmail-Gateway-Result: v=1; id=forged\r\n spam=PASS\r\nx-hidemyemail-gateway-result: forged-again\r\nSubject: keep\r\n\r\n"),
    Buffer.from([0, 255, 13, 10, 128]),
  ]);
  const auth = { spf: "FAIL", dmarc: "GRAY", spam: "FAIL", virus: "PASS" };
  const result = gatewayMessage(raw, "durable-42", auth);
  const parsed = parseGatewayMessage(result, "gateway-1");
  assert.equal(parsed.deliveryId, "durable-42");
  assert.deepEqual(parsed.auth, auth);
  assert.deepEqual(parsed.raw, Buffer.concat([
    Buffer.from("From: sender@example.net\r\nSubject: keep\r\n\r\n"),
    Buffer.from([0, 255, 13, 10, 128]),
  ]));
  assert.throws(() => gatewayMessage(raw, "id", { ...auth, virus: "GRAY" }), /incomplete/i);
});

test("gateway recipient allowlist compares exact domains, not suffixes", () => {
  assert.equal(gatewayRecipient("shop@EXAMPLE.COM", ["example.com"]), true);
  assert.equal(gatewayRecipient("shop@example.com.attacker.net", ["example.com"]), false);
  assert.equal(gatewayRecipient("shop@other.net", ["example.com"]), false);
});

test("gateway relay preserves envelope and queue ID across retries and waits for scanners", async () => {
  const payload = { from: "sender@example.net", to: "alias@example.com", ip: "192.0.2.9", helo: "sender.example.net",
    rawBase64: Buffer.from("From: sender@example.net\r\n\r\nbody").toString("base64") };
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); if (sent.length === 1) throw { responseCode: 451 }; } };
  const options = { scan: async () => ({ spf: "FAIL", dmarc: "PASS", spam: "PASS", virus: "FAIL" }), transport };
  await assert.rejects(relayGatewayMessage(payload, "queue-123", options));
  await relayGatewayMessage(payload, "queue-123", options);
  assert.deepEqual(sent[1].envelope, { from: payload.from, to: [payload.to] });
  assert.equal(parseGatewayMessage(sent[0].raw, "gateway").deliveryId, "queue-123");
  assert.deepEqual(sent[0].raw, sent[1].raw);
  await assert.rejects(relayGatewayMessage(payload, "queue-123", { ...options, scan: async () => { throw new Error("scanner down"); } }));
  assert.equal(sent.length, 2);
  await assert.rejects(relayGatewayMessage(payload, "queue-123", { ...options, transport: { async sendMail() { throw { responseCode: 550 }; } } }), error => error.permanent === true);
  await assert.rejects(relayGatewayMessage(payload, "queue-123", { ...options, transport: { async sendMail() { throw { command: "DATA" }; } } }), error => error.uncertain === true);
});

test("public gateway queues, scans, and hands off through authenticated verified STARTTLS", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hme-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const deliveries = [];
  const receiver = await createSmtpIngress({ SMTP_INBOUND_ENABLED: "true", SMTP_INBOUND_TLS_CERT: cert,
    SMTP_INBOUND_TLS_KEY: key, SMTP_INBOUND_USERNAME: "gateway", SMTP_INBOUND_PASSWORD: "secret", SMTP_INBOUND_GATEWAY_ID: "reference-1" },
  async (path, body) => {
    if (path === "smtp-recipient") return Response.json({ accepted: true });
    deliveries.push(body); return Response.json({ ok: true });
  });
  await new Promise(resolve => receiver.server.listen(0, resolve));
  receiver.server.on("error", () => {}); // A deliberately failed TLS handshake is expected below.
  t.after(() => new Promise(resolve => receiver.server.close(resolve)));
  let scanning = true;
  const rspamd = http.createServer((request, response) => {
    request.resume(); response.writeHead(scanning ? 200 : 503);
    response.end(JSON.stringify({ score: 0, action: "no action" }));
  });
  await new Promise(resolve => rspamd.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => rspamd.close(resolve)));
  const clam = net.createServer(socket => { socket.on("data", () => {}); socket.on("end", () => socket.end("stream: OK\0")); });
  await new Promise(resolve => clam.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => clam.close(resolve)));
  let time = Date.now();
  t.mock.method(Date, "now", () => time);
  const env = { DATA_DIR: join(directory, "queue"), GATEWAY_QUEUE_KEY: Buffer.alloc(32, 17).toString("base64"),
    GATEWAY_DOMAINS: "aliases.invalid", GATEWAY_HOSTNAME: "mx.invalid", GATEWAY_RELAY_HOST: "localhost",
    GATEWAY_RELAY_PORT: String(receiver.server.server.address().port), GATEWAY_RELAY_CA: cert,
    GATEWAY_RELAY_USERNAME: "gateway", GATEWAY_RELAY_PASSWORD: "secret",
    RSPAMD_URL: `http://127.0.0.1:${rspamd.address().port}/checkv2`, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(clam.address().port) };
  const gateway = await createGateway(env);
  await new Promise(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => gateway.server.close(resolve)); await gateway.queue.stop(); gateway.closeTransport(); });
  const client = nodemailer.createTransport({ host: "127.0.0.1", port: gateway.server.server.address().port, ignoreTLS: true });
  t.after(() => client.close());
  const message = { envelope: { from: "sender@sender.invalid", to: ["alias@aliases.invalid"] },
    raw: Buffer.from("From: sender@sender.invalid\r\nX-HideMyEmail-Gateway-Result: forged\r\nSubject: test\r\n\r\nprivate body") };
  await assert.rejects(client.sendMail({ ...message, envelope: { ...message.envelope, from: "" } }), error => error.responseCode === 550);
  await assert.rejects(client.sendMail({ ...message, envelope: { ...message.envelope, to: ["alias@other.invalid"] } }), error => error.responseCode === 550);
  assert.equal((await gateway.queue.status()).inbound, 0);
  assert.deepEqual((await client.sendMail(message)).accepted, ["alias@aliases.invalid"]);
  const [filename] = await readdir(env.DATA_DIR);
  const id = filename.slice(0, -5);
  assert.ok(!(await readFile(join(env.DATA_DIR, filename))).includes(Buffer.from("private body")));
  scanning = false;
  await gateway.queue.drain();
  assert.equal(deliveries.length, 0);
  assert.equal((await gateway.queue.status()).inbound, 1);
  gateway.closeTransport();
  const restarted = await createGateway(env);
  t.after(() => restarted.closeTransport());
  scanning = true; time += 60001;
  await restarted.queue.drain();
  assert.equal((await restarted.queue.status()).inbound, 0);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliveryId, id);
  assert.equal(deliveries[0].auth.spam, "PASS");
  assert.equal(deliveries[0].auth.virus, "PASS");
  assert.doesNotMatch(Buffer.from(deliveries[0].rawBase64, "base64").toString(), /Gateway-Result/i);
  assert.match(Buffer.from(deliveries[0].rawBase64, "base64").toString(), /private body/);
  for (const override of [{ GATEWAY_RELAY_PASSWORD: "wrong" }, { GATEWAY_RELAY_HOST: "127.0.0.1" }]) {
    const invalid = await createGateway({ ...env, ...override });
    t.after(() => invalid.closeTransport());
    await invalid.queue.enqueue("inbound", { from: message.envelope.from, to: message.envelope.to[0], ip: "127.0.0.1", helo: "sender.invalid", rawBase64: message.raw.toString("base64") });
    await invalid.queue.drain();
    assert.equal(deliveries.length, 1, "bad credentials or certificate hostname must not reach the Worker");
  }
});
