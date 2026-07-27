import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("production deploy stops when its migration fails", async (t) => {
  const workerPackage = JSON.parse(await readFile(
    new URL("../worker/package.json", import.meta.url),
    "utf8",
  ));
  const directory = await mkdtemp(path.join(os.tmpdir(), "hidemyemail-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    private: true,
    scripts: workerPackage.scripts,
  }));
  const binDirectory = path.join(directory, "bin");
  await mkdir(binDirectory);
  const isWindows = process.platform === "win32";
  const wrangler = path.join(binDirectory, isWindows ? "wrangler.cmd" : "wrangler");
  await writeFile(wrangler, isWindows
    ? "@echo off\necho %*>>\"%WRANGLER_LOG%\"\nexit /b 1\n"
    : "#!/bin/sh\necho \"$*\" >> \"$WRANGLER_LOG\"\nexit 1\n");
  if (!isWindows) await chmod(wrangler, 0o755);
  const log = path.join(directory, "wrangler.log");

  const result = spawnSync(isWindows ? "npm.cmd" : "npm", ["run", "deploy"], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      WRANGLER_LOG: log,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(
    (await readFile(log, "utf8")).trim().split("\n"),
    ["d1 migrations apply DB --remote --env="],
  );
  assert.match(workerPackage.scripts.deploy, /(?:^|\s)--keep-vars(?:\s|$)/);
});
