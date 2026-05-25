# SES Inbound Email Receiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SES inbound email receiving so `*@test.hidemyemail.dev` (and any future domain) delivers to the existing `handleInbound()` pipeline via an S3+SNS webhook, replacing the CF Email Routing catch-all that doesn't support subdomains.

**Architecture:** SES receives email for the subdomain (MX → `inbound-smtp.ap-southeast-2.amazonaws.com`), stores the raw MIME to S3 (`hidemyemail-inbound-raw`), then publishes metadata to SNS. The Worker receives the SNS `Received` notification at the new public `/api/ses/inbound` endpoint, fetches the full raw MIME from S3 via `aws4fetch` (same IAM creds + added `s3:GetObject`), and calls the unchanged `handleInbound()`. Zero new vendors; same AWS account, same region.

**Tech Stack:** AWS SES ap-southeast-2 inbound + existing outbound, S3, SNS, Cloudflare Workers, Hono, aws4fetch (already installed), D1.

---

### Task 0: AWS infrastructure setup (manual)

**Goal:** Create the S3 bucket, receipt rule set, SNS topic, and IAM update that SES inbound requires — no code.

**Files:** None (manual AWS console / CLI steps)

**Acceptance Criteria:**
- [ ] S3 bucket `hidemyemail-inbound-raw` in `ap-southeast-2`, public access blocked, 2-day lifecycle
- [ ] Bucket policy allows SES to `s3:PutObject`
- [ ] IAM user (whose keys are in `SES_ACCESS_KEY_ID`) has `s3:GetObject` on the bucket
- [ ] SES receipt rule set `hidemyemail-inbound` is the active rule set in `ap-southeast-2`
- [ ] Receipt rule matches `test.hidemyemail.dev` (catch-all), actions: S3 then SNS
- [ ] SNS topic `hidemyemail-inbound-notifications` created in `ap-southeast-2`
- [ ] SNS topic ARN noted for Task 3

**Verify:**
```bash
aws ses describe-active-receipt-rule-set --region ap-southeast-2
# Shows "RuleSetName": "hidemyemail-inbound" with the catch-all-test-subdomain rule
```

**Steps:**

- [ ] **Step 1: Create S3 bucket with public access blocked and 2-day lifecycle**

```bash
aws s3api create-bucket \
  --bucket hidemyemail-inbound-raw \
  --region ap-southeast-2 \
  --create-bucket-configuration LocationConstraint=ap-southeast-2

aws s3api put-public-access-block \
  --bucket hidemyemail-inbound-raw \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-lifecycle-configuration \
  --bucket hidemyemail-inbound-raw \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-inbound-emails",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": 2}
    }]
  }'
```

If bucket name `hidemyemail-inbound-raw` is taken (bucket names are globally unique), add a short suffix, e.g. `hidemyemail-inbound-raw-au`. Update `S3_INBOUND_BUCKET` in `wrangler.jsonc` and the Task 1 test accordingly.

- [ ] **Step 2: Add bucket policy allowing SES to write**

Get your AWS account ID:
```bash
aws sts get-caller-identity --query Account --output text
```

Create `bucket-policy.json` (replace `YOUR_ACCOUNT_ID`):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ses.amazonaws.com" },
    "Action": ["s3:PutObject"],
    "Resource": "arn:aws:s3:::hidemyemail-inbound-raw/*",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "YOUR_ACCOUNT_ID" }
    }
  }]
}
```

```bash
aws s3api put-bucket-policy \
  --bucket hidemyemail-inbound-raw \
  --policy file://bucket-policy.json
rm bucket-policy.json
```

- [ ] **Step 3: Update IAM user policy — add s3:GetObject**

In AWS Console → IAM → Users → the user whose access key is `SES_ACCESS_KEY_ID` → Permissions tab → edit the policy (inline or managed). Add this statement alongside the existing `ses:SendRawEmail` statement:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject"],
  "Resource": "arn:aws:s3:::hidemyemail-inbound-raw/*"
}
```

Save. The user's policy now covers both SES send and S3 read.

- [ ] **Step 4: Create SNS topic for inbound notifications**

```bash
aws sns create-topic \
  --name hidemyemail-inbound-notifications \
  --region ap-southeast-2
```

