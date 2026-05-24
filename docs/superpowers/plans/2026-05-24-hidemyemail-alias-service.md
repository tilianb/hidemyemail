# hidemyemail.dev Alias Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal serverless email-alias service with full two-way reply-from-alias on Cloudflare Email Routing + a single Worker + Amazon SES + D1, with a React/Vite dashboard on Cloudflare Pages.

**Architecture:** One Worker exports `email()` (inbound re-inject via SES with rewritten `From`, and reverse-alias replies) and `fetch()` (Hono JSON API for the dashboard). D1 stores domains, aliases, reverse mappings, blocks, and an events log. SES (via `aws4fetch` SigV4 over HTTPS) does all outbound. A React SPA on Pages talks to the API with password+signed-cookie auth.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, `aws4fetch`, Vitest (`@cloudflare/vitest-pool-workers`), Vite + React.

**Spec:** `docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md`

---

## File Structure

```
worker/
  src/
    index.ts              # exports { email, fetch }
    types.ts              # Env, row types, shared types
    config.ts             # constants (rate limits, reverse prefix)
    db/queries.ts         # all D1 access (typed)
    lib/
      bytes.ts            # stream->Uint8Array, base64, ascii helpers
      mime.ts             # header surgery on raw MIME bytes
      glob.ts             # tiny glob matcher
      blocks.ts           # block-rule matching
      reverse.ts          # reverse-alias token gen + get-or-create
      ses.ts              # SES v2 SendRawEmail via aws4fetch
      auth.ts             # PBKDF2 password verify + session HMAC
    email/
      router.ts           # classify inbound vs reverse, dispatch
      inbound.ts          # Flow 5.1
      reply.ts            # Flow 5.2
    api/
      app.ts              # Hono app + session middleware
      routes/{auth,domains,aliases,blocks,stats,ses-webhook}.ts
  migrations/0001_init.sql
  test/{apply-migrations,helpers}.ts + *.test.ts
  wrangler.jsonc · vitest.config.ts · tsconfig.json · package.json
dashboard/
  src/{main,App,api,auth}.tsx + pages/{Login,Aliases,Blocks,Stats}.tsx
  index.html · vite.config.ts · package.json · tsconfig.json
docs/DEPLOY.md
```

---

### Task 0: Project scaffold

**Goal:** A buildable, testable Worker project with D1 binding and Vitest wired.

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.jsonc`, `worker/vitest.config.ts`, `worker/src/index.ts`, `worker/src/types.ts`

**Acceptance Criteria:**
- [ ] `npm install` succeeds in `worker/`.
- [ ] `npx vitest run` runs without config errors.
- [ ] `npx wrangler deploy --dry-run` validates the config.

**Verify:** `cd worker && npx vitest run` exits 0; `npx wrangler deploy --dry-run` prints "Dry run complete".

**Steps:**

- [ ] **Step 1: Create `worker/package.json`**

```json
{
  "name": "hidemyemail-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "wrangler deploy",
    "typegen": "wrangler types"
  },
  "dependencies": {
    "aws4fetch": "^1.0.20",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.80.0"
  }
}
```

- [ ] **Step 2: Create `worker/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "hidemyemail",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "hidemyemail", "database_id": "PLACEHOLDER_SET_AFTER_d1_create", "migrations_dir": "migrations" }
  ],
  "vars": { "SES_REGION": "us-east-1", "REVERSE_PREFIX": "r." }
  // Secrets (wrangler secret put): SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY,
  // SESSION_SECRET, AUTH_PASSWORD_HASH, AUTH_PASSWORD_SALT, SNS_ALLOWED_TOPIC_ARN
}
```

- [ ] **Step 3: Create `worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `worker/vitest.config.ts`**

```ts
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return { wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: migrations } } };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
```

- [ ] **Step 5: Create `worker/src/types.ts`**

```ts
export interface Env {
  DB: D1Database;
  SES_REGION: string;
  REVERSE_PREFIX: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  SESSION_SECRET: string;
  AUTH_PASSWORD_HASH: string;   // hex PBKDF2 output
  AUTH_PASSWORD_SALT: string;   // hex salt
  SNS_ALLOWED_TOPIC_ARN?: string;
  TEST_MIGRATIONS?: unknown;
}

export interface DomainRow { id: number; domain: string; default_destination: string; active: number; created_at: number; }
export interface AliasRow {
  id: number; domain_id: number; local_part: string; full_address: string;
  destination: string | null; label: string | null; active: number; source: string;
  fwd_count: number; blocked_count: number; reply_count: number;
  created_at: number; last_seen_at: number | null;
}
export interface ReverseRow { id: number; token: string; alias_id: number; external_sender: string; created_at: number; last_used_at: number | null; }
export interface BlockRow { id: number; alias_id: number | null; pattern: string; created_at: number; }
export type EventType = "forward" | "reply" | "block" | "reject" | "error";
```

- [ ] **Step 6: Create placeholder `worker/src/index.ts`**

```ts
import type { Env } from "./types";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 10
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("ok"); // replaced in Task 14
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Install + verify**

Run: `cd worker && npm install && npx vitest run && npx wrangler deploy --dry-run`
Expected: vitest "No test files found" (exit 0) ; wrangler prints "Dry run complete".

- [ ] **Step 8: Commit** — `git add worker/ && git commit -m "chore: scaffold worker project with D1 + vitest"`

---

### Task 1: D1 schema + migration/test infra

**Goal:** Database schema applied via migrations, plus a shared test reset helper.

**Files:**
- Create: `worker/migrations/0001_init.sql`, `worker/test/apply-migrations.ts`, `worker/test/helpers.ts`, `worker/test/schema.test.ts`

**Acceptance Criteria:**
- [ ] Migration creates all 5 tables + indexes.
- [ ] A test can query an empty table.
- [ ] `resetDb` truncates all tables without using a batched statement string.

**Verify:** `cd worker && npx vitest run test/schema.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Create `worker/migrations/0001_init.sql`** (DDL from spec §4)

```sql
CREATE TABLE domains (
  id INTEGER PRIMARY KEY, domain TEXT UNIQUE NOT NULL,
  default_destination TEXT NOT NULL, active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE aliases (
  id INTEGER PRIMARY KEY, domain_id INTEGER NOT NULL REFERENCES domains(id),
  local_part TEXT NOT NULL, full_address TEXT UNIQUE NOT NULL,
  destination TEXT, label TEXT, active INTEGER DEFAULT 1, source TEXT NOT NULL,
  fwd_count INTEGER DEFAULT 0, blocked_count INTEGER DEFAULT 0, reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE reverse_map (
  id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
  alias_id INTEGER NOT NULL REFERENCES aliases(id), external_sender TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER, UNIQUE(alias_id, external_sender)
);
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY, alias_id INTEGER REFERENCES aliases(id),
  pattern TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, alias_id INTEGER REFERENCES aliases(id),
  type TEXT NOT NULL, external_sender TEXT, subject TEXT, bytes INTEGER, detail TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_alias ON events(alias_id, ts);
```

- [ ] **Step 2: Create `worker/test/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/workers-types";

await applyD1Migrations(env.DB as D1Database, env.TEST_MIGRATIONS as D1Migration[]);
```

