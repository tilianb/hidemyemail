// Generates the Starlight content collection from the repository's own
// markdown, so docs/ (+ README/CHANGELOG/ROADMAP) stay the single source of
// truth. Run automatically before `dev`/`build` (see package.json).
//
// For each source file it: strips the leading H1 (Starlight renders the title
// from frontmatter), injects a title, and rewrites repo-relative links — to
// in-site pages when the target is another synced doc, otherwise to GitHub
// (blob for files, raw for assets) so nothing 404s.
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const WEBSITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(WEBSITE_DIR);
const OUT_DIR = join(WEBSITE_DIR, "src", "content", "docs");
const BASE = "/hidemyemail"; // must match astro.config.mjs `base`
const BLOB = "https://github.com/tilianb/hidemyemail/blob/dev";
const RAW = "https://raw.githubusercontent.com/tilianb/hidemyemail/dev";

// repo-relative source -> { slug, title }. `index` is the site home.
const PAGES = [
  { src: "README.md", slug: "index", title: "HideMyEmail" },
  { src: "docs/GETTING_STARTED.md", slug: "getting-started", title: "Getting started" },
  { src: "docs/DEPLOY.md", slug: "deploy", title: "Deployment guide" },
  { src: "docs/AWS_SES_SETUP.md", slug: "aws-ses-setup", title: "AWS SES setup" },
  { src: "docs/CONFIGURATION.md", slug: "configuration", title: "Configuration" },
  { src: "docs/TROUBLESHOOTING.md", slug: "troubleshooting", title: "Troubleshooting" },
  { src: "docs/SECURITY.md", slug: "security", title: "Security notes" },
  { src: "docs/ROADMAP.md", slug: "roadmap", title: "Roadmap" },
  { src: "CHANGELOG.md", slug: "changelog", title: "Changelog" },
];

const SLUG_BY_SRC = new Map(PAGES.map((p) => [p.src, p.slug]));

const isExternal = (t) => /^(https?:|mailto:|tel:|#|\/\/)/i.test(t);

function inSiteHref(slug, hash) {
  return slug === "index" ? `${BASE}/${hash}` : `${BASE}/${slug}/${hash}`;
}

// Resolve a repo-relative target (from a file at `srcPath`) to a final URL.
function rewriteTarget(srcPath, target, asset) {
  if (!target || isExternal(target)) return target;
  const hashIndex = target.indexOf("#");
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const path = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  if (!path) return target; // pure anchor handled by isExternal already
  const resolved = posix.normalize(posix.join(posix.dirname(srcPath), path)).replace(/^\.\//, "");
  const slug = SLUG_BY_SRC.get(resolved);
  if (slug && !asset) return inSiteHref(slug, hash);
  return asset ? `${RAW}/${resolved}` : `${BLOB}/${resolved}${hash}`;
}

function rewriteLinks(srcPath, content) {
  let out = content;
  // Markdown images: ![alt](target)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, t) => `![${alt}](${rewriteTarget(srcPath, t, true)})`);
  // Markdown links: [text](target) — negative lookbehind skips images.
  out = out.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, text, t) => `[${text}](${rewriteTarget(srcPath, t, false)})`);
  // HTML attributes: src="..." (asset) and href="..." (link).
  out = out.replace(/\bsrc=("|')([^"']+)\1/g, (_m, q, t) => `src=${q}${rewriteTarget(srcPath, t, true)}${q}`);
  out = out.replace(/\bhref=("|')([^"']+)\1/g, (_m, q, t) => `href=${q}${rewriteTarget(srcPath, t, false)}${q}`);
  return out;
}

// Remove the first level-1 heading; its text becomes the title if none is set.
function stripFirstH1(content) {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (i === -1) return { body: content, heading: null };
  const heading = lines[i].replace(/^#\s+/, "").trim();
  lines.splice(i, 1);
  if (lines[i] !== undefined && lines[i].trim() === "") lines.splice(i, 1);
  return { body: lines.join("\n"), heading };
}

const yamlString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const page of PAGES) {
    const raw = await readFile(join(REPO_ROOT, page.src), "utf8");
    const { body, heading } = stripFirstH1(raw);
    const rewritten = rewriteLinks(page.src, body).trimStart();
    const title = page.title || heading || page.slug;
    // "Edit page" must point at the real source in the repo, not the generated
    // (git-ignored) file under src/content/docs/. Edits flow through `dev`.
    const editUrl = `https://github.com/tilianb/hidemyemail/edit/dev/${page.src}`;
    const frontmatter = `---\ntitle: ${yamlString(title)}\neditUrl: ${yamlString(editUrl)}\n---\n\n`;
    await writeFile(join(OUT_DIR, `${page.slug}.md`), frontmatter + rewritten + "\n");
    console.log(`synced ${page.src} -> ${page.slug}.md`);
  }

  // Brand favicon, reused from the dashboard.
  await mkdir(join(WEBSITE_DIR, "public"), { recursive: true });
  await copyFile(
    join(REPO_ROOT, "dashboard", "public", "favicon.svg"),
    join(WEBSITE_DIR, "public", "favicon.svg"),
  );
  console.log("copied favicon.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
