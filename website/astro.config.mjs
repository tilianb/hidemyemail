// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Published to GitHub Pages as a *project* site:
//   https://tilianb.github.io/hidemyemail/
// `site` + `base` must match that URL; the Pages workflow builds from this dir.
export default defineConfig({
  site: "https://tilianb.github.io",
  base: "/hidemyemail",
  integrations: [
    starlight({
      title: "HideMyEmail",
      description:
        "Self-hosted, serverless email aliases for your domains — Cloudflare Workers + AWS SES, with native iOS and Android apps.",
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tilianb/hidemyemail",
        },
      ],
      // Source of truth lives in the repo root, not in website/. The sync step
      // copies it into src/content/docs/, so "edit this page" points back there.
      editLink: {
        baseUrl: "https://github.com/tilianb/hidemyemail/edit/dev/",
      },
      sidebar: [
        { label: "Overview", slug: "index" },
        {
          label: "Self-hosting",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "Deployment guide", slug: "deploy" },
            { label: "AWS SES setup", slug: "aws-ses-setup" },
            { label: "Configuration", slug: "configuration" },
            { label: "Troubleshooting", slug: "troubleshooting" },
            { label: "Security notes", slug: "security" },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "roadmap" },
            { label: "Changelog", slug: "changelog" },
          ],
        },
      ],
    }),
  ],
});
