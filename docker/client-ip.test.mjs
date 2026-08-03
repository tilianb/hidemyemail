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

test("dev publishes multi-arch GHCR dev and SHA tags while latest tracks stable releases", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/docker.yml", import.meta.url),
    "utf8",
  );
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  merge:"));
  const merge = workflow.slice(workflow.indexOf("  merge:"));
  const step = (block, name) => {
    const start = block.indexOf(`      - name: ${name}`);
    const next = block.indexOf("\n      - name:", start + 1);
    return block.slice(start, next === -1 ? undefined : next);
  };

  assert.match(workflow, /branches: \['main', 'dev'\]/);
  assert.match(workflow, /refs\/heads\/(?:main|dev)/);
  assert.match(build, /fromJSON\('\[\{"platform":"linux\/amd64"\},\{"platform":"linux\/arm64"\}\]'\)/);
  assert.match(build, /environment:.*refs\/heads\/main.*stable-release == 'true'.*production/);
  assert.match(step(build, "Log in to GHCR"), /if: github\.event_name != 'pull_request'/);
  assert.match(step(build, "Build for validation"), /if: github\.event_name == 'pull_request'/);
  assert.match(step(build, "Build and push by digest"), /if: github\.event_name != 'pull_request'/);
  assert.match(step(build, "Build and push by digest"), /type=image,name=\$\{\{ env\.GHCR_IMAGE \}\}/);
  assert.match(step(build, "Build and push by digest"), /stable-release == 'true'.*env\.DOCKERHUB_IMAGE/);
  assert.match(step(build, "Log in to Docker Hub"), /if: needs\.publish-gate\.outputs\.stable-release == 'true'/);
  assert.match(step(build, "Export digest"), /if: github\.event_name != 'pull_request'/);
  assert.match(step(build, "Upload digest"), /if: github\.event_name != 'pull_request'/);
  assert.match(merge, /if: github\.event_name != 'pull_request'/);
  assert.match(merge, /environment:.*refs\/heads\/main.*stable-release == 'true'.*production/);
  assert.match(merge, /type=ref,event=branch/);
  assert.match(merge, /type=sha,format=short,prefix=sha-/);
  assert.match(merge, /type=raw,value=latest,enable=\$\{\{ needs\.publish-gate\.outputs\.stable-release == 'true' \}\}/);
  assert.doesNotMatch(merge, /type=raw,value=latest,enable=.*refs\/heads\/main/);
  assert.doesNotMatch(merge, /type=raw,value=latest,enable=.*dev/);
  for (const name of [
    "Log in to Docker Hub",
    "Extract Docker Hub metadata",
    "Create Docker Hub manifest list and push",
    "Inspect Docker Hub image",
  ]) {
    assert.match(step(merge, name), /if: needs\.publish-gate\.outputs\.stable-release == 'true'/);
  }
});

test("dev sync only accepts the repository's own dev branch", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/sync-dev.yml", import.meta.url),
    "utf8",
  );
  const syncJob = workflow.slice(workflow.indexOf("  sync-dev:"));
  assert.match(
    syncJob,
    /if: >-\n\s+github\.event\.pull_request\.merged == true &&\n\s+github\.event\.pull_request\.head\.ref == 'dev' &&\n\s+github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
});

test("Namespace is reserved for right-sized native, Java CodeQL, and Docker builds", async () => {
  const workflowNames = [
    "android",
    "ci",
    "codeql",
    "docker",
    "docs",
    "ios",
    "release",
    "sync-dev",
    "testflight",
  ];
  const workflows = Object.fromEntries(await Promise.all(workflowNames.map(async (name) => [
    name,
    await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  ])));

  const javaCodeql = workflows.codeql.slice(
    workflows.codeql.indexOf("          - language: java-kotlin"),
    workflows.codeql.indexOf("    steps:"),
  );
  const javascriptCodeql = workflows.codeql.slice(
    workflows.codeql.indexOf("          - language: javascript-typescript"),
    workflows.codeql.indexOf("          - language: java-kotlin"),
  );
  const dockerBuild = workflows.docker.slice(
    workflows.docker.indexOf("  build:"),
    workflows.docker.indexOf("  merge:"),
  );
  const dockerMerge = workflows.docker.slice(workflows.docker.indexOf("  merge:"));
  const releaseAndroid = workflows.release.slice(
    workflows.release.indexOf("  android:"),
    workflows.release.indexOf("  extension:"),
  );

  assert.match(workflows.android, /runs-on: namespace-profile-github-4x8/);
  assert.match(javaCodeql, /runner: namespace-profile-github-4x8/);
  assert.match(javascriptCodeql, /runner: ubuntu-latest/);
  assert.match(dockerBuild, /runs-on: namespace-profile-default/);
  assert.doesNotMatch(dockerBuild, /docker\/setup-buildx-action|cache-(?:from|to): type=gha/);
  assert.match(dockerMerge, /runs-on: ubuntu-latest/);
  assert.match(dockerMerge, /docker\/setup-buildx-action/);
  assert.match(workflows.ios, /runs-on: namespace-profile-github-macos/);
  assert.match(releaseAndroid, /runs-on: namespace-profile-github-4x8/);
  assert.match(workflows.testflight, /runs-on: namespace-profile-github-macos/);

  for (const [name, workflow] of Object.entries(workflows)) {
    assert.doesNotMatch(workflow, /namespacelabs\/nscloud-cache-action/, `${name} uses paid Namespace caching`);
    const expectedNamespaceJobs = ["android", "codeql", "docker", "ios", "release", "testflight"].includes(name) ? 1 : 0;
    assert.equal(
      workflow.match(/namespace-profile-/g)?.length ?? 0,
      expectedNamespaceJobs,
      `${name} has an unexpected number of Namespace jobs`,
    );
  }
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