- [ ] **Step 3: Create `worker/test/helpers.ts`** (per-table deletes via `prepare().run()`; used by every test's `beforeEach`)

```ts
export async function resetDb(db: D1Database): Promise<void> {
  for (const t of ["events", "reverse_map", "blocks", "aliases", "domains"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
}
```

- [ ] **Step 4: Write `worker/test/schema.test.ts`**

```ts
import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("schema: tables exist and are queryable", async () => {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>();
  expect(r?.n).toBe(0);
});
```

- [ ] **Step 5: Run** `npx vitest run test/schema.test.ts` → PASS

- [ ] **Step 6: Commit** — `git add worker/migrations worker/test && git commit -m "feat: D1 schema, migration + test reset infra"`

---

### Task 2: D1 query layer (`db/queries.ts`)

**Goal:** All D1 access behind typed functions, including alias auto-create, reverse upsert, event insert, and rate count.

**Files:**
- Create: `worker/src/db/queries.ts`, `worker/test/queries.test.ts`

**Acceptance Criteria:**
- [ ] `createDomain`, `getDomain`, `getAlias`, `autoCreateAlias`, `setAliasDestination`, `upsertReverse`, `getReverseByToken`, `touchReverse`, `listBlocks`, `insertEvent`, `countEventsSince`, `incCounter`, `ownerDestinations` work.
- [ ] Auto-create is idempotent; reverse upsert is stable per (alias, sender).

**Verify:** `cd worker && npx vitest run test/queries.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/queries.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); });

test("domain + alias auto-create is idempotent", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a1 = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const a2 = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  expect(a1.id).toBe(a2.id);
  expect(a1.source).toBe("auto");
});

test("reverse upsert returns stable token per (alias,sender)", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const r1 = await q.upsertReverse(DB(), a.id, "boss@store.com", "tok123");
  const r2 = await q.upsertReverse(DB(), a.id, "boss@store.com", "DIFFERENT");
  expect(r2.token).toBe(r1.token);
  const found = await q.getReverseByToken(DB(), r1.token);
  expect(found?.external_sender).toBe("boss@store.com");
});

test("countEventsSince counts only recent rows for alias", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const now = Date.now();
  await q.insertEvent(DB(), { alias_id: a.id, type: "forward", ts: now });
  await q.insertEvent(DB(), { alias_id: a.id, type: "forward", ts: now - 7200_000 });
  expect(await q.countEventsSince(DB(), a.id, now - 3600_000)).toBe(1);
});

test("ownerDestinations unions domain defaults and alias overrides", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "x", "x@hidemyemail.dev");
  await q.setAliasDestination(DB(), a.id, "work@me.com");
  const set = await q.ownerDestinations(DB());
  expect(set.has("real@me.com")).toBe(true);
  expect(set.has("work@me.com")).toBe(true);
});
```

- [ ] **Step 2: Run** → FAIL ("Cannot find module queries").

- [ ] **Step 3: Write `worker/src/db/queries.ts`**

```ts
import type { AliasRow, DomainRow, EventType, ReverseRow, BlockRow } from "../types";

export async function createDomain(db: D1Database, domain: string, dest: string): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO domains (domain, default_destination, active, created_at) VALUES (?,?,1,?) RETURNING id"
  ).bind(domain, dest, Date.now()).first<{ id: number }>();
  return r!.id;
}

export async function getDomain(db: D1Database, domain: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain).first<DomainRow>();
}

export async function getAlias(db: D1Database, fullAddress: string): Promise<AliasRow | null> {
  return db.prepare("SELECT * FROM aliases WHERE full_address = ?").bind(fullAddress).first<AliasRow>();
}

export async function autoCreateAlias(
  db: D1Database, domainId: number, localPart: string, fullAddress: string, source = "auto"
): Promise<AliasRow> {
  const existing = await getAlias(db, fullAddress);
  if (existing) return existing;
  await db.prepare(
    "INSERT INTO aliases (domain_id, local_part, full_address, active, source, created_at) VALUES (?,?,?,1,?,?) " +
    "ON CONFLICT(full_address) DO NOTHING"
  ).bind(domainId, localPart, fullAddress, source, Date.now()).run();
  return (await getAlias(db, fullAddress))!;
}

export async function setAliasDestination(db: D1Database, id: number, dest: string | null): Promise<void> {
  await db.prepare("UPDATE aliases SET destination = ? WHERE id = ?").bind(dest, id).run();
}

export async function upsertReverse(
  db: D1Database, aliasId: number, externalSender: string, token: string
): Promise<ReverseRow> {
  await db.prepare(
    "INSERT INTO reverse_map (token, alias_id, external_sender, created_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(alias_id, external_sender) DO NOTHING"
  ).bind(token, aliasId, externalSender, Date.now()).run();
  return (await db.prepare("SELECT * FROM reverse_map WHERE alias_id = ? AND external_sender = ?")
    .bind(aliasId, externalSender).first<ReverseRow>())!;
}

export async function getReverseByToken(db: D1Database, token: string): Promise<ReverseRow | null> {
  return db.prepare("SELECT * FROM reverse_map WHERE token = ?").bind(token).first<ReverseRow>();
}

export async function touchReverse(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE reverse_map SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function listBlocks(db: D1Database, aliasId: number): Promise<BlockRow[]> {
  const r = await db.prepare("SELECT * FROM blocks WHERE alias_id IS NULL OR alias_id = ?").bind(aliasId).all<BlockRow>();
  return r.results ?? [];
}

export async function insertEvent(
  db: D1Database,
  e: { alias_id?: number | null; type: EventType; external_sender?: string; subject?: string; bytes?: number; detail?: string; ts: number }
): Promise<void> {
  await db.prepare(
    "INSERT INTO events (alias_id, type, external_sender, subject, bytes, detail, ts) VALUES (?,?,?,?,?,?,?)"
  ).bind(e.alias_id ?? null, e.type, e.external_sender ?? null, e.subject ?? null, e.bytes ?? null, e.detail ?? null, e.ts).run();
}

export async function countEventsSince(db: D1Database, aliasId: number | null, since: number): Promise<number> {
  const sql = aliasId == null
    ? "SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND type IN ('forward','reply')"
    : "SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND alias_id = ? AND type IN ('forward','reply')";
  const stmt = aliasId == null ? db.prepare(sql).bind(since) : db.prepare(sql).bind(since, aliasId);
  const r = await stmt.first<{ n: number }>();
  return r?.n ?? 0;
}

export async function incCounter(db: D1Database, aliasId: number, col: "fwd_count" | "blocked_count" | "reply_count"): Promise<void> {
  await db.prepare(`UPDATE aliases SET ${col} = ${col} + 1, last_seen_at = ? WHERE id = ?`).bind(Date.now(), aliasId).run();
}

export async function ownerDestinations(db: D1Database): Promise<Set<string>> {
  const a = await db.prepare("SELECT default_destination AS d FROM domains").all<{ d: string }>();
  const b = await db.prepare("SELECT DISTINCT destination AS d FROM aliases WHERE destination IS NOT NULL").all<{ d: string }>();
  return new Set([...(a.results ?? []), ...(b.results ?? [])].map((x) => x.d.toLowerCase()));
}
```

- [ ] **Step 4: Run** `npx vitest run test/queries.test.ts` → PASS

- [ ] **Step 5: Commit** — `git add worker/src/db worker/test/queries.test.ts && git commit -m "feat: typed D1 query layer"`

---

### Task 3: Glob matcher + block rules

**Goal:** Match sender addresses against block patterns (`exact@x.com` or `*@x.com`).

**Files:**
- Create: `worker/src/lib/glob.ts`, `worker/src/lib/blocks.ts`, `worker/test/blocks.test.ts`

**Acceptance Criteria:**
- [ ] `*@spam.com` matches `a@spam.com`, not `a@ok.com`.
- [ ] Patterns match case-insensitively.
- [ ] `isBlocked` returns true if any rule matches.

**Verify:** `cd worker && npx vitest run test/blocks.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/blocks.test.ts`**

```ts
import { expect, test } from "vitest";
import { globMatch } from "../src/lib/glob";
import { isBlocked } from "../src/lib/blocks";

test("glob: wildcard and exact", () => {
  expect(globMatch("*@spam.com", "a@spam.com")).toBe(true);
  expect(globMatch("*@spam.com", "a@ok.com")).toBe(false);
  expect(globMatch("Boss@X.com", "boss@x.com")).toBe(true);
});

test("isBlocked: any rule matches", () => {
  const rules = [{ pattern: "*@spam.com" }, { pattern: "evil@x.com" }];
  expect(isBlocked(rules, "anyone@spam.com")).toBe(true);
  expect(isBlocked(rules, "evil@x.com")).toBe(true);
  expect(isBlocked(rules, "friend@x.com")).toBe(false);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/lib/glob.ts`**

```ts
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  const re = new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$");
  return re.test(v);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Write `worker/src/lib/blocks.ts`**

```ts
import { globMatch } from "./glob";

export function isBlocked(rules: { pattern: string }[], sender: string): boolean {
  return rules.some((r) => globMatch(r.pattern, sender));
}
```

- [ ] **Step 5: Run** → PASS. **Commit** — `git add worker/src/lib/glob.ts worker/src/lib/blocks.ts worker/test/blocks.test.ts && git commit -m "feat: glob matcher + block matching"`

---

### Task 4: MIME header surgery (`lib/mime.ts`)

**Goal:** Edit headers on a raw MIME message represented as bytes, preserving the body (including binary attachments) exactly.

**Files:**
- Create: `worker/src/lib/bytes.ts`, `worker/src/lib/mime.ts`, `worker/test/mime.test.ts`

**Acceptance Criteria:**
- [ ] Splits headers/body at first CRLFCRLF (or LFLF fallback).
- [ ] `setHeader` replaces an existing header (case-insensitive) or appends if absent.
- [ ] `removeHeaders` drops all matching headers.
- [ ] Body bytes are byte-for-byte preserved.
- [ ] `toBase64` round-trips through `fromBase64` on binary input.

**Verify:** `cd worker && npx vitest run test/mime.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/mime.test.ts`**

```ts
import { expect, test } from "vitest";
import { parseMime, serializeMime, setHeader, removeHeaders } from "../src/lib/mime";
import { toBase64, fromBase64, utf8 } from "../src/lib/bytes";

const RAW = utf8(
  "From: Alice <alice@store.com>\r\n" +
  "To: shop@hidemyemail.dev\r\n" +
  "Subject: Hi\r\n" +
  "DKIM-Signature: v=1; a=rsa-sha256; stuff\r\n" +
  "\r\n" +
  "body line 1\r\nbody line 2\r\n"
);

test("parse splits headers and body; body preserved", () => {
  const m = parseMime(RAW);
  expect(m.headers.find((h) => h.name.toLowerCase() === "subject")?.value).toBe("Hi");
  expect(new TextDecoder().decode(m.body)).toBe("body line 1\r\nbody line 2\r\n");
});

test("setHeader replaces existing, appends new; removeHeaders drops", () => {
  let m = parseMime(RAW);
  m = setHeader(m, "From", '"Alice via shop" <r.tok@hidemyemail.dev>');
  m = setHeader(m, "Reply-To", "r.tok@hidemyemail.dev");
  m = removeHeaders(m, ["DKIM-Signature"]);
  const out = new TextDecoder().decode(serializeMime(m));
  expect(out).toContain('From: "Alice via shop" <r.tok@hidemyemail.dev>');
  expect(out).toContain("Reply-To: r.tok@hidemyemail.dev");
  expect(out).not.toContain("DKIM-Signature");
  expect(out).toContain("body line 1");
});

test("base64 round-trip on binary", () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
  expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/lib/bytes.ts`**

```ts
export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }

export async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
```

- [ ] **Step 4: Write `worker/src/lib/mime.ts`**

```ts
import { concat, utf8 } from "./bytes";

export interface Header { name: string; value: string; }
export interface Mime { headers: Header[]; body: Uint8Array; }

function findBodyStart(bytes: Uint8Array): { headerEnd: number; bodyStart: number } {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
      return { headerEnd: i, bodyStart: i + 4 };
  }
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { headerEnd: i, bodyStart: i + 2 };
  }
  return { headerEnd: bytes.length, bodyStart: bytes.length };
}