Note the `TopicArn` from the output — format:
`arn:aws:sns:ap-southeast-2:ACCOUNT_ID:hidemyemail-inbound-notifications`

Save this ARN — needed in Task 3 Step 2.

- [ ] **Step 5: Create SES receipt rule set and receipt rule**

```bash
# Create rule set
aws ses create-receipt-rule-set \
  --rule-set-name hidemyemail-inbound \
  --region ap-southeast-2

# Create receipt rule (replace YOUR_SNS_TOPIC_ARN)
aws ses create-receipt-rule \
  --rule-set-name hidemyemail-inbound \
  --rule '{
    "Name": "catch-all-test-subdomain",
    "Enabled": true,
    "TlsPolicy": "Optional",
    "Recipients": ["test.hidemyemail.dev"],
    "Actions": [
      {
        "S3Action": {
          "BucketName": "hidemyemail-inbound-raw",
          "ObjectKeyPrefix": ""
        }
      },
      {
        "SNSAction": {
          "TopicArn": "YOUR_SNS_TOPIC_ARN",
          "Encoding": "UTF-8"
        }
      }
    ],
    "ScanEnabled": true
  }' \
  --region ap-southeast-2

# Make this the active rule set
aws ses set-active-receipt-rule-set \
  --rule-set-name hidemyemail-inbound \
  --region ap-southeast-2
```

`Recipients: ["test.hidemyemail.dev"]` — SES treats a bare domain (no local-part) as catch-all for that domain, matching any `*@test.hidemyemail.dev`.

- [ ] **Step 6: Verify**

```bash
aws ses describe-active-receipt-rule-set --region ap-southeast-2
# Expect: RuleSetName "hidemyemail-inbound", rule "catch-all-test-subdomain" Enabled: true
```

---

### Task 1: S3 fetch library + env types

**Goal:** Create `src/lib/s3.ts` with a signed S3 GET function, update `Env` with the two new bindings, and add `S3_INBOUND_BUCKET` to `wrangler.jsonc`.

**Files:**
- Create: `worker/src/lib/s3.ts`
- Modify: `worker/src/types.ts`
- Modify: `worker/wrangler.jsonc`
- Create: `worker/test/s3.test.ts`

**Acceptance Criteria:**
- [ ] `fetchS3Object` returns `Uint8Array` of object bytes
- [ ] Signs request with `service: "s3"` (SigV4); Authorization header matches `AWS4-HMAC-SHA256`
- [ ] URL uses virtual-hosted S3 path: `{bucket}.s3.{region}.amazonaws.com/{key}`
- [ ] Throws `"S3 {status}: ..."` on non-200 response
- [ ] `Env` has `S3_INBOUND_BUCKET: string` and `SNS_INBOUND_TOPIC_ARN?: string`
- [ ] `npm test` passes (all existing tests still pass)

**Verify:** `cd worker && npm test -- --reporter=verbose test/s3.test.ts` → 4 PASS

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `worker/test/s3.test.ts`:
```typescript
import { expect, test } from "vitest";
import { fetchS3Object } from "../src/lib/s3";

test("returns bytes from S3 object", async () => {
  const expected = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const mockFetch = async (_req: Request) => new Response(expected);
  const result = await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "abc123-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(result).toEqual(expected);
});

test("URL uses virtual-hosted S3 path", async () => {
  let capturedUrl = "";
  const mockFetch = async (req: Request) => {
    capturedUrl = req.url;
    return new Response(new Uint8Array([1]));
  };
  await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "my-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(capturedUrl).toContain("hidemyemail-inbound-raw.s3.ap-southeast-2.amazonaws.com");
  expect(capturedUrl).toContain("my-message-id");
});

test("request has SigV4 Authorization header", async () => {
  let capturedAuth = "";
  const mockFetch = async (req: Request) => {
    capturedAuth = req.headers.get("Authorization") ?? "";
    return new Response(new Uint8Array([1]));
  };
  await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "my-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256 /);
});

test("throws on non-OK S3 response", async () => {
  const mockFetch = async () => new Response("NoSuchKey", { status: 404 });
  await expect(
    fetchS3Object(
      { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
      "hidemyemail-inbound-raw",
      "missing-key",
      mockFetch as unknown as typeof fetch
    )
  ).rejects.toThrow("S3 404");
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd worker && npm test -- --reporter=verbose test/s3.test.ts
```
Expected: FAIL with `Cannot find module '../src/lib/s3'`

