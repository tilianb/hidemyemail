import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
import { webcrypto } from "crypto";

const { subtle } = webcrypto as any;
const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);

// A copy of the crypto utilities for Node.js
function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}

async function hashDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = fromBase64(keyBase64);
  const key = await subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await subtle.sign("HMAC", key, utf8(email.toLowerCase()));
  return toBase64(new Uint8Array(signature));
}

async function encryptDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = fromBase64(keyBase64);
  const key = await subtle.importKey(
    "raw", keyData, "AES-GCM", false, ["encrypt"]
  );
  const iv = new Uint8Array(12);
  getRandomValues(iv);
  const ciphertextBuf = await subtle.encrypt(
    { name: "AES-GCM", iv }, key, utf8(email.toLowerCase())
  );
  const ciphertext = new Uint8Array(ciphertextBuf as ArrayBuffer);
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return toBase64(combined);
}

async function main() {
  const isProd = process.argv.includes("--remote");
  const dbName = "hidemyemail";
  const flag = isProd ? "--remote" : "--local";

  console.log(`Running against D1 database: ${dbName} (${flag})`);

  // Read encryption key from .dev.vars
  const devVars = readFileSync(".dev.vars", "utf8");
  const keyMatch = devVars.match(/DESTINATION_ENCRYPTION_KEY="?([^"\n]+)"?/);
  if (!keyMatch) {
    console.error("Could not find DESTINATION_ENCRYPTION_KEY in .dev.vars");
    process.exit(1);
  }
  const key = keyMatch[1].trim();

  function fetchTable(table: string) {
    const out = execSync(`npx wrangler d1 execute ${dbName} ${flag} --command="SELECT * FROM ${table}" --json`, { encoding: "utf8" });
    try {
      const parsed = JSON.parse(out);
      return parsed[0].results;
    } catch {
      return [];
    }
  }

  const destinations = fetchTable("destinations");
  const domains = fetchTable("domains");
  const aliases = fetchTable("aliases");

  let sql = "";

  console.log(`Found ${destinations.length} destinations to migrate.`);
  for (const row of destinations) {
    if (!row.email_hash) { // Don't re-encrypt if already done
      const enc = await encryptDestination(row.email, key);
      const hash = await hashDestination(row.email, key);
      sql += `UPDATE destinations SET email = '${enc}', email_hash = '${hash}' WHERE id = ${row.id};\n`;
    }
  }

  console.log(`Found ${domains.length} domains to migrate.`);
  for (const row of domains) {
    if (row.default_destination && !row.default_destination_hash) {
      const enc = await encryptDestination(row.default_destination, key);
      const hash = await hashDestination(row.default_destination, key);
      sql += `UPDATE domains SET default_destination = '${enc}', default_destination_hash = '${hash}' WHERE id = ${row.id};\n`;
    }
  }

  console.log(`Found ${aliases.length} aliases to migrate.`);
  for (const row of aliases) {
    if (row.destination && !row.destination_hash) {
      const enc = await encryptDestination(row.destination, key);
      const hash = await hashDestination(row.destination, key);
      sql += `UPDATE aliases SET destination = '${enc}', destination_hash = '${hash}' WHERE id = ${row.id};\n`;
    }
  }

  if (!sql) {
    console.log("Everything is already encrypted!");
    return;
  }

  writeFileSync("migrate-encryption.sql", sql);
  console.log("Generated migrate-encryption.sql");

  console.log("Applying updates to database...");
  execSync(`npx wrangler d1 execute ${dbName} ${flag} --file=migrate-encryption.sql`, { stdio: "inherit" });
  console.log("Migration complete!");
}

main().catch(console.error);