export function parseMime(bytes: Uint8Array): Mime {
  const { headerEnd, bodyStart } = findBodyStart(bytes);
  const headerText = new TextDecoder("ascii").decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split(/\r?\n/);
  const headers: Header[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && headers.length) {
      headers[headers.length - 1].value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return { headers, body: bytes.subarray(bodyStart) };
}

export function getHeader(m: Mime, name: string): string | undefined {
  const lower = name.toLowerCase();
  return m.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

export function setHeader(m: Mime, name: string, value: string): Mime {
  const lower = name.toLowerCase();
  const kept = m.headers.filter((h) => h.name.toLowerCase() !== lower);
  return { headers: [...kept, { name, value }], body: m.body };
}

export function removeHeaders(m: Mime, names: string[]): Mime {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return { headers: m.headers.filter((h) => !drop.has(h.name.toLowerCase())), body: m.body };
}

export function serializeMime(m: Mime): Uint8Array {
  const headerText = m.headers.map((h) => `${h.name}: ${h.value}`).join("\r\n") + "\r\n\r\n";
  return concat(utf8(headerText), m.body);
}
```

- [ ] **Step 5: Run** `npx vitest run test/mime.test.ts` → PASS

- [ ] **Step 6: Commit** — `git add worker/src/lib/bytes.ts worker/src/lib/mime.ts worker/test/mime.test.ts && git commit -m "feat: byte-safe MIME header surgery + base64"`

---

### Task 5: SES client (`lib/ses.ts`)

**Goal:** Send a raw base64 MIME message via SES v2, correctly SigV4-signed.

**Files:**
- Create: `worker/src/lib/ses.ts`, `worker/test/ses.test.ts`

**Acceptance Criteria:**
- [ ] Posts to `https://email.{region}.amazonaws.com/v2/email/outbound-emails`.
- [ ] Signs with `service: "ses"` (NOT auto-parsed `email`).
- [ ] Body is `{FromEmailAddress, Destination:{ToAddresses}, Content:{Raw:{Data}}}`.
- [ ] Throws `SesTransientError` on 429/5xx, `SesPermanentError` on 4xx.

**Verify:** `cd worker && npx vitest run test/ses.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/ses.test.ts`**

```ts
import { expect, test, vi } from "vitest";
import { sendRaw, SesTransientError, SesPermanentError } from "../src/lib/ses";

const creds = { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };

test("posts signed request to SES v2 raw endpoint with correct body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ MessageId: "abc" }), { status: 200 });
  });
  const id = await sendRaw(creds, { from: "r.tok@d.dev", to: "boss@store.com", rawBase64: "QkFTRTY0" }, fetchMock as any);
  expect(id).toBe("abc");
  expect(calls[0].url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  const body = JSON.parse(calls[0].init.body as string);
  expect(body.FromEmailAddress).toBe("r.tok@d.dev");
  expect(body.Destination.ToAddresses).toEqual(["boss@store.com"]);
  expect(body.Content.Raw.Data).toBe("QkFTRTY0");
});

test("maps status codes to error types", async () => {
  const f429 = async () => new Response("{}", { status: 429 });
  await expect(sendRaw(creds, { from: "a@d", to: "b@c", rawBase64: "x" }, f429 as any)).rejects.toBeInstanceOf(SesTransientError);
  const f400 = async () => new Response("{}", { status: 400 });
  await expect(sendRaw(creds, { from: "a@d", to: "b@c", rawBase64: "x" }, f400 as any)).rejects.toBeInstanceOf(SesPermanentError);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/lib/ses.ts`**

```ts
import { AwsClient } from "aws4fetch";

export class SesTransientError extends Error {}
export class SesPermanentError extends Error {}

export interface SesCreds { accessKeyId: string; secretAccessKey: string; region: string; }
export interface SesRawMessage { from: string; to: string; rawBase64: string; feedbackForwarding?: string; }

export async function sendRaw(
  creds: SesCreds, msg: SesRawMessage, fetchImpl?: typeof fetch
): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    service: "ses", // CRITICAL: host is email.* so auto-parse would pick "email"
  });
  const url = `https://email.${creds.region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify({
    FromEmailAddress: msg.from,
    Destination: { ToAddresses: [msg.to] },
    Content: { Raw: { Data: msg.rawBase64 } },
    ...(msg.feedbackForwarding ? { FeedbackForwardingEmailAddress: msg.feedbackForwarding } : {}),
  });
  const signed = await aws.sign(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(signed.url, { method: "POST", headers: signed.headers, body });
  if (res.ok) {
    const json = await res.json<{ MessageId: string }>();
    return json.MessageId;
  }
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) throw new SesTransientError(`SES ${res.status}: ${text}`);
  throw new SesPermanentError(`SES ${res.status}: ${text}`);
}
```

> NOTE on testability: the test passes `fetchMock` and asserts URL/body. `aws.sign()` returns a `Request`; we read `signed.url`/`signed.headers` then re-issue via the injected fetch, keeping signing real while intercepting the network call.

- [ ] **Step 4: Run** `npx vitest run test/ses.test.ts` → PASS

- [ ] **Step 5: Commit** — `git add worker/src/lib/ses.ts worker/test/ses.test.ts && git commit -m "feat: SES v2 SendRawEmail client (service=ses)"`

---

### Task 6: Reverse-alias logic (`lib/reverse.ts`) + config

**Goal:** Generate unguessable tokens and get-or-create a stable reverse mapping per (alias, sender).

**Files:**
- Create: `worker/src/config.ts`, `worker/src/lib/reverse.ts`, `worker/test/reverse.test.ts`

**Acceptance Criteria:**
- [ ] `newToken(24)` returns a 24-char base32 string from crypto RNG (lowercase, `[a-z2-7]`).
- [ ] `reverseAddress(token, domain)` → `r.{token}@{domain}`.
- [ ] `parseReverse(localPart)` returns token iff prefix `r.`.
- [ ] `getOrCreateReverse` reuses the existing token for the same (alias, sender).

**Verify:** `cd worker && npx vitest run test/reverse.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/src/config.ts`**

```ts
export const REVERSE_PREFIX = "r.";
export const RATE_PER_HOUR_ALIAS = 200;   // mirrors old ANONADDY_LIMIT
export const RATE_PER_HOUR_GLOBAL = 1000;
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
```

- [ ] **Step 2: Write `worker/test/reverse.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { newToken, reverseAddress, parseReverse, getOrCreateReverse } from "../src/lib/reverse";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); });

test("token is 24-char base32", () => {
  const t = newToken(24);
  expect(t).toMatch(/^[a-z2-7]{24}$/);
  expect(newToken(24)).not.toBe(t);
});

test("reverseAddress and parseReverse round-trip", () => {
  expect(reverseAddress("abcd", "hidemyemail.dev")).toBe("r.abcd@hidemyemail.dev");
  expect(parseReverse("r.abcd")).toBe("abcd");
  expect(parseReverse("shop")).toBeNull();
});

