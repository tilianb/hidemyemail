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
        "Self-hosted email aliases with Cloudflare + AWS or Docker SMTP, plus native iOS and Android apps.",
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
        baseUrl: "https://github.com/tilianb/hidemyemail/edit/main/",
      },
      sidebar: [
        { label: "Overview", slug: "index" },
        {
          label: "Self-hosting",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "Cloudflare deployment", slug: "deploy" },
            { label: "AWS SES setup", slug: "aws-ses-setup" },
            { label: "Mail providers", slug: "mail-providers" },
            { label: "Configuration", slug: "configuration" },
            { label: "API", slug: "api" },
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