- [ ] **Step 3: Create `worker/src/lib/s3.ts`**

```typescript
import { AwsClient } from "aws4fetch";
import type { SesCreds } from "./ses";

/**
 * Fetch a raw S3 object using SigV4.
 * Uses the same IAM creds as SES (requires s3:GetObject on the bucket).
 * SES message IDs are alphanumeric+hyphen — no URL encoding needed for the key.
 */
export async function fetchS3Object(
  creds: SesCreds,
  bucket: string,
  key: string,
  fetchImpl?: typeof fetch
): Promise<Uint8Array> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    service: "s3",
  });
  const url = `https://${bucket}.s3.${creds.region}.amazonaws.com/${key}`;
  const signed = await aws.sign(url, { method: "GET" });
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(signed.url, { method: "GET", headers: signed.headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 ${res.status}: ${text}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd worker && npm test -- --reporter=verbose test/s3.test.ts
```
Expected: 4 PASS

- [ ] **Step 5: Update `worker/src/types.ts` — add new env vars**

Replace the `Env` interface with:
```typescript
export interface Env {
  DB: D1Database;
  SES_REGION: string;
  REVERSE_PREFIX: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  SESSION_SECRET: string;
  AUTH_PASSWORD_HASH: string;
  AUTH_PASSWORD_SALT: string;
  SNS_ALLOWED_TOPIC_ARN?: string;
  SNS_INBOUND_TOPIC_ARN?: string;   // SNS topic for SES inbound receipt notifications
  S3_INBOUND_BUCKET: string;        // S3 bucket where SES stores raw inbound emails
  TEST_MIGRATIONS?: unknown;
}
```

(The rest of the file — `DomainRow`, `AliasRow`, etc. — is unchanged.)

- [ ] **Step 6: Update `worker/wrangler.jsonc` — add S3 bucket var**

Change the `vars` line to include `S3_INBOUND_BUCKET`:
```jsonc
"vars": { "SES_REGION": "ap-southeast-2", "REVERSE_PREFIX": "r.", "S3_INBOUND_BUCKET": "hidemyemail-inbound-raw" }
```

If you used a different bucket name in Task 0 Step 1, use that name here.

- [ ] **Step 7: Run all tests**

```bash
cd worker && npm test
```
Expected: all 30+ tests pass (no regressions)

- [ ] **Step 8: Commit**

```bash
cd worker
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" \
git add src/lib/s3.ts src/types.ts wrangler.jsonc test/s3.test.ts
git commit -S -m "feat: add S3 fetch lib and SES inbound env vars"
```

---

### Task 2: SES inbound SNS route

**Goal:** Create `/api/ses/inbound` — a public Hono route that verifies the SNS topic, fetches the raw email from S3, and calls the existing `handleInbound()` unchanged.

**Files:**
- Create: `worker/src/api/routes/ses-inbound.ts`
- Modify: `worker/src/api/app.ts`
- Create: `worker/test/ses-inbound.test.ts`

**Acceptance Criteria:**
- [ ] Wrong `TopicArn` → 403
- [ ] `SubscriptionConfirmation` → 200 (logs SubscribeURL)
- [ ] `Received` notification with known domain → S3 fetched, `handleInbound()` called, 200
- [ ] S3 fetch throws → 500 (SNS will retry delivery)
- [ ] `handleInbound()` throws → 500 (SNS will retry delivery)
- [ ] `Received` for unknown domain → 200 (handleInbound silently drops it — no SES send)
- [ ] Non-`Received` `notificationType` → 200 (ignored)
- [ ] Route is public — no session cookie required
- [ ] `npm test` passes

**Verify:** `cd worker && npm test -- --reporter=verbose test/ses-inbound.test.ts` → 6 PASS

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `worker/test/ses-inbound.test.ts`:
```typescript
import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/api/app";
import { resetDb } from "./helpers";
import * as q from "../src/db/queries";

const INBOUND_ARN = "arn:aws:sns:ap-southeast-2:123456789012:hidemyemail-inbound-notifications";
const RAW_EMAIL = [
  "From: Alice <alice@store.com>",
  "To: shop@test.hidemyemail.dev",
  "Subject: Order update",
  "MIME-Version: 1.0",
  "Content-Type: text/plain",
  "",
  "Your order ships tomorrow.",
  "",
].join("\r\n");

function testEnv(opts: { s3Throws?: boolean } = {}) {
  const sesSent: any[] = [];
  return {
    ...env,
    SNS_INBOUND_TOPIC_ARN: INBOUND_ARN,
    S3_INBOUND_BUCKET: "hidemyemail-inbound-raw",
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    SES_REGION: "ap-southeast-2",
    REVERSE_PREFIX: "r.",
    __s3Fetch: opts.s3Throws
      ? async () => { throw new Error("S3 unavailable"); }
      : async () => new TextEncoder().encode(RAW_EMAIL),
    __sesSend: async (_c: any, m: any) => { sesSent.push(m); return "mid"; },
    _sesSent: sesSent,
  } as any;
}

function snsNotification(to = "shop@test.hidemyemail.dev", messageId = "msg-001-test") {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: INBOUND_ARN,
    Message: JSON.stringify({
      notificationType: "Received",
      mail: { source: "alice@store.com", messageId, destination: [to] },
      receipt: { recipients: [to] },
    }),
  });
}

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await q.createDomain(env.DB as D1Database, "test.hidemyemail.dev", "real@me.com");
});

