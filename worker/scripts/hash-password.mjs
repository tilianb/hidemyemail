import { hashPassphrase } from "./pbkdf2.mjs";

const password = process.argv[2];
if (!password) { console.error("usage: node hash-password.mjs <password>"); process.exit(1); }
const { salt, hash } = await hashPassphrase(password);
console.log("AUTH_PASSWORD_SALT=" + salt);
console.log("AUTH_PASSWORD_HASH=" + hash);
