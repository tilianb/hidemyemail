import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const archive = resolve(root, "hidemyemail-extension.zip");
const hash = () => createHash("sha256").update(readFileSync(archive)).digest("hex");

test("secret-consuming popup controls start disabled", () => {
  const popup = readFileSync(resolve(root, "popup.html"), "utf8");
  for (const id of ["server", "key", "connect", "domain", "generate"]) expect(popup).toMatch(new RegExp(`id="${id}"[^>]*disabled`));
});

test("source manifest requires Chrome 102 for trusted-context storage", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  expect(manifest.minimum_chrome_version).toBe("102");
});

test("manifest installs all-sites page integration with a module service worker", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
  expect(manifest.content_scripts).toEqual([{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], all_frames: true, run_at: "document_idle" }]);
});

test("v1.3.1 popup uses local app branding assets and product copy", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const popup = readFileSync(resolve(root, "popup.html"), "utf8");
  const styles = readFileSync(resolve(root, "src/popup.css"), "utf8");

  expect(manifest.version).toBe("1.3.1");
  expect(packageJson.version).toBe("1.3.1");
  expect(popup).toContain('src="/icons/icon-48.png"');
  expect(popup).toContain("Stay private.");
  expect(popup).toContain("Generate alias");
  expect(styles).toContain("#0d0d0f");
  expect(styles).toContain("#ffb300");
  for (const font of ["Bricolage Grotesque", "IBM Plex Sans", "JetBrains Mono"]) expect(styles).toContain(`font-family: "${font}"`);
  expect(styles).not.toMatch(/https?:\/\//);
});

afterAll(() => rmSync(archive, { force: true }));

test("ZIP is deterministic and contains only built extension files", () => {
  execFileSync("npm", ["run", "zip"], { cwd: root });
  const first = hash();
  execFileSync("npm", ["run", "zip"], { cwd: root });
  expect(hash()).toBe(first);

  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n").sort();
  const assets = readdirSync(resolve(root, "dist/assets")).map((name) => `assets/${name}`);
  expect(entries).toEqual(["manifest.json", "popup.html", "background.js", "content.js", ...assets, "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"].sort());
  expect(entries.join("\n")).not.toMatch(/(?:src|test|node_modules|\.map)/);
  const packagedManifest = JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }));
  expect(packagedManifest.minimum_chrome_version).toBe("102");
  const packagedPopup = execFileSync("unzip", ["-p", archive, "popup.html"], { encoding: "utf8" });
  const executableURLs = [...packagedPopup.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]);
  expect(executableURLs).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(?:https?:)?\/\//i)]));
  for (const script of ["background.js", "content.js"]) {
    expect(execFileSync("unzip", ["-p", archive, script], { encoding: "utf8" })).not.toMatch(/(?:https?:)?\/\/[^"'`\s)]+\.(?:js|mjs)/i);
  }
  const content = execFileSync("unzip", ["-p", archive, "content.js"], { encoding: "utf8" });
  expect(content).not.toMatch(/(^|[;}])\s*(?:import\s*(?:\(|["'{*])|export\s+(?:\*|\{|default\b|const\b|let\b|var\b|function\b|class\b))/m);
  expect(packagedPopup).toContain('value="https://app.hidemyemail.dev"');
}, 120_000);
