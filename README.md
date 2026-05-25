# hidemyemail.dev

Personal serverless email-alias service: Cloudflare Email Routing + Worker + Amazon SES + D1, with a React dashboard on Pages. Full two-way reply-from-alias.

- Design: `docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md`
- Plan: `docs/superpowers/plans/2026-05-24-hidemyemail-alias-service.md`
- Deploy: `docs/DEPLOY.md`

## Dev
- `cd worker && npm install && npm test` — worker test suite
- `cd worker && npx wrangler dev` — local worker (email + api)
- `cd dashboard && npm install && npm run dev` — dashboard against local worker
