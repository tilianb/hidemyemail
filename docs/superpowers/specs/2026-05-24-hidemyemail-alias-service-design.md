# hidemyemail.dev — Serverless Email Alias Service (Design Spec)

**Date:** 2026-05-24
**Status:** Approved (design) — pending implementation plan
**Replaces:** self-hosted addy.io (AnonAddy) Docker stack (app + MariaDB + Redis + Postfix + rspamd on OCI). That stack is decommissioned after cutover.

---

## 1. Goal

A personal, serverless email alias service with **full two-way reply-from-alias**, replacing the self-hosted addy.io install. Built on **Cloudflare Email Routing (inbound) + a single Cloudflare Worker + Amazon SES (outbound) + D1 + a React/Vite dashboard on Cloudflare Pages**. No mail server, no Postfix, no VM to maintain.

### Non-goals (explicitly out of scope)
- Multi-user / public signups / billing (single owner only).
- PGP encryption of forwarded mail.
- Send-as-alias compose of brand-new mail (only inbound forwarding + replies to received mail).
- Migration of existing aliases (fresh start; old install discarded).
- CF Queues / async buffering (Workers Paid; volume does not justify it).

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Audience | Personal, single owner | Simplest auth + schema. |
| Outbound | Full 2-way reply-from-alias | Core value; SES prod account already available. |
| Alias creation | Catch-all auto-create **+** dashboard CRUD | Invent aliases on the spot; manage after. |
| Domains | Multiple CF zones | Compartmentalize by domain. |
| Destination | Per-alias, falling back to per-domain default | Flexibility (work/personal inboxes). |
| Inbound delivery | **SES re-inject (naive-A)** for ALL inbound | Only path to native-client reply-from-alias (`forward()` permits only `X-*` headers). Risk accepted. |
| Features | Sender block/rules, stats/activity log, bandwidth/rate limits | Picked. PGP dropped. |
| Auth | Built-in password + signed session cookie | Owner-controlled; no external dependency. |
| Stack | React/Vite SPA (Pages) + Hono API/email Worker + D1 | Richer UI; one Worker does `email()` + `fetch()`. |
| Topology | Approach A: single Worker | Cheapest, simplest; can split to two Workers later. |

### Accepted risk — SES reputation (naive-A)
Catch-all receives spam to random aliases. Re-injecting **all** inbound through SES makes those sends count against the SES account; spam complaints could throttle/suspend it. **Mitigations built in:** sender blocks + rate limits run **before** any SES call, so blocked/throttled mail never touches SES. Future option: hybrid routing (SES only for clean mail to active aliases, CF `forward()`/drop for the rest).

---

## 3. Architecture

```
DOMAINS (N CF zones)   hidemyemail.dev + others
  each: MX → Cloudflare Email Routing → catch-all route → Mail Worker

┌──────────────────────────────────────────────┐
│ MAIL WORKER (single Worker, Workers Free)      │
│   email()  inbound + reverse-alias replies     │
│   fetch()  dashboard JSON API (Hono)           │
│   bindings: D1, secrets (SES creds, SESSION    │
│             SECRET, AUTH_PASSWORD_HASH)         │
└──────────────────────────────────────────────┘
     │ D1 (SQLite)            │ HTTPS SigV4 (aws4fetch)
     ▼                        ▼
 domains, aliases,        Amazon SES (prod)
 reverse_map,             SendRawEmail
 blocks, events                ▲
     ▲                         │ SNS webhook (bounces/complaints)
     │ JSON API (session cookie)
┌─────────────────────────┐
│ DASHBOARD SPA            │ React/Vite on Cloudflare Pages
│ app.hidemyemail.dev      │ login → aliases / blocks / stats
└─────────────────────────┘
```

**Components**
1. **Mail Worker** — single deployable, two handlers. `email()` handles receive→rewrite→SES-deliver and reverse-alias reply→SES-send. `fetch()` serves the Hono JSON API.
2. **D1** — all persistent state.
3. **SES** — outbound `SendRawEmail` over HTTPS, signed with `aws4fetch`. Used for (a) re-injecting inbound to the real inbox with rewritten `From`, (b) sending replies as the alias.
4. **Dashboard SPA** — React/Vite on Pages; password + session auth; calls the Worker API.
5. **DNS per domain** — MX → CF Email Routing; SES DKIM CNAMEs; SPF `include:amazonses.com`; DMARC.