test("wrong TopicArn → 403", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: "arn:aws:sns:ap-southeast-2:999:wrong" }),
  }, testEnv());
  expect(res.status).toBe(403);
});

test("SubscriptionConfirmation → 200", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      Type: "SubscriptionConfirmation",
      TopicArn: INBOUND_ARN,
      SubscribeURL: "https://sns.ap-southeast-2.amazonaws.com/confirm?Token=abc",
    }),
  }, testEnv());
  expect(res.status).toBe(200);
});

test("valid Received → S3 fetched, handleInbound called, SES sends, 200", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification(),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(1);
  // Verify MIME surgery: From rewritten to reverse alias
  expect(atob(e._sesSent[0].rawBase64)).toContain("r.");
});

test("S3 fetch failure → 500 so SNS retries", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification(),
  }, testEnv({ s3Throws: true }));
  expect(res.status).toBe(500);
});

test("Received for unknown domain → 200, no SES send", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification("anything@unknown.dev", "msg-002"),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});

test("non-Received notificationType → 200 ignored", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      Type: "Notification",
      TopicArn: INBOUND_ARN,
      Message: JSON.stringify({ notificationType: "Bounce" }),
    }),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd worker && npm test -- --reporter=verbose test/ses-inbound.test.ts
```
Expected: FAIL — 404 (route not yet registered) or import error

- [ ] **Step 3: Create `worker/src/api/routes/ses-inbound.ts`**

```typescript
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { handleInbound } from "../../email/inbound";
import { fetchS3Object } from "../../lib/s3";

