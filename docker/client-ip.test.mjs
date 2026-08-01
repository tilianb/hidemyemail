import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeIp, trustedProxySet, workerHeaders } from "./client-ip.mjs";

function startServerWithKey(key) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
      env: {
        ...process.env,
        SESSION_SECRET: "session-secret",
        AUTH_PASSWORD_HASH: "password-hash",
        AUTH_PASSWORD_SALT: "password-salt",
        DESTINATION_ENCRYPTION_KEY: key,
        SES_ACCESS_KEY_ID: "access-key",
        SES_SECRET_ACCESS_KEY: "secret-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Docker server did not exit within 5 seconds"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });
  });
}

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

test("Docker refuses malformed encryption keys before listening without logging them", async () => {
  for (const key of [
    "not-base64!",
    "YQ==",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", // 31 bytes
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 33 bytes
    `${"A".repeat(43)}=junk`,
  ]) {
    const result = await startServerWithKey(key);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid encryption key configuration/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stdout, /Listening on/);
  }
});

test("release is the only direct tag publisher", async () => {
  const [docker, release, testflight] = await Promise.all(
    ["docker", "release", "testflight"].map((name) =>
      readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")),
  );
  assert.match(release, /push:\n\s+tags:\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(docker, /tags:\s*\[?"v\*\.\*\.\*"/);
  const versionTagTrigger = /tags:\s*(?:\[\s*)?(?:-\s*)?(["'])v\*\.\*\.\*\1/;
  assert.match('tags: ["v*.*.*"]', versionTagTrigger);
  assert.match('tags:\n      - "v*.*.*"', versionTagTrigger);
  assert.doesNotMatch(testflight, versionTagTrigger);
  assert.match(docker, /workflow_call:/);
  assert.match(testflight, /workflow_call:/);
});

test("release publications depend on the validated tag and required artifacts", async () => {
  const [release, docker, testflight] = await Promise.all(
    ["release", "docker", "testflight"].map((name) =>
      readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")),
  );
  assert.match(release, /node worker\/scripts\/validate-release\.mjs/);
  for (const job of ["android", "testflight", "containers"]) {
    const block = release.slice(release.indexOf(`  ${job}:`));
    assert.match(block.split(/\n  [a-z-]+:/, 1)[0], /needs: validate/);
  }
  const releaseJob = release.slice(release.indexOf("  release:"));
  assert.match(releaseJob, /needs: \[validate, android, extension, testflight, containers\]/);
  assert.doesNotMatch(releaseJob, /--clobber/);
  const upload = releaseJob.indexOf("gh release upload");
  const cleanup = releaseJob.indexOf("gh release delete-asset");
  const edit = releaseJob.indexOf("gh release edit");
  assert.ok(upload !== -1 && cleanup > upload && edit > cleanup);
  assert.match(releaseJob, /grep -Fxq "\$asset_name"/);
  assert.match(releaseJob, /grep -Fvx "\$asset_name"/);
  assert.match(releaseJob, /refs\/tags\/\$GITHUB_REF_NAME/);
  assert.match(releaseJob, /remote_tag_commit.*GITHUB_SHA/);
  assert.match(release, /name: release-apk-\$\{\{ github\.run_id \}\}-android/);
  assert.doesNotMatch(release, /release-apk[^\n]*run_attempt/);
  assert.match(release, /overwrite: true/);
  assert.match(docker, /name: digests-\$\{\{ github\.run_id \}\}-\$\{\{ strategy\.job-index \}\}/);
  assert.match(docker, /pattern: digests-\$\{\{ github\.run_id \}\}-\*/);
  assert.match(docker, /overwrite: true/);
  assert.match(testflight, /BUILD_NUMBER="\$\{GITHUB_RUN_ID\}\.\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(testflight, /\^\[1-9\]\[0-9\]\*\\\.\[1-9\]\[0-9\]\*\$/);
});

test("reusable release workflows expose and receive only explicit secrets", async () => {
  const [docker, release, testflight] = await Promise.all(
    ["docker", "release", "testflight"].map((name) =>
      readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")),
  );
  assert.doesNotMatch(release, /secrets: inherit/);
  for (const secret of ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"]) {
    assert.match(docker, new RegExp(`${secret}:\\n\\s+required: true`));
    assert.match(release, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`));
  }
  for (const secret of [
    "BUILD_CERTIFICATE_BASE64",
    "P12_PASSWORD",
    "BUILD_PROVISION_PROFILE_BASE64",
    "APP_STORE_CONNECT_API_PRIVATE_KEY",
    "APP_STORE_CONNECT_API_KEY_ID",
    "APP_STORE_CONNECT_API_ISSUER_ID",
  ]) {
    assert.match(testflight, new RegExp(`${secret}:\\n\\s+required: true`));
    assert.match(release, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`));
  }
});
