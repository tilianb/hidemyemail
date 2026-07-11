# HideMyEmail docs site

An [Astro Starlight](https://starlight.astro.build/) site that publishes the
project documentation to GitHub Pages at
**<https://tilianb.github.io/hidemyemail/>**.

## Single source of truth

The docs are **not** authored here. `scripts/sync-docs.mjs` generates the
content collection from the repository's own markdown so there's nothing to
keep in sync by hand:

| Source | Page |
|---|---|
| `README.md` | Overview (home) |
| `docs/GETTING_STARTED.md` | Getting started |
| `docs/DEPLOY.md` | Deployment guide |
| `docs/AWS_SES_SETUP.md` | AWS SES setup |
| `docs/CONFIGURATION.md` | Configuration |
| `docs/TROUBLESHOOTING.md` | Troubleshooting |
| `docs/SECURITY.md` | Security notes |
| `docs/ROADMAP.md` | Roadmap |
| `CHANGELOG.md` | Changelog |

The sync step strips each file's leading `#` heading (Starlight renders the
title from frontmatter) and rewrites repo-relative links: to other doc pages
when the target is also published, otherwise to GitHub (so nothing 404s). The
generated `src/content/docs/` and `public/favicon.svg` are git-ignored.

To add a page, extend the `PAGES` table in `scripts/sync-docs.mjs` and the
`sidebar` in `astro.config.mjs`.

## Develop

```bash
cd website
npm install
npm run dev      # runs sync-docs, then astro dev
```

`npm run build` does the same before `astro build`.

## Deploy

`.github/workflows/docs.yml` builds and publishes on every push to **`main`**
that touches `website/`, `docs/`, `README.md`, or `CHANGELOG.md` (and on manual
dispatch). Publishing from `main` keeps the public site aligned with released
software; "Edit page" links still target `dev`, since changes flow through
`dev` first. Enable it once in **repo Settings → Pages → Source: "GitHub
Actions"**. The `site`/`base` in `astro.config.mjs` are set for the project
Pages URL above — update them if the repo or Pages host changes.