export function sesInboundRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/ses/inbound", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);

    // Guard: only accept the configured inbound SNS topic
    if (c.env.SNS_INBOUND_TOPIC_ARN && body.TopicArn !== c.env.SNS_INBOUND_TOPIC_ARN) {
      return c.json({ error: "forbidden topic" }, 403);
    }

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      console.log("SNS inbound SubscribeURL:", body.SubscribeURL);
      return c.json({ ok: true });
    }

    if (body.Type !== "Notification") return c.json({ ok: true });

    let msg: any;
    try {
      msg = JSON.parse(body.Message);
    } catch {
      return c.json({ error: "invalid Message JSON" }, 400);
    }

    // Only process inbound email receipts; ignore bounce/complaint/etc
    if (msg.notificationType !== "Received") return c.json({ ok: true });

    const to: string | undefined = msg.receipt?.recipients?.[0];
    const from: string | undefined = msg.mail?.source;
    const messageId: string | undefined = msg.mail?.messageId;
    if (!to || !from || !messageId) {
      return c.json({ error: "missing required fields" }, 400);
    }

    // Fetch full raw MIME from S3 (supports emails of any size, no SNS 256KB truncation risk)
    const creds = {
      accessKeyId: c.env.SES_ACCESS_KEY_ID,
      secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
      region: c.env.SES_REGION,
    };
    const s3Fetch = (c.env as any).__s3Fetch ?? fetchS3Object;
    let raw: Uint8Array;
    try {
      raw = await s3Fetch(creds, c.env.S3_INBOUND_BUCKET, messageId);
    } catch (err) {
      console.error("S3 fetch failed for", messageId, String(err));
      return c.json({ error: "s3 unavailable" }, 500); // 5xx → SNS retries for up to 23 days
    }

    // Build a minimal ForwardableEmailMessage from the S3 bytes
    // handleInbound() only uses: to, from, rawSize, raw (stream) — the rest are stubs
    const rawStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    const fakeMessage = {
      to,
      from,
      rawSize: raw.length,
      raw: rawStream,
      headers: new Headers(),
      setReject: (_code: number, _reason: string) => {},
      forward: async (_addr: string) => {},
      reply: async (_body: Uint8Array) => {},
    } as unknown as ForwardableEmailMessage;

    try {
      await handleInbound(fakeMessage, c.env);
    } catch (err) {
      console.error("handleInbound failed for", messageId, String(err));
      return c.json({ error: "processing failed" }, 500); // 5xx → SNS retries
    }

    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Update `worker/src/api/app.ts` — register route and whitelist path**

Full replacement of `worker/src/api/app.ts`:
```typescript
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { verifySession } from "../lib/auth";
import { authRoutes } from "./routes/auth";
import { domainRoutes } from "./routes/domains";
import { aliasRoutes } from "./routes/aliases";
import { blockRoutes } from "./routes/blocks";
import { statsRoutes } from "./routes/stats";
import { sesWebhookRoutes } from "./routes/ses-webhook";
import { sesInboundRoutes } from "./routes/ses-inbound";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>();

  // public routes (no session)
  app.route("/api", authRoutes());
  app.route("/api", sesWebhookRoutes());
  app.route("/api", sesInboundRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (
      p === "/api/login" ||
      p === "/api/logout" ||
      p === "/api/ses/notification" ||
      p === "/api/ses/inbound"
    ) return next();
    const token = getCookie(c, "session");
    if (!token || !(await verifySession(c.env.SESSION_SECRET, token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // guarded routers
  app.route("/api", domainRoutes());
  app.route("/api", aliasRoutes());
  app.route("/api", blockRoutes());
  app.route("/api", statsRoutes());

  return app;
}
```

- [ ] **Step 5: Run ses-inbound tests — verify they pass**

```bash
cd worker && npm test -- --reporter=verbose test/ses-inbound.test.ts
```
Expected: 6 PASS

- [ ] **Step 6: Run all tests**

```bash
cd worker && npm test
```
Expected: all tests pass (36+ total)

- [ ] **Step 7: Commit**

```bash
cd worker
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" \
git add src/api/routes/ses-inbound.ts src/api/app.ts test/ses-inbound.test.ts
git commit -S -m "feat: add /api/ses/inbound SNS route for SES inbound email"
```

---

### Task 3: Deploy, wire SNS subscription, add DNS and domain

**Goal:** Deploy the updated Worker, confirm the SNS subscription, add the MX DNS record, seed the D1 domain, and verify end-to-end email forwarding.

**Files:** No code changes

**Acceptance Criteria:**
- [ ] Worker deployed successfully with `S3_INBOUND_BUCKET` var and `SNS_INBOUND_TOPIC_ARN` secret
- [ ] SNS subscription to `/api/ses/inbound` confirmed (status not `PendingConfirmation`)
- [ ] MX record `test.hidemyemail.dev → inbound-smtp.ap-southeast-2.amazonaws.com` resolves
- [ ] `test.hidemyemail.dev` domain row exists in D1 with correct `default_destination`
- [ ] Test email sent to `hello@test.hidemyemail.dev` arrives forwarded in destination inbox

**Verify:** Email forwarded with `From: "Sender 'sender@example.com'" <r.TOKEN@test.hidemyemail.dev>` in destination inbox

**Steps:**

- [ ] **Step 1: Deploy Worker**