test("getOrCreateReverse is stable per (alias,sender)", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const r1 = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const r2 = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  expect(r2.token).toBe(r1.token);
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Write `worker/src/lib/reverse.ts`**

```ts
import { REVERSE_PREFIX } from "../config";
import * as q from "../db/queries";
import type { ReverseRow } from "../types";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newToken(len = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out; // len chars; 24 chars ~= 120 bits of entropy
}

export function reverseAddress(token: string, domain: string): string {
  return `${REVERSE_PREFIX}${token}@${domain}`;
}

export function parseReverse(localPart: string): string | null {
  return localPart.startsWith(REVERSE_PREFIX) ? localPart.slice(REVERSE_PREFIX.length) : null;
}

export async function getOrCreateReverse(db: D1Database, aliasId: number, externalSender: string): Promise<ReverseRow> {
  return q.upsertReverse(db, aliasId, externalSender.toLowerCase(), newToken(24));
}
```

- [ ] **Step 5: Run** `npx vitest run test/reverse.test.ts` → PASS

- [ ] **Step 6: Commit** — `git add worker/src/config.ts worker/src/lib/reverse.ts worker/test/reverse.test.ts && git commit -m "feat: reverse-alias tokens + stable mapping"`

---

### Task 7: Auth (`lib/auth.ts`)

**Goal:** Verify the owner password (PBKDF2) and issue/verify signed session cookies (HMAC + expiry).

**Files:**
- Create: `worker/src/lib/auth.ts`, `worker/test/auth.test.ts`

**Acceptance Criteria:**
- [ ] `verifyPassword` returns true for correct password, false otherwise (constant-time compare).
- [ ] `signSession`/`verifySession` round-trip; expired or tampered tokens fail.
- [ ] `hashPassword` produces `{saltHex, hashHex}`.

**Verify:** `cd worker && npx vitest run test/auth.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/auth.test.ts`**

```ts
import { expect, test } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession } from "../src/lib/auth";

test("password hash + verify", async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  expect(await verifyPassword("hunter2", saltHex, hashHex)).toBe(true);
  expect(await verifyPassword("wrong", saltHex, hashHex)).toBe(false);
});

test("session sign/verify round-trip and expiry", async () => {
  const secret = "topsecret";
  const tok = await signSession(secret, 3600);
  expect(await verifySession(secret, tok)).toBe(true);
  expect(await verifySession("other", tok)).toBe(false);
  const expired = await signSession(secret, -1);
  expect(await verifySession(secret, expired)).toBe(false);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/lib/auth.ts`**

```ts
const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<{ saltHex: string; hashHex: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { saltHex: toHex(salt.buffer), hashHex: await pbkdf2(password, salt) };
}

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const computed = await pbkdf2(password, fromHex(saltHex));
  return timingSafeEqual(computed, hashHex);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signSession(secret: string, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `v1.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySession(secret: string, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [v, expStr, sig] = parts;
  const payload = `${v}.${expStr}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expected)) return false;
  return Number(expStr) > Math.floor(Date.now() / 1000);
}
```

- [ ] **Step 4: Run** `npx vitest run test/auth.test.ts` → PASS

- [ ] **Step 5: Commit** — `git add worker/src/lib/auth.ts worker/test/auth.test.ts && git commit -m "feat: PBKDF2 password + HMAC session tokens"`

---

### Task 8: Inbound flow (`email/inbound.ts`)

**Goal:** Orchestrate Flow 5.1 — lookup/auto-create, block/rate/size guards, header rewrite, SES re-inject.

**Files:**
- Create: `worker/src/email/inbound.ts`, `worker/test/inbound.test.ts`

**Acceptance Criteria:**
- [ ] Unknown domain → dropped, no SES call.
- [ ] New alias → auto-created; clean mail → SES called with rewritten `From`/`Reply-To`, DKIM stripped; `forward` event + `fwd_count++`.
- [ ] Blocked sender → no SES; `block` event + `blocked_count++`.
- [ ] Over rate limit / disabled alias → no SES; `reject` event.

**Verify:** `cd worker && npx vitest run test/inbound.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/inbound.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { handleInbound } from "../src/email/inbound";
import * as q from "../src/db/queries";
import { utf8 } from "../src/lib/bytes";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;

function mkMessage(from: string, to: string, raw: string) {
  return { from, to, headers: new Headers(), raw: new Response(raw).body!, rawSize: utf8(raw).length,
    setReject: vi.fn(), forward: vi.fn(), reply: vi.fn() } as unknown as ForwardableEmailMessage;
}
function testEnv(sentinel: { sent: any[] }) {
  return { ...env, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "s", SES_REGION: "us-east-1", REVERSE_PREFIX: "r.",
    __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); return "mid"; } } as any;
}
const RAW = "From: Alice <alice@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nDKIM-Signature: v=1; x\r\n\r\nhello\r\n";

beforeEach(async () => { await resetDb(DB()); await q.createDomain(DB(), "hidemyemail.dev", "real@me.com"); });

test("clean mail to new alias → SES re-inject with rewritten headers", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("via shop@hidemyemail.dev");
  expect(decoded).toContain("Reply-To: r.");
  expect(decoded).not.toContain("DKIM-Signature");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.fwd_count).toBe(1);
});

test("blocked sender → no SES, block event", async () => {
  const sentinel = { sent: [] as any[] };
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("INSERT INTO blocks (alias_id, pattern, created_at) VALUES (NULL, '*@store.com', ?)").bind(Date.now()).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.blocked_count).toBe(1);
});

test("disabled alias → no SES", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(a.id).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});

test("unknown domain → dropped, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@unknown.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/email/inbound.ts`**

```ts
import type { Env } from "../types";
import * as q from "../db/queries";
import { isBlocked } from "../lib/blocks";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { getOrCreateReverse, reverseAddress } from "../lib/reverse";
import { sendRaw, SesTransientError } from "../lib/ses";
import { RATE_PER_HOUR_ALIAS, RATE_PER_HOUR_GLOBAL, MAX_INBOUND_BYTES } from "../config";

type SesSend = typeof sendRaw;

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();
  const [localPart, domainName] = splitAddress(message.to);

  const domain = await q.getDomain(db, domainName);
  if (!domain || domain.active === 0) return;

  const alias = await q.autoCreateAlias(db, domain.id, localPart, message.to.toLowerCase());

  if (alias.active === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "disabled", ts: now });
    return;
  }

  const rules = await q.listBlocks(db, alias.id);
  if (isBlocked(rules, message.from)) {
    await q.insertEvent(db, { alias_id: alias.id, type: "block", external_sender: message.from, ts: now });
    await q.incCounter(db, alias.id, "blocked_count");
    return;
  }

  const aliasCount = await q.countEventsSince(db, alias.id, now - 3600_000);
  const globalCount = await q.countEventsSince(db, null, now - 3600_000);
  if (aliasCount >= RATE_PER_HOUR_ALIAS || globalCount >= RATE_PER_HOUR_GLOBAL) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "rate", ts: now });
    return;
  }

  if (message.rawSize > MAX_INBOUND_BYTES) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "too_large", ts: now });
    return;
  }

  const dest = alias.destination ?? domain.default_destination;
  const reverse = await getOrCreateReverse(db, alias.id, message.from);
  const reverseAddr = reverseAddress(reverse.token, domainName);

  const raw = await streamToBytes(message.raw);
  let mime = parseMime(raw);
  const origFrom = getHeader(mime, "From") ?? message.from;
  const displayName = extractDisplayName(origFrom) || message.from;
  mime = setHeader(mime, "From", `"${sanitize(displayName)} via ${alias.full_address}" <${reverseAddr}>`);
  mime = setHeader(mime, "Reply-To", reverseAddr);
  mime = removeHeaders(mime, ["DKIM-Signature", "ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results", "Return-Path", "Sender"]);
  mime = setHeader(mime, "X-Reinjected", "1");
  const rawBase64 = toBase64(serializeMime(mime));

  try {
    await ses(
      { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, region: env.SES_REGION },
      { from: reverseAddr, to: dest, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err; // tempfail → sender retries
    return;
  }

  await q.insertEvent(db, { alias_id: alias.id, type: "forward", external_sender: message.from, subject: getHeader(mime, "Subject"), bytes: message.rawSize, ts: now });
  await q.incCounter(db, alias.id, "fwd_count");
}

function splitAddress(addr: string): [string, string] {
  const at = addr.lastIndexOf("@");
  return [addr.slice(0, at).toLowerCase(), addr.slice(at + 1).toLowerCase()];
}
function extractDisplayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : "";
}
function sanitize(s: string): string {
  return s.replace(/["\r\n]/g, "").slice(0, 100);
}
```

- [ ] **Step 4: Run** `npx vitest run test/inbound.test.ts` → PASS

- [ ] **Step 5: Commit** — `git add worker/src/email/inbound.ts worker/test/inbound.test.ts && git commit -m "feat: inbound flow with SES re-inject + guards"`

---

### Task 9: Reply flow (`email/reply.ts`)

**Goal:** Flow 5.2 — verify owner, rewrite to send as alias, strip real-address leaks, SES send to external.

**Files:**
- Create: `worker/src/email/reply.ts`, `worker/test/reply.test.ts`

**Acceptance Criteria:**
- [ ] Reply from a non-owner address → rejected, no SES, `reject` event.
- [ ] Reply from owner → SES called with `From: alias`, `To: external`; real-address headers stripped; `reply` event + `reply_count++`.

**Verify:** `cd worker && npx vitest run test/reply.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/reply.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { handleReply } from "../src/email/reply";
import * as q from "../src/db/queries";
import { getOrCreateReverse } from "../src/lib/reverse";
import { utf8 } from "../src/lib/bytes";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
function mkMessage(from: string, to: string, raw: string) {
  return { from, to, headers: new Headers(), raw: new Response(raw).body!, rawSize: utf8(raw).length,
    setReject: vi.fn(), forward: vi.fn(), reply: vi.fn() } as unknown as ForwardableEmailMessage;
}
function testEnv(sentinel: { sent: any[] }) {
  return { ...env, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "s", SES_REGION: "us-east-1", REVERSE_PREFIX: "r.",
    __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); return "mid"; } } as any;
}
const REPLY_RAW = "From: Me <real@me.com>\r\nTo: r.TOKEN@hidemyemail.dev\r\nSubject: Re: Hi\r\nMessage-ID: <x@gmail.com>\r\n\r\nmy reply\r\n";

beforeEach(async () => { await resetDb(DB()); await q.createDomain(DB(), "hidemyemail.dev", "real@me.com"); });

test("owner reply → SES send as alias, leaks stripped", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const rev = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const raw = REPLY_RAW.replace("TOKEN", rev.token);
  await handleReply(mkMessage("real@me.com", `r.${rev.token}@hidemyemail.dev`, raw), testEnv(sentinel), rev.token);
  expect(sentinel.sent.length).toBe(1);
  expect(sentinel.sent[0].from).toBe("shop@hidemyemail.dev");
  expect(sentinel.sent[0].to).toBe("boss@store.com");
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("From: shop@hidemyemail.dev");
  expect(decoded).not.toContain("real@me.com");
  expect(decoded).not.toContain("@gmail.com");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.reply_count).toBe(1);
});

test("non-owner reply → rejected, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const rev = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const raw = REPLY_RAW.replace("TOKEN", rev.token).replace("real@me.com", "attacker@evil.com");
  await handleReply(mkMessage("attacker@evil.com", `r.${rev.token}@hidemyemail.dev`, raw), testEnv(sentinel), rev.token);
  expect(sentinel.sent.length).toBe(0);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/email/reply.ts`**

```ts
import type { Env } from "../types";
import * as q from "../db/queries";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { sendRaw, SesTransientError } from "../lib/ses";

type SesSend = typeof sendRaw;

export async function handleReply(message: ForwardableEmailMessage, env: Env, token: string): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();

  const reverse = await q.getReverseByToken(db, token);
  if (!reverse) return;

  const owners = await q.ownerDestinations(db);
  if (!owners.has(message.from.toLowerCase())) {
    await q.insertEvent(db, { alias_id: reverse.alias_id, type: "reject", external_sender: message.from, detail: "not_owner", ts: now });
    return;
  }

  const alias = await db.prepare("SELECT full_address FROM aliases WHERE id = ?").bind(reverse.alias_id).first<{ full_address: string }>();
  if (!alias) return;

  const raw = await streamToBytes(message.raw);
  let mime = parseMime(raw);
  const subject = getHeader(mime, "Subject") ?? "";
  mime = removeHeaders(mime, ["From", "Sender", "Reply-To", "Return-Path", "DKIM-Signature", "Message-ID", "X-Reinjected", "Received"]);
  mime = setHeader(mime, "From", alias.full_address);
  mime = setHeader(mime, "To", reverse.external_sender);
  mime = setHeader(mime, "Message-ID", `<${crypto.randomUUID()}@${alias.full_address.split("@")[1]}>`);

  const rawBase64 = toBase64(serializeMime(mime));
  try {
    await ses(
      { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, region: env.SES_REGION },
      { from: alias.full_address, to: reverse.external_sender, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: reverse.alias_id, type: "error", detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err;
    return;
  }

  await q.touchReverse(db, reverse.id);
  await q.insertEvent(db, { alias_id: reverse.alias_id, type: "reply", external_sender: reverse.external_sender, subject, ts: now });
  await q.incCounter(db, reverse.alias_id, "reply_count");
}
```

> NOTE: `In-Reply-To`/`References` are intentionally preserved (not stripped) for threading; they reference the reverse-alias/external Message-IDs, not your real address.

- [ ] **Step 4: Run** `npx vitest run test/reply.test.ts` → PASS

- [ ] **Step 5: Commit** — `git add worker/src/email/reply.ts worker/test/reply.test.ts && git commit -m "feat: reply-from-alias flow + owner check + leak scrub"`

---

### Task 10: Email router + handler wiring

**Goal:** Classify inbound vs reverse-alias and dispatch; wire into `index.ts` `email()`.

**Files:**
- Create: `worker/src/email/router.ts`, `worker/test/router.test.ts`
- Modify: `worker/src/index.ts`

**Acceptance Criteria:**
- [ ] `r.{token}@D` recipient → reply handler; other → inbound handler.
- [ ] `index.ts` `email()` calls the router.

**Verify:** `cd worker && npx vitest run test/router.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/router.test.ts`**

```ts
import { expect, test } from "vitest";
import { routeEmail } from "../src/email/router";

test("routes reverse-alias to reply, else inbound", async () => {
  const calls: string[] = [];
  const deps = {
    handleInbound: async () => { calls.push("inbound"); },
    handleReply: async (_m: any, _e: any, t: string) => { calls.push("reply:" + t); },
  };
  const env = { REVERSE_PREFIX: "r." } as any;
  await routeEmail({ to: "r.abc@hidemyemail.dev" } as any, env, deps);
  await routeEmail({ to: "shop@hidemyemail.dev" } as any, env, deps);
  expect(calls).toEqual(["reply:abc", "inbound"]);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/email/router.ts`**

```ts
import type { Env } from "../types";
import { handleInbound as defInbound } from "./inbound";
import { handleReply as defReply } from "./reply";
import { parseReverse } from "../lib/reverse";

interface Deps {
  handleInbound: (m: ForwardableEmailMessage, env: Env) => Promise<void>;
  handleReply: (m: ForwardableEmailMessage, env: Env, token: string) => Promise<void>;
}

export async function routeEmail(
  message: ForwardableEmailMessage, env: Env,
  deps: Deps = { handleInbound: defInbound, handleReply: defReply }
): Promise<void> {
  const localPart = message.to.slice(0, message.to.lastIndexOf("@"));
  const token = parseReverse(localPart);
  if (token) return deps.handleReply(message, env, token);
  return deps.handleInbound(message, env);
}
```

- [ ] **Step 4: Update `worker/src/index.ts`** (`email` handler only; `fetch` replaced in Task 14)

```ts
import type { Env } from "./types";
import { routeEmail } from "./email/router";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await routeEmail(message, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run** `npx vitest run test/router.test.ts` → PASS

- [ ] **Step 6: Commit** — `git add worker/src/email/router.ts worker/src/index.ts worker/test/router.test.ts && git commit -m "feat: email router + email() wiring"`

---

### Task 11: Hono app + session middleware + auth routes

**Goal:** API skeleton with login/logout and a session guard.

**Files:**
- Create: `worker/src/api/app.ts`, `worker/src/api/routes/auth.ts`, `worker/test/api-auth.test.ts`

**Acceptance Criteria:**
- [ ] `POST /api/login` with correct password sets a `session` cookie; wrong password → 401.
- [ ] A guarded route returns 401 without a valid cookie, 200 with one.
- [ ] `POST /api/logout` clears the cookie.

**Verify:** `cd worker && npx vitest run test/api-auth.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/api-auth.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword } from "../src/lib/auth";

let testEnv: any;
beforeAll(async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  testEnv = { ...env, SESSION_SECRET: "sek", AUTH_PASSWORD_SALT: saltHex, AUTH_PASSWORD_HASH: hashHex };
});

