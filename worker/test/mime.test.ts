import { expect, test } from "vitest";
import { parseMime, serializeMime, setHeader, removeHeaders } from "../src/lib/mime";
import { toBase64, fromBase64, utf8 } from "../src/lib/bytes";

const RAW = utf8(
  "From: Alice <alice@store.com>\r\n" +
  "To: shop@hidemyemail.dev\r\n" +
  "Subject: Hi\r\n" +
  "DKIM-Signature: v=1; a=rsa-sha256; stuff\r\n" +
  "\r\n" +
  "body line 1\r\nbody line 2\r\n"
);

test("parse splits headers and body; body preserved", () => {
  const m = parseMime(RAW);
  expect(m.headers.find((h) => h.name.toLowerCase() === "subject")?.value).toBe("Hi");
  expect(new TextDecoder().decode(m.body)).toBe("body line 1\r\nbody line 2\r\n");
});

test("setHeader replaces existing, appends new; removeHeaders drops", () => {
  let m = parseMime(RAW);
  m = setHeader(m, "From", '"Alice via shop" <r.tok@hidemyemail.dev>');
  m = setHeader(m, "Reply-To", "r.tok@hidemyemail.dev");
  m = removeHeaders(m, ["DKIM-Signature"]);
  const out = new TextDecoder().decode(serializeMime(m));
  expect(out).toContain('From: "Alice via shop" <r.tok@hidemyemail.dev>');
  expect(out).toContain("Reply-To: r.tok@hidemyemail.dev");
  expect(out).not.toContain("DKIM-Signature");
  expect(out).toContain("body line 1");
});

test("setHeader rejects header injection", () => {
  const m = parseMime(RAW);
  expect(() => setHeader(m, "X-Test", "ok\r\nBcc: attacker@example.com")).toThrow("Invalid header value");
  expect(() => setHeader(m, "X-Test\nInjected", "ok")).toThrow("Invalid header name");
});

test("base64 round-trip on binary", () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
  expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
});