**Cost:** Workers Free + D1 free tier + Pages free + SES at ~$0.10 / 1000 messages. SES is used via HTTPS (`aws4fetch`), **not** the CF `send_email` binding, so Workers Paid is not required.

---

## 4. Data model (D1)

```sql
CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  default_destination TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE aliases (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id),
  local_part TEXT NOT NULL,
  full_address TEXT UNIQUE NOT NULL,
  destination TEXT,                         -- NULL → domains.default_destination
  label TEXT,
  active INTEGER DEFAULT 1,
  source TEXT NOT NULL,                      -- 'auto' | 'dashboard'
  fwd_count INTEGER DEFAULT 0,
  blocked_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE reverse_map (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,                -- ~120-bit random; reply-back local-part
  alias_id INTEGER NOT NULL REFERENCES aliases(id),
  external_sender TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(alias_id, external_sender)          -- stable token per pair → threading
);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  alias_id INTEGER REFERENCES aliases(id),   -- NULL = global
  pattern TEXT NOT NULL,                      -- "x@y.com" or "*@y.com"
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  alias_id INTEGER REFERENCES aliases(id),
  type TEXT NOT NULL,                         -- forward|reply|block|reject|error
  external_sender TEXT,
  subject TEXT,                              -- optional; may be disabled for privacy
  bytes INTEGER,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_alias ON events(alias_id, ts);
```

**Notes**
- **Rate limits** derived from `events` (`COUNT(*) WHERE ts > now-3600`), per-alias and global. No separate table (indexes cover it). Add a counter table only if `events` volume forces it (YAGNI now).
- **Auth**: no users table. Password **hash** in a Worker secret (`AUTH_PASSWORD_HASH`, PBKDF2 via WebCrypto). Session = signed cookie (HMAC with `SESSION_SECRET` + expiry), stateless. Optional `sessions` table later for remote logout.
- `full_address` denormalized for O(1) inbound lookup.

---

## 5. Data flows

### 5.1 Inbound (external → alias → your inbox)
`email(message)` fires from a catch-all route; `message.to = local@D`.

1. If local-part has prefix `r.` → look up `reverse_map(token)`; hit → **Flow 5.2**. Miss → continue.
2. `domains` lookup(D). Unknown/inactive → drop + log.
3. `aliases` lookup(full_address). Not found → **auto-create** (`source='auto'`, `active=1`, `destination=NULL`).
4. `alias.active == 0` → **silent drop** + log `reject` (no existence oracle).
5. **Block check** (global + alias patterns, glob). Match → drop, `blocked_count++`, log `block`. *(pre-SES)*
6. **Rate check** (events last 1h, per-alias + global). Over limit → drop + log. *(pre-SES)*
7. Size: `rawSize > 25 MB` → drop + log (CF inbound ceiling).
8. `dest = alias.destination ?? domain.default_destination`.
9. `reverse_map` get-or-create `(alias_id, external=message.from)` → `token` (stable per pair).
10. **Header surgery** on raw MIME:
    - `From:` → `"{origName} via {alias}" <r.{token}@D>`
    - `Reply-To: r.{token}@D`
    - strip `DKIM-Signature`, `ARC-*`, `Return-Path`
    - add `X-Reinjected: 1` (loop guard; `X-` allowed)
    - keep `Subject`, `To`, `Date`, `Message-ID`, body/attachments untouched
11. **SES SendRawEmail** → `dest`. MAIL FROM = `bounce@D`. SigV4 via `aws4fetch`.
12. Success → log `forward`, `fwd_count++`, `last_seen_at=now`.
    Transient SES error → **throw** → CF tempfails → sender MTA retries.
    Permanent error → log `error`, drop.

### 5.2 Reply (you → reverse-alias → external, as alias)
Your reply from the real inbox lands at `r.{token}@D`.

1. `reverse_map` lookup(token) → `alias_id`, `external_sender`.
2. **Security**: envelope `message.from` ∈ **owner destinations**? No → reject + log.
   *("Owner destinations" = the set of all configured destination addresses: every `domains.default_destination` plus every non-NULL `aliases.destination`. Only mail originating from one of your own real inboxes may drive a reverse-alias send.)*
