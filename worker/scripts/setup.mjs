#!/usr/bin/env node
// One-shot secret bootstrap for a new deployment: generates the random
// secrets, hashes the admin passphrase, and pushes everything to Cloudflare
// with `wrangler secret put` in a single interactive pass.
//
//   npm run setup                    # generate + push to the default env
//   npm run setup -- --env preview   # push to a named wrangler env
//   npm run setup -- --print         # print KEY=VALUE lines instead of
//                                    # pushing (e.g. for docker/.env)
//
// Secrets handled:
//   AUTH_PASSWORD_SALT / AUTH_PASSWORD_HASH  — from your admin passphrase
//   SESSION_SECRET                           — random (signs sessions)
//   ACTION_SECRET                            — random (signs one-click
//                                              unsubscribe; rotating it
//                                              invalidates old links)
//   DESTINATION_ENCRYPTION_KEY               — random, base64 of 32 bytes
//                                              (AES-256-GCM requires exactly
//                                              32 bytes — do NOT use a hex
//                                              string here)
//   SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY / SNS_ALLOWED_TOPIC_ARN
//                                            — prompted, optional (skip and
//                                              set later if AWS isn't ready)

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";
import { hashPassphrase } from "./pbkdf2.mjs";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const envIdx = args.indexOf("--env");
const wranglerEnv = envIdx !== -1 ? args[envIdx + 1] : "";
if (envIdx !== -1 && wranglerEnv === undefined) {
  console.error("error: --env requires a value (e.g. --env preview)");
  process.exit(1);
}

const hex = (b) => Buffer.from(b).toString("hex");

// One shared readline interface for the whole run — a fresh interface per
// question swallows buffered lines when input is piped.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let maskInput = false;
if (process.stdin.isTTY) {
  const orig = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (str) => {
    if (!maskInput) return orig(str);
    if (str === "\r\n" || str === "\n") return orig(str);
    // Keep the prompt visible; render every typed character as an asterisk.
    const prompt = rl.getPrompt() ?? "";
    if (prompt && str.startsWith(prompt)) return orig(prompt + "*".repeat(str.length - prompt.length));
    orig("*".repeat(str.length));
  };
}

// Non-TTY (piped) input delivers every line up front, before the next
// question() is armed — buffer them so none are dropped. rl.question()
// consumes lines before the "line" event fires, so in TTY mode this
// listener never races it.
const pendingLines = [];
const lineWaiters = [];
rl.on("line", (line) => {
  const w = lineWaiters.shift();
  if (w) w(line); else pendingLines.push(line);
});
rl.on("close", () => {
  while (lineWaiters.length) lineWaiters.shift()("");
});

function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return new Promise((resolve) => {
      const done = (line) => { process.stdout.write("\n"); resolve(line); };
      const buffered = pendingLines.shift();
      if (buffered !== undefined) done(buffered);
      else lineWaiters.push(done);
    });
  }
  return new Promise((resolve) => {
    maskInput = hidden;
    rl.question(question, (answer) => {
      maskInput = false;
      resolve(answer);
    });
  });
}

function putSecret(name, value) {
  const cmd = ["wrangler", "secret", "put", name];
  if (wranglerEnv) cmd.push("--env", wranglerEnv);
  const res = spawnSync("npx", cmd, {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    cwd: new URL("..", import.meta.url).pathname,
  });
  if (res.error || res.status !== 0) {
    console.error(`\nerror: failed to set ${name} — fix the wrangler error above and re-run.`);
    process.exit(1);
  }
}

console.log("hidemyemail setup — generates all Worker secrets in one pass.\n");
if (printOnly) {
  console.log("(--print mode: nothing is pushed; KEY=VALUE lines are printed at the end)\n");
} else {
  console.log(`Secrets will be pushed with: npx wrangler secret put <NAME>${wranglerEnv ? ` --env ${wranglerEnv}` : ""}`);
  console.log("Make sure `npx wrangler whoami` works before continuing.\n");
}

// 1. Admin passphrase → AUTH_PASSWORD_SALT / AUTH_PASSWORD_HASH
let passphrase;
for (;;) {
  passphrase = await ask("Choose an admin passphrase: ", { hidden: true });
  if (passphrase.length < 8) {
    console.log("Use at least 8 characters.\n");
    continue;
  }
  const confirmed = await ask("Confirm the passphrase:    ", { hidden: true });
  if (passphrase !== confirmed) {
    console.log("Passphrases do not match — try again.\n");
    continue;
  }
  break;
}
const { salt, hash } = await hashPassphrase(passphrase);

// 2. Random secrets
const secrets = {
  AUTH_PASSWORD_SALT: salt,
  AUTH_PASSWORD_HASH: hash,
  SESSION_SECRET: hex(crypto.getRandomValues(new Uint8Array(32))),
  ACTION_SECRET: hex(crypto.getRandomValues(new Uint8Array(32))),
  // AES-256-GCM key — must decode to exactly 32 bytes, hence base64 not hex.
  DESTINATION_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
};

// 3. Optional AWS credentials (enter to skip; set later with wrangler secret put)
console.log("\nAWS credentials for SES sending (press Enter to skip any of these):");
for (const [name, prompt] of [
  ["SES_ACCESS_KEY_ID", "SES access key id:        "],
  ["SES_SECRET_ACCESS_KEY", "SES secret access key:    "],
  ["SNS_ALLOWED_TOPIC_ARN", "SNS outbound topic ARN:   "],
]) {
  const value = (await ask(prompt, { hidden: name === "SES_SECRET_ACCESS_KEY" })).trim();
  if (value) secrets[name] = value;
}

const names = Object.keys(secrets);
if (printOnly) {
  console.log("\n# Generated secrets — keep these safe:");
  for (const name of names) console.log(`${name}=${secrets[name]}`);
  process.exit(0);
}

console.log(`\nAbout to push ${names.length} secrets: ${names.join(", ")}`);
const go = (await ask("Continue? [y/N] ")).trim().toLowerCase();
if (go !== "y" && go !== "yes") {
  console.log("Aborted — nothing was pushed.");
  process.exit(1);
}

for (const name of names) {
  console.log(`\n→ ${name}`);
  putSecret(name, secrets[name]);
}

console.log(`
Done. All secrets are set${wranglerEnv ? ` for env "${wranglerEnv}"` : ""}.

Next steps:
  1. npx wrangler d1 migrations apply DB --remote
  2. npx wrangler deploy
  3. Log in with your admin passphrase and finish setup in the dashboard
     (docs/DEPLOY.md § First-run dashboard setup).

Skipped AWS secrets can be added later with:
  npx wrangler secret put SES_ACCESS_KEY_ID   (etc.)
`);
rl.close();
