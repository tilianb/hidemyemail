# Mail provider flexibility implementation plan

## Delivered scope

- Keep SES as the default and route every outbound send through one provider-neutral raw-MIME contract.
- Let Docker operators select a custom SMTP host independently of inbound transport. Nodemailer preserves the explicit envelope recipient and raw MIME, requires verified TLS for implicit TLS or STARTTLS, and bounds all timeouts below the five-minute durable send fence.
- Add an opt-in, receive-only Docker SMTP listener for a trusted upstream MTA. It authenticates the gateway, can restrict exact socket peers, accepts one recipient per transaction, validates recipients against active HideMyEmail domains/aliases/catch-all policy, bounds DATA, and waits for Worker processing before `250`.
- Prefer the upstream MTA's durable queue. HideMyEmail stores delivery claims and send fences, not an inbox. SMTP acceptance does not prove final delivery; acknowledgment loss can still produce one delayed duplicate after the fence expires.
- Support environment defaults and encrypted D1 credential overrides. Explicit DB values win, clearing an override restores the environment/default, and Docker SMTP transport or listener changes require a restart. The UI distinguishes configured state from the active process state.

## Trust and verdict contract

The upstream gateway must remove every sender-supplied `X-HideMyEmail-Gateway-Result` header, perform SPF, DMARC, spam, and virus checks, then add exactly one:

```text
X-HideMyEmail-Gateway-Result: v=1; id=<durable-queue-id>; spf=PASS; dmarc=PASS; spam=PASS; virus=PASS
```

The Docker listener accepts that header only over its authenticated/peer-allowlisted SMTP boundary, validates each value, strips the header before forwarding, and namespaces deduplication by gateway, queue ID, and envelope recipient. It never derives PASS from SMTP AUTH. Missing or malformed metadata fails SMTP delivery. Reply handling still matches SPF to MAIL FROM, DMARC to header From, a verified owner destination, and a durable prior contact.

## Explicit exclusions and follow-ups

- Cloudflare Workers cannot listen for inbound TCP and block outbound port 25. Custom SMTP is Docker-only; Cloudflare deployments configured for it fail instead of falling back to SES.
- Public MX reception without a trusted, queueing authentication/scanning MTA is unsupported. Ports 465 and 587 are submission ports, not substitute MX ports.
- No retained inbox, IMAP/POP polling, direct-to-MX delivery, failover pools, provider HTTP adapters, or generic public send endpoint.
- SES bounce/complaint SNS processing remains available for SES. SMTP supplier feedback webhooks remain future work.
- Microsoft 365 remains an assessment: SMTP OAuth and Graph MIME sending require an authorized sender/Send As identity; Direct Send cannot relay externally. Verified domains, dynamic alias Send As grants, tenant quotas, connector requirements, and Worker/Docker constraints need validation before an adapter can claim parity.

## Verification plan

Worker tests cover provider selection, SES compatibility, private ingress authorization, active-domain recipient checks, verdict validation, size limits, MIME control-header stripping, and existing delivery/quota fences. Docker tests cover TLS configuration, MIME/envelope preservation, rejection classification, uncertain DATA outcomes, gateway metadata, and a real local SMTP socket with STARTTLS downgrade refusal. Full Worker, dashboard, extension, Docker, docs, and container checks complete the branch verification without external mail.
