import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("custom SMTP host boots without SES credentials", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hme-smtp-boot-"));
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "migrations"));
  await writeFile(path.join(root, "assets", "index.html"), "<!doctype html><title>fixture</title>");
  await writeFile(path.join(root, "worker.mjs"), `export default { fetch(request, env) {
    return Response.json({ MAIL_OUTBOUND_PROVIDER: "smtp", SMTP_OUTBOUND_HOST: "127.0.0.1",
      SMTP_OUTBOUND_PORT: "587", SMTP_OUTBOUND_TLS: "starttls", SMTP_INBOUND_ENABLED: "false" });
  } };`);
  const env = { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: path.join(root, "data"),
    ASSETS_DIR: path.join(root, "assets"), WORKER_SCRIPT: path.join(root, "worker.mjs"),
    MIGRATIONS_DIR: path.join(root, "migrations"), MAIL_OUTBOUND_PROVIDER: "smtp",
    SESSION_SECRET: "fixture", AUTH_PASSWORD_HASH: "fixture", AUTH_PASSWORD_SALT: "fixture",
    DESTINATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
  delete env.SES_ACCESS_KEY_ID;
  delete env.SES_SECRET_ACCESS_KEY;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    for (let i = 0; i < 100 && !output.includes("Listening on") && child.exitCode === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(output, /Listening on/, output);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await rm(root, { recursive: true, force: true });
  }
});
