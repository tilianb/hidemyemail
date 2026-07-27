import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// These tests exercise the GitHub Actions workflow / dependabot configuration
// files as plain text, mirroring the pattern already used in
// docker/client-ip.test.mjs for asserting release-pipeline invariants that
// have no other executable surface to unit test directly.

async function readWorkflow(name) {
  return readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
}

test("dependabot tracks npm updates for the extension directory alongside existing ecosystems", async () => {
  const dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  const npmBlock = dependabot.slice(
    dependabot.indexOf('package-ecosystem: "npm"'),
    dependabot.indexOf("schedule:"),
  );
  for (const directory of ["/worker", "/dashboard", "/docker", "/extension"]) {
    assert.match(npmBlock, new RegExp(`- "${directory.replace("/", "\\/")}"`));
  }
  assert.match(dependabot, /target-branch: "dev"/);
});

test("CI triggers on extension changes and runs an extension-checks job", async () => {
  const ci = await readWorkflow("ci");
  const triggers = ci.slice(0, ci.indexOf("permissions:"));
  const pathBlocks = [...triggers.matchAll(/paths:\n((?:\s+-[^\n]+\n)+)/g)];
  assert.equal(pathBlocks.length, 2, "push and pull_request should each declare paths");
  for (const [, block] of pathBlocks) {
    assert.match(block, /'extension\/\*\*'/);
  }

  const jobBlock = ci.slice(ci.indexOf("  extension-checks:"));
  assert.match(jobBlock, /working-directory: extension/);
  assert.match(jobBlock, /actions\/checkout@/);
  assert.match(jobBlock, /actions\/setup-node@/);
  assert.match(jobBlock, /node-version: 22/);
  assert.match(jobBlock, /cache-dependency-path: extension\/package-lock\.json/);

  const ciOrder = ["npm ci", "npm test", "npm run build"].map((step) => jobBlock.indexOf(`run: ${step}`));
  assert.ok(ciOrder.every((index) => index !== -1), "extension-checks must install, test, then build");
  assert.ok(ciOrder[0] < ciOrder[1] && ciOrder[1] < ciOrder[2], "steps must run in install -> test -> build order");
});

test("Docker workflow tests the host image before building it", async () => {
  const docker = await readWorkflow("docker");
  const testsJob = docker.slice(docker.indexOf("  tests:"), docker.indexOf("  build:"));
  assert.match(testsJob, /working-directory: docker/);
  assert.match(testsJob, /run: npm ci/);
  assert.match(testsJob, /run: npm test/);

  const buildJob = docker.slice(docker.indexOf("  build:"));
  assert.match(buildJob, /needs: \[publish-gate, tests\]/);
});

