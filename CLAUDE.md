# hidemyemail.dev — Project Context

Personal **serverless email-alias service** with full two-way reply-from-alias.
Replaces a self-hosted addy.io (AnonAddy) Docker stack.

## Stack & Architecture
- **Inbound Receiving:** AWS SES receives email for catch-all domains/subdomains (MX → `inbound-smtp.ap-southeast-2.amazonaws.com`), stores the raw MIME to S3 (`hidemyemail-inbound-raw`), and publishes metadata to SNS.
- **Worker Webhook:** The Worker receives the SNS notification at `/api/ses/inbound`, fetches the full raw MIME from S3 via `aws4fetch` (using shared SES/S3 credentials with `s3:GetObject`), and routes the message.
- **Routing:** `routeEmail()` dispatches replies (`handleReply()`) if the address matches the reverse-alias format; otherwise it treats it as fresh inbound (`handleInbound()`) and forwards it to the owner.
- **Outbound / Relay:** Sent via AWS SES raw email sending using `aws4fetch` over HTTPS.
- **Unified Hosting:** Cloudflare Worker with D1 database, serving both the Hono API (`/api/*`) and the React/Vite dashboard SPA (under `dashboard/dist`) same-origin via Wrangler V2 Assets.
- **Cost:** Runs entirely on Cloudflare Free tier + AWS SES/S3/SNS pennies (SES via HTTPS, no Workers Paid needed).

## Codebase Status
- **Complete & Fully Tested:** Both core implementation and SES inbound architecture are merged and fully functional.
- **Tests:** 44 passing tests across 16 test files covering all routing, reply, inbound, block, and API flows. Run `cd worker && npm test`.
- **Polish & UI:** The dashboard features a custom dark mode, unified typography (Inter/Outfit), modern UI components (Toasts, Skeletons, ConfirmDialogs), and complete stats graphs.
- **Stability:** Cascaded deletion of related records (`reverse_map`, `blocks`, `events`) is implemented when an alias is deleted, preventing "Failed to delete alias" errors.

## Key Design Decisions & Specs
- **Personal, Single Owner:** Password authentication (PBKDF2) + signed session cookie (HMAC). No users table.
- **Multi-Domain Support:** Serves N domains (seeded in D1 `domains` table). Each alias can optionally override the default domain destination.
- **Catch-All Auto-Create:** Automatically registers new aliases on their first inbound email, alongside standard dashboard CRUD.
- **Self-Describing Reverse Addresses:** Outbound replies use an addy.io style reverse address format: `alias+extLocal=extDomain@domain` (e.g., `shop+alice=store.com@hidemyemail.dev`). Senders with plus/equal characters in their emails are fully supported.
- **Deliverability & Junk Mitigation:** Inbound emails are re-injected with standard, clean headers:
  - `From` MIME header is rewritten to: `"Sender Name - sender at email" <alias@domain>` (e.g., `Alice - alice at store.com <shop@hidemyemail.dev>`). `@` signs in the display name are sanitized to ` at ` to prevent junk-folder flagging.
  - `Reply-To` MIME header is set to the self-describing reverse address.
  - Envelope sender for outbound SES is set to the reverse address.
  - Unsafe headers (`DKIM-Signature`, `ARC-Seal`, `ARC-Message-Signature`, `ARC-Authentication-Results`, `Return-Path`, `Sender`) are stripped.
  - Traceability headers (`X-Reinjected: 1`, `X-Forwarded-For`, `X-Forwarded-To`, `X-Original-From`) are injected.

## Critical Gotchas (Cost Real Time if Forgotten)
1. **No Cloudflare Forwarding:** We do not use Cloudflare's `message.forward()` because it restricts headers (cannot inject `Reply-To`). Inbound goes through S3 + SES re-inject to control `From` and `Reply-To`.
2. **SES SigV4 Service Name:** Must be explicitly overridden to `"ses"` in `aws4fetch` (default parsing for `email.{region}.amazonaws.com` picks `"email"` and fails).
3. **MIME Surgery on Bytes:** Attachments are binary. Split at the first double CRLF (`\r\n\r\n`), modify only the ASCII header block, leave body bytes verbatim, then base64-encode. Never decode the whole message as a string.
4. **Security & Anti-Spoofing Relay Gate:** Since reverse addresses are self-describing and guessable, `handleReply()` strictly enforces:
   - The envelope sender must belong to verified owner destinations (`domains.default_destination` or non-NULL `aliases.destination`).
   - The SES SPF or DMARC verdict must be `"PASS"`.
   - Fails closed: if SPF/DMARC verdicts fail or are missing, replies are rejected to prevent open relay.
5. **No D1 batch() SQL String Parsing in Code:** A repo security hook flags the bare `exec`-with-paren pattern. In code/docs, avoid multi-statement string executions; use helpers built from `prepare().run()` for SQL statements.
6. **Transient SES Errors:** If a transient SES error occurs in `/ses/inbound`, the handler throws so the Worker returns a `5xx` status, triggering SNS/MTA retry. Permanent errors are logged and dropped.

## Env & Ops Configuration
Add the following variables in `wrangler.jsonc` or via `wrangler secret put`:
- `DB`: D1 Database binding
- `SES_REGION`: AWS region (e.g., `ap-southeast-2`)
- `S3_INBOUND_BUCKET`: Raw inbound email S3 bucket (e.g., `hidemyemail-inbound-raw`)
- **Secrets:**
  - `SES_ACCESS_KEY_ID`: AWS access key for SES and S3
  - `SES_SECRET_ACCESS_KEY`: AWS secret key
  - `SESSION_SECRET`: Session signing secret (HMAC)
  - `AUTH_PASSWORD_HASH`: PBKDF2 password hash (hex)
  - `AUTH_PASSWORD_SALT`: PBKDF2 salt (hex)
  - `SNS_ALLOWED_TOPIC_ARN`: Allowed SNS topic for SES outbound notifications (bounces/complaints)
  - `SNS_INBOUND_TOPIC_ARN`: Allowed SNS topic for SES inbound receipt notifications

*Commits must be signed via 1Password SSH agent:*
`SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" git commit -S -m "..."`

## Dev & Build Commands
- `cd worker && npm install && npm test` — Run complete Vitest suite (Vitest pool workers)
- `cd worker && npx wrangler dev` — Run local worker with local SPA assets
- `cd dashboard && npm run dev` — Run dashboard Vite dev server (targets local API)
- `cd dashboard && npm run build` — Build dashboard static production assets