test("login sets cookie; guarded route requires it", async () => {
  const app = createApp();
  const bad = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(bad.status).toBe(401);

  const ok = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(ok.status).toBe(200);
  const cookie = ok.headers.get("set-cookie")!;
  expect(cookie).toContain("session=");

  const noauth = await app.request("/api/stats", {}, testEnv);
  expect(noauth.status).toBe(401);

  const authed = await app.request("/api/stats", { headers: { cookie: cookie.split(";")[0] } }, testEnv);
  expect(authed.status).toBe(200);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/api/app.ts`**

```ts
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { verifySession } from "../lib/auth";
import { authRoutes } from "./routes/auth";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>();

  // public routes (no session)
  app.route("/api", authRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (p === "/api/login" || p === "/api/logout" || p === "/api/ses/notification") return next();
    const token = getCookie(c, "session");
    if (!token || !(await verifySession(c.env.SESSION_SECRET, token))) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // temporary guarded route so the auth test has an endpoint; replaced by real stats in Task 13
  app.get("/api/stats", (c) => c.json({ ok: true }));

  return app;
}
```

> NOTE: protected routers added in Tasks 12–14 are mounted AFTER the `app.use` guard so they inherit it. Keep the temporary `/api/stats` until Task 13 swaps in the real one.

- [ ] **Step 4: Write `worker/src/api/routes/auth.ts`**

```ts
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { verifyPassword, signSession } from "../../lib/auth";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/login", async (c) => {
    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
    const ok = await verifyPassword(password, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH);
    if (!ok) return c.json({ error: "invalid" }, 401);
    const token = await signSession(c.env.SESSION_SECRET, SESSION_TTL);
    setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
    return c.json({ ok: true });
  });

  r.post("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 5: Run** `npx vitest run test/api-auth.test.ts` → PASS

- [ ] **Step 6: Commit** — `git add worker/src/api worker/test/api-auth.test.ts && git commit -m "feat: Hono app, session guard, login/logout"`

---

### Task 12: Domains + aliases API routes

**Goal:** CRUD for domains and aliases (list with counters, create, patch, delete, events).

**Files:**
- Create: `worker/src/api/routes/domains.ts`, `worker/src/api/routes/aliases.ts`, `worker/test/api-aliases.test.ts`
- Modify: `worker/src/api/app.ts`

**Acceptance Criteria:**
- [ ] `GET /api/aliases` lists with counters; `POST` creates `source='dashboard'`.
- [ ] `PATCH /api/aliases/:id` updates active/destination/label; `DELETE` removes.
- [ ] `GET /api/domains` / `POST /api/domains` work.

**Verify:** `cd worker && npx vitest run test/api-aliases.test.ts test/api-auth.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/api-aliases.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "session=" + (await signSession("sek", 3600)); });
beforeEach(async () => { await resetDb(env.DB as D1Database); });

test("create domain, create + list + patch + delete alias", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };

  const cd = await app.request("/api/domains", { method: "POST", headers: h, body: JSON.stringify({ domain: "hidemyemail.dev", default_destination: "real@me.com" }) }, testEnv);
  expect(cd.status).toBe(200);
  const { id: domainId } = await cd.json<{ id: number }>();

  const ca = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: domainId, local_part: "shop", label: "shopping" }) }, testEnv);
  expect(ca.status).toBe(200);
  const alias = await ca.json<{ id: number; full_address: string; source: string }>();
  expect(alias.full_address).toBe("shop@hidemyemail.dev");
  expect(alias.source).toBe("dashboard");

  const list = await app.request("/api/aliases", { headers: { cookie } }, testEnv);
  expect((await list.json<any[]>()).length).toBe(1);

  const patch = await app.request(`/api/aliases/${alias.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ active: 0, destination: "work@me.com" }) }, testEnv);
  expect(patch.status).toBe(200);

  const del = await app.request(`/api/aliases/${alias.id}`, { method: "DELETE", headers: { cookie } }, testEnv);
  expect(del.status).toBe(200);
  const list2 = await app.request("/api/aliases", { headers: { cookie } }, testEnv);
  expect((await list2.json<any[]>()).length).toBe(0);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/api/routes/domains.ts`**

```ts
import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";

