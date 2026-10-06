import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { scanMail } from "./mail-scanner.mjs";

const raw = Buffer.from("From: sender@example.net\r\nSubject: test\r\n\r\nbody");
const session = { ip: "203.0.113.10", helo: "sender.example.net", from: "sender@example.net", to: "alias@example.com" };

test("maps sender authentication and explicit clean scanner results", async () => {
  const auth = async () => ({ spf: { status: { result: "pass" } }, dmarc: { status: { result: "fail" } } });
  const fetch = async (_url, init) => {
    assert.equal(init.headers.IP, session.ip);
    return Response.json({ action: "no action", score: 1.2, is_skipped: false });
  };
  const clam = async () => "stream: OK";
  assert.deepEqual(await scanMail(raw, session, { authenticate: auth, fetch, clam }), {
    spf: "PASS", dmarc: "FAIL", spam: "PASS", virus: "PASS",
  });
});

test("fails closed when scanners skip, error, or return unknown data", async () => {
  const authenticate = async () => ({ spf: { status: { result: "temperror" } }, dmarc: false });
  for (const response of [
    Response.json({ action: "no action", score: 0, is_skipped: true }),
    new Response("bad", { status: 503 }),
    Response.json({ action: "mystery", score: 0 }),
  ]) {
    await assert.rejects(scanMail(raw, session, { authenticate, fetch: async () => response, clam: async () => "stream: OK" }));
  }
  await assert.rejects(scanMail(raw, session, {
    authenticate, fetch: async () => Response.json({ action: "no action", score: 0 }), clam: async () => "stream: ERROR",
  }));
});

test("maps spam, malware, and gray authentication verdicts", async () => {
  const result = await scanMail(raw, session, {
    authenticate: async () => ({ spf: { status: { result: "softfail" } }, dmarc: { status: { result: "none" } } }),
    fetch: async () => Response.json({ action: "add header", score: 8, is_skipped: false }),
    clam: async () => "stream: Eicar-Signature FOUND",
  });
  assert.deepEqual(result, { spf: "GRAY", dmarc: "GRAY", spam: "FAIL", virus: "FAIL" });
});

test("ClamAV client uses bounded INSTREAM framing", async t => {
  const chunks = [];
  const server = net.createServer(socket => {
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => socket.end("stream: OK\0"));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { clamScan } = await import("./mail-scanner.mjs");
  assert.equal(await clamScan(raw, { host: "127.0.0.1", port: server.address().port, timeout: 1000 }), "stream: OK");
  const sent = Buffer.concat(chunks);
  assert.equal(sent.subarray(0, 10).toString(), "zINSTREAM\0");
  assert.equal(sent.readUInt32BE(10), raw.length);
  assert.deepEqual(sent.subarray(14, 14 + raw.length), raw);
  assert.equal(sent.readUInt32BE(sent.length - 4), 0);
});
