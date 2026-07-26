import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeIp, trustedProxySet, workerHeaders } from "./client-ip.mjs";

test("canonicalizes IPv4-mapped and equivalent IPv6 addresses", () => {
  assert.equal(normalizeIp("::FFFF:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
});

test("rejects invalid and multi-value addresses", () => {
  for (const value of [undefined, "", "not-an-ip", "127.0.0.1, 10.0.0.1"]) {
    assert.equal(normalizeIp(value), null);
  }
});

test("direct clients cannot spoof forwarding headers", () => {
  const headers = workerHeaders(new Headers({
    "CF-Connecting-IP": "203.0.113.9",
    "Forwarded": "for=203.0.113.9",
    "X-Forwarded-For": "203.0.113.9",
    "X-HideMyEmail-Client-IP": "203.0.113.9",
  }), "198.51.100.7", trustedProxySet());

  assert.equal(headers.get("x-hidemyemail-client-ip"), "198.51.100.7");
  assert.equal(headers.has("forwarded"), false);
  assert.equal(headers.has("x-forwarded-for"), false);
  assert.equal(headers.has("cf-connecting-ip"), false);
});

test("only an explicitly trusted socket peer may supply the client IP", () => {
  const trusted = trustedProxySet("127.0.0.1, ::1");
  const headers = workerHeaders(
    new Headers({ "X-HideMyEmail-Client-IP": "203.0.113.11" }),
    "::ffff:127.0.0.1",
    trusted,
  );
  assert.equal(headers.get("x-hidemyemail-client-ip"), "203.0.113.11");
});

test("matches trusted proxies across equivalent IPv6 forms", () => {
  const headers = workerHeaders(
    new Headers({ "X-HideMyEmail-Client-IP": "2001:0DB8:0:0:0:0:0:2" }),
    "2001:0DB8:0:0:0:0:0:1",
    trustedProxySet("2001:db8::1"),
  );
  assert.equal(headers.get("x-hidemyemail-client-ip"), "2001:db8::2");
});

test("trusted proxies must overwrite rather than append the client header", () => {
  assert.throws(
    () => workerHeaders(
      new Headers({ "X-HideMyEmail-Client-IP": "203.0.113.11, 198.51.100.2" }),
      "127.0.0.1",
      trustedProxySet("127.0.0.1"),
    ),
    /one valid/,
  );
});

test("Docker runtime copies every local server module import", async () => {
  const [dockerfile, server] = await Promise.all([
    readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
  ]);
  const localImports = [...server.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((match) => match[1]);
  for (const importedFile of localImports) {
    assert.match(dockerfile, new RegExp(`COPY[^\\n]*docker/${importedFile.replaceAll(".", "\\.")}`));
  }
});

test("Docker runtime binds the configured canonical app origin", async () => {
  const server = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /APP_ORIGIN:\s*env\.APP_ORIGIN/);
});

test("publishing workflows gate secrets behind exact stable SemVer", async () => {
  for (const name of ["docker", "release", "testflight"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);

    const pattern = workflow.match(/\[\[ "\$tag" =~ (\S+) \]\]/)?.[1];
    assert.ok(pattern, `${name} publish gate regex must be inspectable`);
    const stableSemVer = new RegExp(pattern);
    for (const tag of ["v0.0.0", "v1.2.3"]) {
      assert.equal(stableSemVer.test(tag), true, `${name} should accept ${tag}`);
    }
    for (const tag of ["v01.2.3", "v1.02.3", "v1.2.03", "v1x2x3", "v1.2", "v1.2.3-malicious", "v1.2.3-rc1", "v1.2.3+build", "vv1.2.3"]) {
      assert.equal(stableSemVer.test(tag), false, `${name} should reject ${tag}`);
    }
  }
});

test("release secret-bearing jobs depend on successful publish gates", async () => {
  for (const [name, job] of [["release", "release"], ["testflight", "testflight"]]) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const jobBlock = workflow.slice(workflow.indexOf(`  ${job}:`));
    assert.match(jobBlock, /needs: publish-gate/);
    assert.match(jobBlock, /if: needs\.publish-gate\.result == 'success' && needs\.publish-gate\.outputs\.stable-release == 'true'/);
  }
});
