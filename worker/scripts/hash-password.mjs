const password = process.argv[2];
if (!password) { console.error("usage: node hash-password.mjs <password>"); process.exit(1); }
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
console.log("AUTH_PASSWORD_SALT=" + hex(salt.buffer));
console.log("AUTH_PASSWORD_HASH=" + hex(bits));
