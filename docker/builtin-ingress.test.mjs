import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { createBuiltinIngress } from "./builtin-ingress.mjs";

test("public listener rejects unknown recipients and durably queues accepted MIME", async t => {
  const queued = [];
  const dispatch = async path => path === "smtp-recipient" ? Response.json({ accepted: path && true }) : new Response("unexpected", { status: 500 });
  const queue = { enqueue: async (kind, payload) => { queued.push({ kind, payload }); return "id"; } };
  const { server } = await createBuiltinIngress({ MAIL_HOSTNAME: "mail.example.com", SMTP_INBOUND_MAX_BYTES: "1048576" }, dispatch, queue);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, ignoreTLS: true });
  t.after(() => client.close());
  const result = await client.sendMail({ envelope: { from: "sender@example.net", to: ["alias@example.com"] }, raw: Buffer.from("From: sender@example.net\r\n\r\nbody") });
  assert.deepEqual(result.accepted, ["alias@example.com"]);
  assert.equal(queued[0].kind, "inbound");
  assert.equal(queued[0].payload.to, "alias@example.com");
  assert.match(Buffer.from(queued[0].payload.rawBase64, "base64").toString(), /body/);
  assert.equal(server.options.authOptional, true);
  assert.ok(server.options.disabledCommands.includes("AUTH"));
});

test("queue failure returns a temporary SMTP error instead of accepting mail", async () => {
  const dispatch = async () => Response.json({ accepted: true });
  const queue = { enqueue: async () => { throw new Error("full"); } };
  const { server } = await createBuiltinIngress({ MAIL_HOSTNAME: "mail.example.com" }, dispatch, queue);
  const stream = new (await import("node:stream")).PassThrough();
  const outcome = new Promise(resolve => server.options.onData(stream, {
    remoteAddress: "203.0.113.1", hostNameAppearsAs: "sender.example",
    envelope: { mailFrom: { address: "sender@example.net" }, rcptTo: [{ address: "alias@example.com" }] },
  }, resolve));
  stream.end("From: sender@example.net\r\n\r\nbody");
  assert.equal((await outcome).responseCode, 451);
});

test("public listener accepts a null return path for delivery status messages", async () => {
  const queued = [];
  const queue = { enqueue: async (kind, payload) => { queued.push({ kind, payload }); return "id"; } };
  const { server } = await createBuiltinIngress({ MAIL_HOSTNAME: "mail.example.com" }, async () => Response.json({ accepted: true }), queue);
  const mailFromError = await new Promise(resolve => server.options.onMailFrom({ address: "" }, {}, resolve));
  assert.equal(mailFromError, undefined);

  const stream = new (await import("node:stream")).PassThrough();
  const outcome = new Promise(resolve => server.options.onData(stream, {
    remoteAddress: "203.0.113.1", hostNameAppearsAs: "sender.example",
    envelope: { mailFrom: { address: "" }, rcptTo: [{ address: "alias@example.com" }] },
  }, (error, message) => resolve({ error, message })));
  stream.end("From: Mail Delivery Subsystem <mailer-daemon@example.net>\r\n\r\nDelivery failed");
  assert.deepEqual(await outcome, { error: null, message: "Queued for processing" });
  assert.equal(queued[0].payload.from, "");
});
