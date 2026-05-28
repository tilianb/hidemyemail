import type { Env } from "../types";
import { createMimeMessage, Mailbox } from "mimetext";
import { toBase64 } from "../lib/bytes";
import { buildToolbarLinks, buildToolbarHtml, buildToolbarText } from "./toolbar";
import { buildInlineWarningHtml, buildInlineWarningText } from "./warning";
import { buildForwardedFromDisplay, sanitizeDisplay } from "../lib/from-format";
import { getSetting, getBoolSetting } from "../lib/settings";

const SAMPLE_BODIES = [
  {
    sender: { name: "Alex from Acme", email: "alex@acme.example.com" },
    subject: "Welcome to Acme — here's your starter kit",
    html: `<p>Hey there!</p><p>Thanks for signing up. Your starter kit is ready — log in any time to get going. We've also put together a quick five-minute walkthrough if you'd like to see what's possible.</p><p>Cheers,<br>Alex</p>`,
    text: `Hey there!

Thanks for signing up. Your starter kit is ready — log in any time to get going. We've also put together a quick five-minute walkthrough if you'd like to see what's possible.

Cheers,
Alex`,
  },
  {
    sender: { name: "Lana Chen", email: "lana@startup.example.com" },
    subject: "Quick question about your project",
    html: `<p>Hi,</p><p>I saw your project on the showcase page and wanted to ask — would you be open to a short chat about how you approached the auth flow? We're building something similar and would love your perspective.</p><p>No pressure, just curious!</p><p>— Lana</p>`,
    text: `Hi,

I saw your project on the showcase page and wanted to ask — would you be open to a short chat about how you approached the auth flow? We're building something similar and would love your perspective.

No pressure, just curious!

— Lana`,
  },
  {
    sender: { name: "Mailing List", email: "weekly@newsletter.example.com" },
    subject: "Weekly digest — 5 things worth your attention",
    html: `<p><strong>This week's picks:</strong></p><ol><li>A new approach to background jobs in serverless</li><li>The case against premature optimization (again)</li><li>How Postgres handles 100k writes per second</li><li>Static analysis for TypeScript that actually works</li><li>Why caching is harder than you think</li></ol><p>Unsubscribe any time.</p>`,
    text: `This week's picks:

1. A new approach to background jobs in serverless
2. The case against premature optimization (again)
3. How Postgres handles 100k writes per second
4. Static analysis for TypeScript that actually works
5. Why caching is harder than you think

Unsubscribe any time.`,
  },
];

export async function buildDemoForward(opts: {
  to: string;
  mainGlobalDomain: string;
  env: Env;
  withOverQuota: boolean;
}): Promise<{ rawBase64: string; fromAddr: string }> {
  const { to, mainGlobalDomain, env, withOverQuota } = opts;
  const db = env.DB;
  const sample = SAMPLE_BODIES[Math.floor(Math.random() * SAMPLE_BODIES.length)]!;
  const aliasLocal = "demo";
  const aliasFull = `${aliasLocal}@${mainGlobalDomain}`;

  // Honor admin's Runtime Settings so the demo previews the live look.
  const format = (await getSetting(db, "forwarded_from_format")) || "name_address_parens";
  const display = buildForwardedFromDisplay(sample.sender.name, sample.sender.email, format);
  const fromAddr = `"${sanitizeDisplay(display)}" <${aliasFull}>`;

  const defaultEnabled = await getBoolSetting(db, "inline_actions_default_enabled");
  const positionSetting = (await getSetting(db, "inline_actions_default_position")) || "footer";
  const position: "header" | "footer" = positionSetting === "header" ? "header" : "footer";

  // Demo uses alias id 0 — links won't validate against the action handler
  // (no such alias), but render exactly as a real toolbar would for preview.
  const showToolbar = !withOverQuota && defaultEnabled;
  const links = showToolbar
    ? await buildToolbarLinks(0, sample.sender.email, mainGlobalDomain, env)
    : null;

  const msg = createMimeMessage();
  msg.setSender({ name: sanitizeDisplay(display), addr: aliasFull });
  msg.setRecipient(to);
  msg.setSubject(withOverQuota ? `[OVER QUOTA] ${sample.subject}` : sample.subject);
  msg.setHeader("Reply-To", new Mailbox({ addr: aliasFull }));
  msg.setHeader("X-HideMyEmail-Demo", withOverQuota ? "over_quota" : "forward");
  if (withOverQuota) msg.setHeader("X-HideMyEmail-Warning", "Demo over-quota preview.");
  else if (showToolbar) msg.setHeader("X-HideMyEmail-Actions", position);

  let html = sample.html;
  let text = sample.text;

  if (withOverQuota) {
    html = `${buildInlineWarningHtml()}\n${html}`;
    text = `${buildInlineWarningText()}${text}`;
  } else if (showToolbar && links) {
    const anchor = position === "header" ? "top" : "bottom";
    const toolbarHtml = buildToolbarHtml(links, anchor);
    if (position === "header") {
      html = `${toolbarHtml}\n${html}`;
    } else {
      html = `${html}\n${toolbarHtml}`;
    }
    text = `${text}${buildToolbarText(links)}`;
  }

  msg.addMessage({ contentType: "text/plain", data: text });
  msg.addMessage({ contentType: "text/html", data: html });

  return { rawBase64: toBase64(new TextEncoder().encode(msg.asRaw())), fromAddr };
}