```bash
cd worker && npx wrangler deploy
```
Expected: `✅ Deployed hidemyemail` — note the new version ID in the output.

- [ ] **Step 2: Set SNS_INBOUND_TOPIC_ARN secret**

```bash
cd worker && npx wrangler secret put SNS_INBOUND_TOPIC_ARN
# Paste the ARN from Task 0 Step 4, e.g.:
# arn:aws:sns:ap-southeast-2:123456789012:hidemyemail-inbound-notifications
```

- [ ] **Step 3: Subscribe SNS topic to the Worker endpoint**

```bash
aws sns subscribe \
  --topic-arn "YOUR_SNS_TOPIC_ARN" \
  --protocol https \
  --notification-endpoint "https://hidemyemail.tburg.workers.dev/api/ses/inbound" \
  --region ap-southeast-2
```

SNS immediately POSTs a `SubscriptionConfirmation` to the endpoint. The Worker logs the `SubscribeURL` via `console.log`. Capture it with wrangler tail:

```bash
cd worker && npx wrangler tail --format pretty 2>&1 | grep SubscribeURL
```

Visit the URL to confirm (curl or browser):
```bash
curl "https://sns.ap-southeast-2.amazonaws.com/...?Action=ConfirmSubscription&Token=..."
```

Verify confirmed:
```bash
aws sns list-subscriptions-by-topic \
  --topic-arn "YOUR_SNS_TOPIC_ARN" \
  --region ap-southeast-2
# SubscriptionArn should be a real ARN, not "PendingConfirmation"
```

- [ ] **Step 4: Add MX DNS record in Cloudflare**

In Cloudflare dashboard → hidemyemail.dev zone → DNS → Add record:
```
Type:     MX
Name:     test
Content:  inbound-smtp.ap-southeast-2.amazonaws.com
Priority: 10
TTL:      Auto
```

Verify DNS propagates (usually < 5 minutes with CF's TTL):
```bash
dig MX test.hidemyemail.dev +short
# Expected: 10 inbound-smtp.ap-southeast-2.amazonaws.com.
```

- [ ] **Step 5: Add `test.hidemyemail.dev` domain to D1**

Check if already exists:
```bash
cd worker && npx wrangler d1 execute hidemyemail \
  --command "SELECT * FROM domains WHERE domain='test.hidemyemail.dev'" \
  --remote
```

If missing (no rows), add via the dashboard at `https://hidemyemail.tburg.workers.dev` (Domains tab → Add domain: `test.hidemyemail.dev`, destination: `me@tilian.au`).

Or via D1 CLI:
```bash
cd worker && npx wrangler d1 execute hidemyemail \
  --command "INSERT INTO domains (domain, default_destination, active, created_at) VALUES ('test.hidemyemail.dev', 'me@tilian.au', 1, unixepoch('now') * 1000)" \
  --remote
```

- [ ] **Step 6: End-to-end test**

Open a wrangler tail to watch live logs:
```bash
cd worker && npx wrangler tail --format pretty
```

Send a test email from any external address to `hello@test.hidemyemail.dev`.

Expected log sequence in tail:
1. `POST /api/ses/inbound` — 200
2. No errors

Expected email in `me@tilian.au` inbox:
- From: `"Sender Name 'sender@email'" <r.TOKEN@test.hidemyemail.dev>` (addy-style)
- Reply-To: `r.TOKEN@test.hidemyemail.dev`
- Subject: original subject

Reply to the forwarded email and verify reply arrives at the original sender.

---

## Known limitations

- **Single recipient per SNS notification**: `receipt.recipients[0]` only. Emails sent to multiple `@test.hidemyemail.dev` addresses simultaneously only forward the first. Extremely rare for a personal service; fix later if needed.
- **SNS signature not verified**: Topic ARN guard prevents other SNS topics from triggering the endpoint but doesn't cryptographically verify the SNS message signature. Acceptable for personal use; full verification is documented in `docs/DEPLOY.md §8` open items.
- **S3 object not deleted after processing**: Lifecycle rule cleans up after 2 days. No idempotency guard — if SNS retries after a successful 200, the email would be forwarded twice. This only happens if the Worker crashes after forwarding but before returning 200, which is extremely rare.