export function domainRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/domains", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM domains ORDER BY domain").all();
    return c.json(rows.results ?? []);
  });
  r.post("/domains", async (c) => {
    const { domain, default_destination } = await c.req.json<{ domain: string; default_destination: string }>();
    if (!domain || !default_destination) return c.json({ error: "missing fields" }, 400);
    const id = await q.createDomain(c.env.DB, domain.toLowerCase(), default_destination.toLowerCase());
    return c.json({ id, domain, default_destination });
  });
  return r;
}
```

- [ ] **Step 4: Write `worker/src/api/routes/aliases.ts`**

```ts
import { Hono } from "hono";
import type { AppEnv } from "../app";

export function aliasRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/aliases", async (c) => {
    const query = c.req.query("q");
    const sql = query
      ? "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.full_address LIKE ? ORDER BY a.created_at DESC LIMIT 500"
      : "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id ORDER BY a.created_at DESC LIMIT 500";
    const stmt = query ? c.env.DB.prepare(sql).bind(`%${query}%`) : c.env.DB.prepare(sql);
    const rows = await stmt.all();
    return c.json(rows.results ?? []);
  });

  r.post("/aliases", async (c) => {
    const b = await c.req.json<{ domain_id: number; local_part: string; destination?: string; label?: string }>();
    const dom = await c.env.DB.prepare("SELECT domain FROM domains WHERE id=?").bind(b.domain_id).first<{ domain: string }>();
    if (!dom) return c.json({ error: "unknown domain" }, 400);
    if (b.local_part.startsWith("r.")) return c.json({ error: "reserved prefix" }, 400);
    const full = `${b.local_part.toLowerCase()}@${dom.domain}`;
    const row = await c.env.DB.prepare(
      "INSERT INTO aliases (domain_id, local_part, full_address, destination, label, active, source, created_at) " +
      "VALUES (?,?,?,?,?,1,'dashboard',?) RETURNING *"
    ).bind(b.domain_id, b.local_part.toLowerCase(), full, b.destination ?? null, b.label ?? null, Date.now()).first();
    return c.json(row);
  });

  r.patch("/aliases/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json<{ active?: number; destination?: string | null; label?: string | null }>();
    const sets: string[] = []; const vals: unknown[] = [];
    if (b.active !== undefined) { sets.push("active=?"); vals.push(b.active); }
    if (b.destination !== undefined) { sets.push("destination=?"); vals.push(b.destination); }
    if (b.label !== undefined) { sets.push("label=?"); vals.push(b.label); }
    if (!sets.length) return c.json({ error: "no fields" }, 400);
    vals.push(id);
    await c.env.DB.prepare(`UPDATE aliases SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return c.json({ ok: true });
  });

  r.delete("/aliases/:id", async (c) => {
    const id = Number(c.req.param("id"));
    await c.env.DB.prepare("DELETE FROM reverse_map WHERE alias_id=?").bind(id).run();
    await c.env.DB.prepare("DELETE FROM aliases WHERE id=?").bind(id).run();
    return c.json({ ok: true });
  });

  r.get("/aliases/:id/events", async (c) => {
    const id = Number(c.req.param("id"));
    const rows = await c.env.DB.prepare("SELECT * FROM events WHERE alias_id=? ORDER BY ts DESC LIMIT 200").bind(id).all();
    return c.json(rows.results ?? []);
  });

  return r;
}
```

- [ ] **Step 5: Mount in `worker/src/api/app.ts`** — add imports and, AFTER the `app.use` guard (keep the temporary `/api/stats` line for now):

```ts
import { domainRoutes } from "./routes/domains";
import { aliasRoutes } from "./routes/aliases";
// ...after app.use("/api/*", guard):
app.route("/api", domainRoutes());
app.route("/api", aliasRoutes());
```

- [ ] **Step 6: Run** `npx vitest run test/api-aliases.test.ts test/api-auth.test.ts` → PASS

- [ ] **Step 7: Commit** — `git add worker/src/api worker/test/api-aliases.test.ts && git commit -m "feat: domains + aliases API routes"`

---

### Task 13: Blocks + stats API routes

**Goal:** Manage block rules and expose dashboard stats.

**Files:**
- Create: `worker/src/api/routes/blocks.ts`, `worker/src/api/routes/stats.ts`, `worker/test/api-stats.test.ts`
- Modify: `worker/src/api/app.ts` (remove placeholder `/api/stats`, mount real routers)

**Acceptance Criteria:**
- [ ] `POST /api/blocks` / `DELETE /api/blocks/:id` work.
- [ ] `GET /api/stats` returns totals, 24h breakdown, top aliases.

**Verify:** `cd worker && npx vitest run test/api-stats.test.ts test/api-auth.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/api-stats.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "session=" + (await signSession("sek", 3600)); });
beforeEach(async () => { await resetDb(env.DB as D1Database); });

test("stats returns totals and 24h breakdown", async () => {
  const app = createApp();
  const d = await q.createDomain(env.DB as D1Database, "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(env.DB as D1Database, d, "shop", "shop@hidemyemail.dev");
  await q.insertEvent(env.DB as D1Database, { alias_id: a.id, type: "forward", ts: Date.now() });
  const res = await app.request("/api/stats", { headers: { cookie } }, testEnv);
  const stats = await res.json<any>();
  expect(stats.totals.aliases).toBe(1);
  expect(stats.last24h.forward).toBe(1);
});

test("create + delete block rule", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };
  const create = await app.request("/api/blocks", { method: "POST", headers: h, body: JSON.stringify({ pattern: "*@spam.com" }) }, testEnv);
  expect(create.status).toBe(200);
  const { id } = await create.json<{ id: number }>();
  const del = await app.request(`/api/blocks/${id}`, { method: "DELETE", headers: { cookie } }, testEnv);
  expect(del.status).toBe(200);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/api/routes/blocks.ts`**

```ts
import { Hono } from "hono";
import type { AppEnv } from "../app";

export function blockRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/blocks", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM blocks ORDER BY created_at DESC").all();
    return c.json(rows.results ?? []);
  });
  r.post("/blocks", async (c) => {
    const b = await c.req.json<{ alias_id?: number | null; pattern: string }>();
    if (!b.pattern) return c.json({ error: "missing pattern" }, 400);
    const row = await c.env.DB.prepare("INSERT INTO blocks (alias_id, pattern, created_at) VALUES (?,?,?) RETURNING id")
      .bind(b.alias_id ?? null, b.pattern.toLowerCase(), Date.now()).first<{ id: number }>();
    return c.json(row);
  });
  r.delete("/blocks/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM blocks WHERE id=?").bind(Number(c.req.param("id"))).run();
    return c.json({ ok: true });
  });
  return r;
}
```

- [ ] **Step 4: Write `worker/src/api/routes/stats.ts`**

```ts
import { Hono } from "hono";
import type { AppEnv } from "../app";

export function statsRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/stats", async (c) => {
    const db = c.env.DB;
    const since = Date.now() - 24 * 3600_000;
    const aliases = await db.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>();
    const active = await db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE active=1").first<{ n: number }>();
    const byType = await db.prepare("SELECT type, COUNT(*) AS n FROM events WHERE ts>=? GROUP BY type").bind(since).all<{ type: string; n: number }>();
    const top = await db.prepare("SELECT full_address, fwd_count, reply_count, blocked_count FROM aliases ORDER BY fwd_count DESC LIMIT 10").all();
    const last24h: Record<string, number> = { forward: 0, reply: 0, block: 0, reject: 0, error: 0 };
    for (const row of byType.results ?? []) last24h[row.type] = row.n;
    return c.json({ totals: { aliases: aliases?.n ?? 0, active: active?.n ?? 0 }, last24h, topAliases: top.results ?? [] });
  });
  return r;
}
```

- [ ] **Step 5: Update `worker/src/api/app.ts`** — delete the temporary `app.get("/api/stats", ...)` and mount real routers (after the guard):

```ts
import { blockRoutes } from "./routes/blocks";
import { statsRoutes } from "./routes/stats";
// after domain/alias routes:
app.route("/api", blockRoutes());
app.route("/api", statsRoutes());
```

- [ ] **Step 6: Run** `npx vitest run test/api-stats.test.ts test/api-auth.test.ts` → PASS (auth test still green — `/api/stats` is now the real guarded route)

- [ ] **Step 7: Commit** — `git add worker/src/api worker/test/api-stats.test.ts && git commit -m "feat: blocks + stats API routes"`

---

### Task 14: SES SNS webhook + fetch handler wiring

**Goal:** Accept SES bounce/complaint notifications (via SNS) and wire the Hono app into `index.ts` `fetch()`.

**Files:**
- Create: `worker/src/api/routes/ses-webhook.ts`, `worker/test/ses-webhook.test.ts`
- Modify: `worker/src/api/app.ts`, `worker/src/index.ts`

**Acceptance Criteria:**
- [ ] `POST /api/ses/notification` handles `SubscriptionConfirmation` (logs URL) and `Notification` (records bounce/complaint as `error` event).
- [ ] Rejects messages whose `TopicArn` ≠ `SNS_ALLOWED_TOPIC_ARN`.
- [ ] `index.ts` `fetch()` delegates to `createApp().fetch`.

**Verify:** `cd worker && npx vitest run` → all PASS

**Steps:**

- [ ] **Step 1: Write `worker/test/ses-webhook.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";

const ARN = "arn:aws:sns:us-east-1:123:ses-notifs";
const testEnv = () => ({ ...env, SNS_ALLOWED_TOPIC_ARN: ARN });

beforeEach(async () => { await (env.DB as D1Database).prepare("DELETE FROM events").run(); });

test("rejects wrong topic arn", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: "arn:other", Message: "{}" }),
  }, testEnv());
  expect(res.status).toBe(403);
});

test("records a bounce notification as error event", async () => {
  const app = createApp();
  const message = JSON.stringify({ notificationType: "Bounce", bounce: { bouncedRecipients: [{ emailAddress: "x@y.com" }] } });
  const res = await app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: ARN, Message: message }),
  }, testEnv());
  expect(res.status).toBe(200);
  const row = await (env.DB as D1Database).prepare("SELECT COUNT(*) AS n FROM events WHERE type='error'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `worker/src/api/routes/ses-webhook.ts`**

```ts
import { Hono } from "hono";
import type { AppEnv } from "../app";

// SNS posts JSON (often Content-Type text/plain). We validate TopicArn and (prod TODO)
// the SNS signature. SubscriptionConfirmation logs SubscribeURL for one-time manual confirm.
export function sesWebhookRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/ses/notification", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);
    if (c.env.SNS_ALLOWED_TOPIC_ARN && body.TopicArn !== c.env.SNS_ALLOWED_TOPIC_ARN) {
      return c.json({ error: "forbidden topic" }, 403);
    }
    if (body.Type === "SubscriptionConfirmation") {
      console.log("SNS SubscribeURL:", body.SubscribeURL);
      return c.json({ ok: true });
    }
    if (body.Type === "Notification") {
      const msg = JSON.parse(body.Message);
      const kind = msg.notificationType ?? msg.eventType ?? "unknown";
      await c.env.DB.prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'error', ?, ?)")
        .bind(`ses:${kind}`, Date.now()).run();
      return c.json({ ok: true });
    }
    return c.json({ ok: true });
  });
  return r;
}
```

> NOTE (prod hardening — tracked in DEPLOY §8): verify the SNS message signature against the AWS `SigningCertURL` before trusting it. The TopicArn allow-list is the minimum gate; signature verification is the real one. Deferred because it needs fetch+cache of the AWS cert and X.509 verification.

- [ ] **Step 4: Mount in `worker/src/api/app.ts`** — BEFORE the `app.use` guard (SNS has no cookie; guard already whitelists the path):

```ts
import { sesWebhookRoutes } from "./routes/ses-webhook";
// immediately after `app.route("/api", authRoutes());`:
app.route("/api", sesWebhookRoutes());
```

- [ ] **Step 5: Update `worker/src/index.ts`**

```ts
import type { Env } from "./types";
import { routeEmail } from "./email/router";
import { createApp } from "./api/app";

