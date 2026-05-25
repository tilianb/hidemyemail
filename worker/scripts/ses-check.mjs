// Read-only SES preflight: validates IAM creds + region + identity verification.
// Sends NO mail. Run from worker/ so aws4fetch resolves:
//   SES_ACCESS_KEY_ID=AKIA... SES_SECRET_ACCESS_KEY=... node scripts/ses-check.mjs
import { AwsClient } from "aws4fetch";

const { SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY } = process.env;
const region = process.env.SES_REGION || "ap-southeast-2";
if (!SES_ACCESS_KEY_ID || !SES_SECRET_ACCESS_KEY) {
  console.error("Set SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY env vars (IAM access keys, not SMTP).");
  process.exit(1);
}

const aws = new AwsClient({ accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, region, service: "ses" });
const base = `https://email.${region}.amazonaws.com`;

async function get(path) {
  const res = await aws.fetch(`${base}${path}`, { method: "GET" });
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

const acct = await get("/v2/email/account");
if (acct.status === 403) {
  console.error("403 — signature/permission failure. Are these IAM keys (not SMTP creds)? Region correct?");
  console.error(JSON.stringify(acct.body));
  process.exit(2);
}
console.log("region:", region);
console.log("account:", acct.status, JSON.stringify({
  SendingEnabled: acct.body.SendingEnabled,
  ProductionAccessEnabled: acct.body.ProductionAccessEnabled,
  EnforcementStatus: acct.body.EnforcementStatus,
}));

const ids = await get("/v2/email/identities");
console.log("identities:", ids.status, JSON.stringify(ids.body.EmailIdentities ?? ids.body));
