# Roadmap

Tracked backlog of recommendations from the pre-v1 review (2026-06-10).
Items are removed when shipped; see CHANGELOG.md for what already landed.

## Blocking v1 — needs an owner decision

- [ ] **Rename the project.** "Hide My Email" is Apple's product name. An
  iOS app under this name is near-certain App Store rejection, and search
  is dominated by Apple. Renaming after launch costs all early links and
  stars — decide before tagging v1.0.0 and before any Show HN post.
  Affects: repo name, dashboard branding, `X-HideMyEmail-*` headers
  (keep parsing the old ones), Docker image names, `app.hidemyemail.dev`.
- [ ] **Tag v1.0.0** after the rename and after `claude/release-1-prep`
  merges (changelog is ready in CHANGELOG.md). Tagging runs the
  release-retag Docker workflow.

## Correctness / robustness (from review, not yet fixed)

- [ ] `docker/server.mjs`: purge `setInterval` never fires an initial run —
  a container restarted more often than `PURGE_INTERVAL_MS` (6h) never
  purges tombstoned accounts. Run once at startup too.
- [ ] `.github/workflows/docker.yml` release-retag: falls back to the
  `:main` image when the `sha-<short>` tag is missing, which can release
  an image built from a different commit than the tag. Fail instead, or
  build from the tag.
- [ ] Account export completeness: include MFA status, passkey credential
  metadata, reverse_map (correspondents per alias), and user email
  preferences — it is presented as a full data export.
- [ ] Global rate-limit semantics: inbound counts forward+reply against
  `rate_limit_global`, the reply path counts replies only against the
  same key. Unify or split into two knobs.
- [ ] Events retention is intentionally absent (the first-contact reply
  gate depends on old `forward` rows). If retention is ever added, the
  reply gate needs its own durable store first.

## Product — make it a daily driver

- [ ] **addy.io-compatible API surface** for alias generation. Bitwarden
  and other password managers already speak the addy.io/SimpleLogin
  APIs — compatibility gives instant integration with Bitwarden's
  username generator. Highest usefulness-per-effort item on this list.
  Then request a listing in Bitwarden's forwarder docs.
- [ ] **Browser extension** (or interim bookmarklet): generate an alias in
  signup forms without opening the dashboard. The daily-driver feature of
  SimpleLogin/addy.
- [ ] iOS app (exists on `claude/mobile-app-effort-v1-Qxt1M`): add a Share
  extension and AutoFill credential provider so aliases can be generated
  inside Safari.
- [ ] **Compose-as-alias** from the dashboard with explicit per-send
  confirmation (the first-contact gate correctly blocks SMTP-level
  originate; a UI path keeps the anti-spam posture).
- [ ] Import from SimpleLogin / addy.io CSV — migration path for switchers.
- [ ] UI refresh for the dashboard (admin + user) — easy to use, visually
  polished. Planned on a dedicated branch off dev.

## Deliverability (beyond what shipped)

- [ ] Consider ARC sealing of forwards instead of header stripping once an
  ARC library is practical inside Workers.
- [ ] Per-domain deliverability checklist in the dashboard (custom MAIL
  FROM present, DMARC policy, Postmaster/SNDS enrolment status).

## Traction

- [x] README: comparison table, Deploy-to-Workers button (shipped).
- [ ] Screenshots / GIF of the dashboard in the README.
- [ ] Submit to awesome-selfhosted, selfh.st, AlternativeTo.
- [ ] Technical blog post: "Email aliases without a mail server — SES +
  Workers", then r/selfhosted post and Show HN. Sequence AFTER the rename
  and deliverability fixes — launch posts get one shot.
- [ ] Hosted demo with a throwaway demo login at the public instance.
