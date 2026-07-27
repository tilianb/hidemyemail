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

afterAll(() => rmSync(archive, { force: true }));

test("ZIP is deterministic and contains only built extension files", () => {
  execFileSync("npm", ["run", "zip"], { cwd: root });
  const first = hash();
  execFileSync("npm", ["run", "zip"], { cwd: root });
  expect(hash()).toBe(first);

  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n").sort();
  const assets = readdirSync(resolve(root, "dist/assets")).map((name) => `assets/${name}`);
  expect(entries).toEqual(["manifest.json", "popup.html", ...assets, "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"].sort());
  expect(entries.join("\n")).not.toMatch(/(?:src|test|node_modules|\.map)/);
  const packagedManifest = JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }));
  expect(packagedManifest.minimum_chrome_version).toBe("102");
}, 120_000);