const app = createApp();

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await routeEmail(message, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run full suite** `npx vitest run` → all PASS

- [ ] **Step 7: Commit** — `git add worker/src worker/test/ses-webhook.test.ts && git commit -m "feat: SES SNS webhook + fetch wiring"`

---

### Task 15: Dashboard scaffold + API client + auth

**Goal:** A Vite React app that logs in and holds session state.

**Files:**
- Create: `dashboard/package.json`, `dashboard/vite.config.ts`, `dashboard/tsconfig.json`, `dashboard/index.html`, `dashboard/src/main.tsx`, `dashboard/src/api.ts`, `dashboard/src/auth.tsx`, `dashboard/src/App.tsx`, `dashboard/src/pages/Login.tsx`, plus stub pages `Aliases.tsx`/`Blocks.tsx`/`Stats.tsx`

**Acceptance Criteria:**
- [ ] `npm run build` in `dashboard/` produces `dist/index.html`.
- [ ] Login posts to `/api/login` with `credentials: "include"`.
- [ ] Unauthed users see Login; authed users see the app shell.

**Verify:** `cd dashboard && npm install && npm run build` → `dist/index.html` exists.

**Steps:**

- [ ] **Step 1: Create `dashboard/package.json`**

```json
{
  "name": "hidemyemail-dashboard",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build", "preview": "vite preview" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.6.0", "vite": "^5.4.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0" }
}
```

- [ ] **Step 2: Create `dashboard/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
```

- [ ] **Step 3: Create `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020", "useDefineForClassFields": true, "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx",
    "strict": true, "noUnusedLocals": true, "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `dashboard/index.html`**

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>hidemyemail</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 5: Create `dashboard/src/api.ts`**

```ts
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}
export const api = {
  login: (password: string) => req<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout", { method: "POST" }),
  stats: () => req<any>("/api/stats"),
  domains: () => req<any[]>("/api/domains"),
  createDomain: (domain: string, default_destination: string) => req("/api/domains", { method: "POST", body: JSON.stringify({ domain, default_destination }) }),
  aliases: (q = "") => req<any[]>(`/api/aliases${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createAlias: (b: { domain_id: number; local_part: string; destination?: string; label?: string }) => req("/api/aliases", { method: "POST", body: JSON.stringify(b) }),
  patchAlias: (id: number, b: Record<string, unknown>) => req(`/api/aliases/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteAlias: (id: number) => req(`/api/aliases/${id}`, { method: "DELETE" }),
  events: (id: number) => req<any[]>(`/api/aliases/${id}/events`),
  blocks: () => req<any[]>("/api/blocks"),
  createBlock: (pattern: string, alias_id?: number) => req("/api/blocks", { method: "POST", body: JSON.stringify({ pattern, alias_id }) }),
  deleteBlock: (id: number) => req(`/api/blocks/${id}`, { method: "DELETE" }),
};
```

- [ ] **Step 6: Create `dashboard/src/auth.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

const Ctx = createContext<{ authed: boolean; setAuthed: (v: boolean) => void }>({ authed: false, setAuthed: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  useEffect(() => { api.stats().then(() => setAuthed(true)).catch(() => setAuthed(false)); }, []);
  return <Ctx.Provider value={{ authed, setAuthed }}>{children}</Ctx.Provider>;
}
```

- [ ] **Step 7: Create `dashboard/src/pages/Login.tsx`**

```tsx
import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

export function Login() {
  const { setAuthed } = useAuth();
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api.login(pw); setAuthed(true); } catch { setErr("Invalid password"); }
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "10vh auto", display: "grid", gap: 12 }}>
      <h1>hidemyemail</h1>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus />
      <button type="submit">Sign in</button>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
    </form>
  );
}
```

- [ ] **Step 8: Create stub pages** `dashboard/src/pages/Aliases.tsx`, `Blocks.tsx`, `Stats.tsx` (real content in Task 16):

```tsx
export function Aliases() { return <div>aliases</div>; }
```
```tsx
export function Blocks() { return <div>blocks</div>; }
```
```tsx
export function Stats() { return <div>stats</div>; }
```

- [ ] **Step 9: Create `dashboard/src/App.tsx`**

```tsx
import { useState } from "react";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { Aliases } from "./pages/Aliases";
import { Blocks } from "./pages/Blocks";
import { Stats } from "./pages/Stats";
import { api } from "./api";

export function App() {
  const { authed, setAuthed } = useAuth();
  const [tab, setTab] = useState<"aliases" | "blocks" | "stats">("aliases");
  if (!authed) return <Login />;
  return (
    <div style={{ maxWidth: 900, margin: "2rem auto", fontFamily: "system-ui" }}>
      <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button onClick={() => setTab("aliases")}>Aliases</button>
        <button onClick={() => setTab("blocks")}>Blocks</button>
        <button onClick={() => setTab("stats")}>Stats</button>
        <button style={{ marginLeft: "auto" }} onClick={async () => { await api.logout(); setAuthed(false); }}>Logout</button>
      </nav>
      {tab === "aliases" && <Aliases />}
      {tab === "blocks" && <Blocks />}
      {tab === "stats" && <Stats />}
    </div>
  );
}
```

- [ ] **Step 10: Create `dashboard/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./auth";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><AuthProvider><App /></AuthProvider></StrictMode>
);
```

- [ ] **Step 11: Build** `cd dashboard && npm install && npm run build` → `dist/index.html` exists.

- [ ] **Step 12: Commit** — `git add dashboard && git commit -m "feat: dashboard scaffold with auth + API client"`

---

### Task 16: Dashboard pages (aliases, blocks, stats)

**Goal:** Functional management UI.

**Files:**
- Modify: `dashboard/src/pages/Aliases.tsx`, `dashboard/src/pages/Blocks.tsx`, `dashboard/src/pages/Stats.tsx`

**Acceptance Criteria:**
- [ ] Aliases page lists with counters, toggles active, edits destination/label, deletes, creates dashboard aliases.
- [ ] Blocks page lists/creates/deletes patterns.
- [ ] Stats page shows totals, 24h breakdown, top aliases.
- [ ] `npm run build` passes.

**Verify:** `cd dashboard && npm run build` → success.

**Steps:**

- [ ] **Step 1: Write `dashboard/src/pages/Aliases.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";