3. Resolve `alias.full_address`.
4. **Build MIME**:
   - `From: {alias.full_address}`  `To: {external_sender}`
   - `Subject:` from your reply; body from `message.raw`
   - preserve `In-Reply-To` / `References` (threading)
   - **strip everything leaking the real address**: original `From`/`Sender`/`Return-Path`/your DKIM
   - `Message-ID` under D
5. **SES SendRawEmail** → `external_sender`. `From = alias@D`, DKIM aligned (D).
6. Success → log `reply`, `reply_count++`, `last_used_at=now`. Errors as in 5.1.

### 5.3 Reverse-alias scheme
`r.{token}@D`, `token` = 24-char base32 (~120-bit random). Prefix `r.` routes fast; `reverse_map` is source of truth. Same domain `D` so SES DKIM aligns. local-part ≈ 26 chars (< 64 limit). Real aliases beginning with `r.` are rejected to avoid namespace clash.

---

## 6. Security model

1. Reverse token = unguessable 120-bit capability → no relay by guessing.
2. Reply requires envelope-from ∈ owner destinations → leaked token still unusable by others.
3. SES creds + `SESSION_SECRET` + `AUTH_PASSWORD_HASH` = Worker secrets (`wrangler secret`), never in source.
4. Block + rate checks run **before** SES → guard reputation and cost.
5. Disabled alias = silent drop (no existence oracle).
6. Reply path strips all real-address headers → real inbox never exposed to the external party.
7. SNS bounce/complaint webhook verifies SNS signature before acting.
8. Dashboard API: session middleware on all routes except `/login` and `/ses/notification`.

---

## 7. Dashboard API (Hono, `fetch` handler)

```
POST   /api/login {password}        → signed session cookie
POST   /api/logout
GET    /api/domains
POST   /api/domains {domain, default_destination}
GET    /api/aliases?domain=&q=&page=
POST   /api/aliases {local_part, domain_id, destination?, label?}
PATCH  /api/aliases/:id {active?, destination?, label?}
DELETE /api/aliases/:id
GET    /api/aliases/:id/events
POST   /api/blocks {alias_id?, pattern}
DELETE /api/blocks/:id
GET    /api/stats                   → totals, last 24h, top aliases
POST   /api/ses/notification        → SNS bounce/complaint webhook (sig-verified)
```

Session middleware guards everything except `/api/login` and `/api/ses/notification`.

---

## 8. Error handling

- **SES transient** (throttle / 5xx) → throw in `email()` → CF tempfail → sender retries. *(Verify CF retry-on-throw behavior during testing.)*
- **SES permanent** (4xx) → log + drop (avoid retry storm).
- **Bounces/complaints** → SES → SNS → `/api/ses/notification` → log; hard bounce on **your destination** → flag/disable it.
- **Loops** → drop inbound carrying `X-Reinjected`; cap `References` hop count.
- **D1 failure / malformed MIME** → throw → tempfail → retry; surgery fallback logs + rejects.

---

## 9. Testing strategy

- **Unit**: header surgery (From rewrite, DKIM strip), reverse token gen/lookup, glob block match, rate calc, session sign/verify, SigV4 request shape (`aws4fetch`), real-address leak scrub.
- **Integration**: `wrangler dev` local email events + miniflare D1 + mocked SES `fetch`.
- **E2E** (prod SES, real domain): send → alias → confirm rewritten `From` in inbox; reply → confirm external receives it as the alias; assert real address absent from all headers.

---

## 10. Open items to verify during implementation

1. CF Email Workers behavior on thrown exception in `email()` — does the sender get a temporary failure + retry? (Drives transient-error strategy.)
2. SES `SendRawEmail` size ceiling vs base64-inflated 25 MB inbound (~33 MB encoded; under SES 40 MB but confirm).
3. SES production sending quota/rate vs expected inbound volume (catch-all spam included).
4. Exact `aws4fetch` request shape for SES v2 `outbound-emails` vs classic `SendRawEmail`.
5. CF catch-all route wiring for multiple zones to one Worker.

---

## 11. DNS per domain (deploy checklist)

- `MX` → Cloudflare Email Routing (auto when enabling Email Routing).
- Catch-all route → Mail Worker.
- SES domain verification: 3 × DKIM `CNAME`.
- `SPF` TXT includes `include:amazonses.com`.
- `DMARC` TXT present (alignment via SES DKIM under D).
- `bounce@D` (or subdomain MAIL FROM) for bounce handling → SNS.