test("release packages a Chromium extension constrained to a minimal host-permission surface", async () => {
  const release = await readWorkflow("release");
  const extensionJob = release.slice(release.indexOf("  extension:"), release.indexOf("  testflight:"));

  assert.match(extensionJob, /needs: validate/);
  assert.match(extensionJob, /npm ci && npm test && npm run zip/);
  assert.match(extensionJob, /grep -Eq '\^manifest\\\.json\$'/);
  assert.match(extensionJob, /grep -Eq '\^popup\\\.html\$'/);
  assert.match(extensionJob, /\(src\|test\|tests\|node_modules\)\//);
  assert.match(extensionJob, /\\\.map\$/);

  const allowedHostPermissions = extensionJob.match(/const allowed = (\[.+\])/)?.[1];
  assert.ok(allowedHostPermissions, "manifest verification must define the allowed host-permission list");
  assert.deepEqual(
    JSON.parse(allowedHostPermissions.replace(/'/g, '"')),
    ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"],
  );
  assert.match(extensionJob, /manifest\.manifest_version !== 3/);
  assert.match(extensionJob, /manifest\.content_scripts \|\| manifest\.web_accessible_resources \|\| manifest\.host_permissions/);
  assert.match(extensionJob, /grep -Eqi 'https\?:\/\/'/);

  assert.match(extensionJob, /name: release-extension-\$\{\{ github\.run_id \}\}-chromium/);
  assert.match(extensionJob, /path: HideMyEmail-\$\{\{ github\.ref_name \}\}-chromium\.zip/);
  assert.match(extensionJob, /if-no-files-found: error/);
  assert.match(extensionJob, /retention-days: 7/);
  assert.match(extensionJob, /overwrite: true/);
});

test("release stages one versioned Android APK per run before uploading it", async () => {
  const release = await readWorkflow("release");
  const androidJob = release.slice(release.indexOf("  android:"), release.indexOf("  extension:"));

  assert.match(androidJob, /needs: validate/);
  assert.match(androidJob, /cp android\/app\/build\/outputs\/apk\/release\/app-release\.apk "HideMyEmail-\$\{GITHUB_REF_NAME\}\.apk"/);
  assert.match(androidJob, /name: release-apk-\$\{\{ github\.run_id \}\}-android/);
  assert.match(androidJob, /path: HideMyEmail-\$\{\{ github\.ref_name \}\}\.apk/);
  assert.match(androidJob, /if-no-files-found: error/);
  assert.match(androidJob, /retention-days: 7/);
  assert.match(androidJob, /overwrite: true/);
});

test("release publishing prunes obsolete APK and extension assets independently", async () => {
  const release = await readWorkflow("release");
  const releaseJob = release.slice(release.indexOf("  release:"));

  assert.match(releaseJob, /needs: \[validate, android, extension, testflight, containers\]/);
  assert.match(releaseJob, /name: release-apk-\$\{\{ github\.run_id \}\}-android/);
  assert.match(releaseJob, /name: release-extension-\$\{\{ github\.run_id \}\}-chromium/);

  // Obsolete-asset pruning must scope its regex to each asset kind so an APK
  // cleanup pass can never delete a chromium zip asset (and vice versa).
  const apkPattern = releaseJob.match(/grep -E '(\^HideMyEmail-v\[\^\/\]\+\\\.apk\$[^']+)'/)?.[1];
  const extensionPattern = releaseJob.match(/grep -E '(\^HideMyEmail-v\[\^\/\]\+-chromium\\\.zip\$[^']+)'/)?.[1];
  assert.ok(apkPattern, "APK obsolete-asset regex must be present");
  assert.ok(extensionPattern, "extension obsolete-asset regex must be present");
  assert.doesNotMatch(apkPattern, /chromium/);
  assert.match(extensionPattern, /chromium/);

  assert.match(releaseJob, /grep -Fxq "\$extension_name"/);
  assert.match(releaseJob, /grep -Fvx "\$extension_name"/);
  assert.doesNotMatch(releaseJob, /--clobber/);
});

test("TestFlight rejects a non-monotonic build number before archiving", async () => {
  const testflight = await readWorkflow("testflight");
  const buildNumberPattern = testflight.match(/\[\[ "\$BUILD_NUMBER" =~ (\S+) \]\]/)?.[1];
  assert.ok(buildNumberPattern, "TestFlight build-number guard regex must be inspectable");
  const monotonicBuildNumber = new RegExp(buildNumberPattern);

  for (const value of ["1.1", "12.34", "1.100"]) {
    assert.equal(monotonicBuildNumber.test(value), true, `expected ${value} to be accepted`);
  }
  for (const value of ["0.1", "1.0", "01.1", "1.01", "1", "1.1.1", "-1.1", "a.1"]) {
    assert.equal(monotonicBuildNumber.test(value), false, `expected ${value} to be rejected`);
  }

  assert.match(testflight, /exit 1/);
  assert.doesNotMatch(testflight, /Fallback for manual branch triggers/);
});

test("TestFlight is only invocable as a reusable workflow, never directly on tag push", async () => {
  const testflight = await readWorkflow("testflight");
  assert.match(testflight, /^on:\n\s+workflow_call:/m);
  assert.doesNotMatch(testflight, /publish-gate/);
});