export function Aliases() {
  const [rows, setRows] = useState<any[]>([]);
  const [domains, setDomains] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ domain_id: 0, local_part: "", destination: "", label: "" });

  async function load() { setRows(await api.aliases(q)); }
  useEffect(() => { api.domains().then((d) => { setDomains(d); setForm((f) => ({ ...f, domain_id: d[0]?.id ?? 0 })); }); }, []);
  useEffect(() => { load(); }, [q]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await api.createAlias({ domain_id: Number(form.domain_id), local_part: form.local_part, destination: form.destination || undefined, label: form.label || undefined });
    setForm((f) => ({ ...f, local_part: "", destination: "", label: "" }));
    load();
  }

  return (
    <div>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <select value={form.domain_id} onChange={(e) => setForm({ ...form, domain_id: Number(e.target.value) })}>
          {domains.map((d) => <option key={d.id} value={d.id}>@{d.domain}</option>)}
        </select>
        <input placeholder="local part" value={form.local_part} onChange={(e) => setForm({ ...form, local_part: e.target.value })} required />
        <input placeholder="destination (optional)" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
        <input placeholder="label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <button type="submit">Create</button>
      </form>
      <input placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12, width: "100%" }} />
      <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          <th>Alias</th><th>Dest</th><th>Fwd</th><th>Reply</th><th>Blocked</th><th>Active</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{a.full_address}{a.label ? ` (${a.label})` : ""}</td>
              <td>{a.destination ?? <em>default</em>}</td>
              <td>{a.fwd_count}</td><td>{a.reply_count}</td><td>{a.blocked_count}</td>
              <td><input type="checkbox" checked={!!a.active} onChange={async (e) => { await api.patchAlias(a.id, { active: e.target.checked ? 1 : 0 }); load(); }} /></td>
              <td><button onClick={async () => { if (confirm(`Delete ${a.full_address}?`)) { await api.deleteAlias(a.id); load(); } }}>x</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Write `dashboard/src/pages/Blocks.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";

export function Blocks() {
  const [rows, setRows] = useState<any[]>([]);
  const [pattern, setPattern] = useState("");
  async function load() { setRows(await api.blocks()); }
  useEffect(() => { load(); }, []);
  return (
    <div>
      <form onSubmit={async (e) => { e.preventDefault(); await api.createBlock(pattern); setPattern(""); load(); }} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input placeholder="*@spam.com or evil@x.com" value={pattern} onChange={(e) => setPattern(e.target.value)} required style={{ flex: 1 }} />
        <button type="submit">Block</button>
      </form>
      <ul>{rows.map((b) => (
        <li key={b.id}>{b.pattern} {b.alias_id ? `(alias ${b.alias_id})` : "(global)"} <button onClick={async () => { await api.deleteBlock(b.id); load(); }}>x</button></li>
      ))}</ul>
    </div>
  );
}
```

- [ ] **Step 3: Write `dashboard/src/pages/Stats.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";

export function Stats() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.stats().then(setS); }, []);
  if (!s) return <div>Loading...</div>;
  return (
    <div>
      <p>Aliases: {s.totals.aliases} ({s.totals.active} active)</p>
      <h3>Last 24h</h3>
      <ul>{Object.entries(s.last24h).map(([k, v]) => <li key={k}>{k}: {v as number}</li>)}</ul>
      <h3>Top aliases (by forwards)</h3>
      <ol>{s.topAliases.map((a: any) => <li key={a.full_address}>{a.full_address} — {a.fwd_count} fwd / {a.reply_count} reply</li>)}</ol>
    </div>
  );
}
```

- [ ] **Step 4: Build** `cd dashboard && npm run build` → success.

- [ ] **Step 5: Commit** — `git add dashboard/src/pages && git commit -m "feat: dashboard aliases/blocks/stats pages"`

---

### Task 17: Deployment, DNS, secrets, README

**Goal:** Document and script the full deploy.

**Files:**
- Create: `docs/DEPLOY.md`, `worker/scripts/hash-password.mjs`, `README.md`

**Acceptance Criteria:**
- [ ] `DEPLOY.md` covers D1 create + migrate, secrets, SES verify + SNS, DNS, Pages, per-domain catch-all routes, and the spec §10 pre-prod checklist.
- [ ] `hash-password.mjs` prints `AUTH_PASSWORD_SALT` + `AUTH_PASSWORD_HASH`.

**Verify:** `node worker/scripts/hash-password.mjs testpw` prints two hex lines; read-through of `DEPLOY.md`.

**Steps:**

- [ ] **Step 1: Write `worker/scripts/hash-password.mjs`** (Node ≥18 has WebCrypto global)

```js
const password = process.argv[2];
if (!password) { console.error("usage: node hash-password.mjs <password>"); process.exit(1); }
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
console.log("AUTH_PASSWORD_SALT=" + hex(salt.buffer));
console.log("AUTH_PASSWORD_HASH=" + hex(bits));
```

- [ ] **Step 2: Write `docs/DEPLOY.md`**

````markdown
# Deploy — hidemyemail.dev

## 1. D1
```bash
cd worker
npx wrangler d1 create hidemyemail          # paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply hidemyemail --remote
```

## 2. Secrets (Worker)
```bash
node scripts/hash-password.mjs 'YOUR_PASSWORD'   # prints SALT + HASH
npx wrangler secret put AUTH_PASSWORD_SALT
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET           # e.g. openssl rand -hex 32
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
npx wrangler secret put SNS_ALLOWED_TOPIC_ARN
```

## 3. Seed first domain
After deploying the Worker (step 7), add the domain from the dashboard (Domains form)
or via the D1 console in the Cloudflare dashboard:
`INSERT INTO domains (domain, default_destination, active, created_at) VALUES ('hidemyemail.dev','YOUR_REAL@inbox.com',1, <epoch_ms>)`

## 4. SES (already production)
- Verify each sending domain D in SES; add the 3 DKIM CNAMEs to that zone.
- Optional custom MAIL FROM `bounce.D` for a cleaner Return-Path.
- Create an SNS topic; subscribe `https://<worker-host>/api/ses/notification` (HTTPS).
  On first POST the Worker logs `SubscribeURL` — open it once to confirm.
- Set `SNS_ALLOWED_TOPIC_ARN`. Configure the SES identity to publish Bounce + Complaint to the topic.

## 5. DNS per domain D
- Enable Cloudflare Email Routing on D (adds MX + TXT).
- SPF TXT includes `include:amazonses.com`.
- DMARC: `_dmarc.D TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@D"`.
- SES DKIM CNAMEs (step 4).

## 6. Catch-all route per domain
For each domain D: Email Routing → Routes → Catch-all → send to Worker `hidemyemail`.
One Worker serves all domains; it resolves the domain from `message.to`.

## 7. Deploy Worker + Dashboard
```bash
cd worker && npx wrangler deploy
cd ../dashboard && npm run build && npx wrangler pages deploy dist --project-name hidemyemail-dashboard
```
Serve the dashboard same-origin as the API: add a Worker route `app.hidemyemail.dev/api/*`
to the Worker, and point `app.hidemyemail.dev` at the Pages project for the static SPA.

## 8. Pre-production verification (spec §10)
- [ ] Thrown exception in `email()` → sender gets tempfail + retries? (test: break SES creds, send, observe)
- [ ] 25 MB inbound → base64 (~33 MB) accepted by SES (< 40 MB)?
- [ ] SES sending quota vs expected volume (catch-all spam included).
- [ ] aws4fetch SES request signs with `service=ses` and succeeds live.
- [ ] Multi-zone catch-all all reach the one Worker.
- [ ] SNS signature verification implemented before trusting notifications.
- [ ] E2E: send → alias → inbox shows `"X via alias" <r.token@D>`; reply → external receives from alias; real address absent from headers.
````

- [ ] **Step 3: Write `README.md`**

```markdown
# hidemyemail.dev

Personal serverless email-alias service: Cloudflare Email Routing + Worker + Amazon SES + D1, with a React dashboard on Pages. Full two-way reply-from-alias.

- Design: `docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md`
- Plan: `docs/superpowers/plans/2026-05-24-hidemyemail-alias-service.md`
- Deploy: `docs/DEPLOY.md`

## Dev
- `cd worker && npm install && npm test` — worker test suite
- `cd worker && npx wrangler dev` — local worker (email + api)
- `cd dashboard && npm install && npm run dev` — dashboard against local worker
```

- [ ] **Step 4: Verify** `node worker/scripts/hash-password.mjs testpw` prints `AUTH_PASSWORD_SALT=...` and `AUTH_PASSWORD_HASH=...`.

- [ ] **Step 5: Commit** — `git add docs/DEPLOY.md worker/scripts README.md && git commit -m "docs: deploy guide, password hasher, README"`

---

## Self-Review Notes

- **Spec coverage:** domains/aliases/per-alias dest (T1,T2,T12) · catch-all auto-create (T2,T8) · reverse-alias 2-way (T6,T8,T9) · SES re-inject (T5,T8) · blocks (T3,T8,T13) · rate (T2,T8) · stats/events (T2,T13) · auth (T7,T11) · dashboard (T15,T16) · SNS bounces (T14) · DNS/deploy (T17). All spec sections mapped.
- **Security:** owner-destination check (T9), random 120-bit token (T6), secrets via wrangler (T17), pre-SES guards (T8), leak scrub (T9), SNS topic gate + signature-verify follow-up (T14/DEPLOY §8).
- **Type consistency:** `Env`, `AliasRow`, `ReverseRow` (T0) → used throughout; `sendRaw`/`SesTransientError` (T5) → T8/T9; `parseReverse`/`reverseAddress` (T6) → T8/T10; `resetDb` (T1) → all DB tests; `createApp` (T11) → T12–14 + index (T14).
- **Hook note:** tests avoid D1 `.exec("…;…")` batch strings (which trip the repo's `exec(`-pattern security hook); use `resetDb` with `prepare().run()` instead.
- **Known intentional follow-ups (documented, not placeholders):** SNS signature verification (T14 note + DEPLOY §8), same-origin API/Pages routing (DEPLOY §7).
````
