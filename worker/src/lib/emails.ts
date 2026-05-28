import { createMimeMessage } from "mimetext";
import { toBase64 } from "./bytes";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtmlWrapper(title: string, heading: string, bodyText: string, actionHtml: string, fallbackUrl?: string, mainGlobalDomain: string = "example.com", footerText?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;background-image:url('data:image/svg+xml,%3Csvg viewBox=%270 0 256 256%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%274%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27 opacity=%270.028%27/%3E%3C/svg%3E');background-attachment:fixed;font-family:'Inter',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
          <tr>
            <td style="background:#18181d;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.7);">
              <div style="font-size:22px;font-weight:700;color:#e8e8ec;letter-spacing:-0.03em;margin-bottom:28px;font-family:'Bricolage Grotesque','Inter',sans-serif;text-align:center;user-select:none;">
                hide<span style="background:rgba(255,179,0,0.15);color:#ffb300;border-radius:4px;padding:0 5px;margin:0 2px;border:1px solid rgba(255,179,0,0.2);font-size:0.85em;font-weight:700;vertical-align:middle;display:inline-block;">my</span>email
              </div>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;line-height:1.2;letter-spacing:-0.02em;color:#e8e8ec;font-family:'Bricolage Grotesque','Inter',sans-serif;">
                ${heading}
              </h1>
              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#9898a8;font-family:'Inter',sans-serif;">
                ${bodyText}
              </p>
              ${actionHtml}
              ${fallbackUrl ? `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr><td style="border-top:1px solid rgba(255,255,255,0.07);font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
              <p style="margin:0 0 8px;font-size:12px;color:#55555f;font-family:'Inter',sans-serif;text-align:left;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin:0;font-size:11px;font-family:'JetBrains Mono','Menlo',monospace;color:#9898a8;word-break:break-all;background:#111114;border:1px dashed rgba(255,255,255,0.08);border-radius:4px;padding:10px 12px;text-align:left;">
                ${escapeHtml(fallbackUrl)}
              </p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0;text-align:center;">
              <p style="margin:0 0 6px;font-size:11px;color:#55555f;font-family:'Inter',sans-serif;line-height:1.5;">
                ${footerText !== undefined ? escapeHtml(footerText) : "This link was requested for HideMyEmail. If you did not request this, you can safely ignore this email."}
              </p>
              <p style="margin:0;font-size:11px;color:#55555f;font-family:'Inter',sans-serif;">
                &copy; ${new Date().getFullYear()} HideMyEmail &middot; <a href="https://${escapeHtml(mainGlobalDomain)}" style="color:#ffb300;text-decoration:none;font-weight:500;">${escapeHtml(mainGlobalDomain)}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildMultipartEmail(to: string, subject: string, textBody: string, htmlBody: string, mainGlobalDomain: string): string {
  const msg = createMimeMessage();
  msg.setSender({ name: "HideMyEmail", addr: `noreply@${mainGlobalDomain}` });
  msg.setTo(to);
  msg.setSubject(subject);
  msg.addMessage({ contentType: "text/plain", data: textBody });
  msg.addMessage({ contentType: "text/html", data: htmlBody });
  return toBase64(new TextEncoder().encode(msg.asRaw()));
}

export function buildRecoveryEmail(to: string, url: string, mainGlobalDomain: string = "example.com"): string {
  const textBody = `HideMyEmail Account Recovery
==============================

You have requested a recovery link for your HideMyEmail account.
Click the link below to verify your identity and generate a new secure passphrase:

${url}

This link expires in 24 hours.

— HideMyEmail (https://${mainGlobalDomain})`;

  const actionHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 32px;width:100%;">
      <tr>
        <td style="border-radius:4px;background:#ffb300;text-align:center;">
          <a href="${escapeHtml(url)}" target="_blank"
             style="display:block;padding:11px 20px;font-size:14px;font-weight:600;letter-spacing:0.02em;color:#0d0d0f;text-decoration:none;border-radius:4px;font-family:'Bricolage Grotesque','Inter',sans-serif;background:#ffb300;border:1px solid #ffb300;">
            Recover Account
          </a>
        </td>
      </tr>
    </table>`;

  const htmlBody = buildHtmlWrapper(
    "Account Recovery Link",
    `Account <span style="background:rgba(255,179,0,0.15);color:#ffb300;border-radius:4px;padding:0 5px;margin:0 1px;border:1px solid rgba(255,179,0,0.2);font-weight:700;display:inline-block;">Recovery</span>`,
    "You have requested a recovery link for your HideMyEmail account. Click the button below to verify your identity and generate a new secure passphrase.",
    actionHtml,
    url,
    mainGlobalDomain
  );

  return buildMultipartEmail(to, "Account Recovery Link", textBody, htmlBody, mainGlobalDomain);
}

export function buildMfaEmail(to: string, code: string, mainGlobalDomain: string = "example.com"): string {
  const textBody = `Your HideMyEmail Authentication Code
=======================================

Your 6-digit authentication code is: ${code}

Enter this code on the recovery page to complete the process. This code expires soon.

— HideMyEmail (https://${mainGlobalDomain})`;

  const actionHtml = `
    <div style="display:inline-block;background:#111114;border:1px dashed rgba(255,255,255,0.08);padding:12px 24px;border-radius:4px;font-family:'JetBrains Mono','Menlo',monospace;font-size:24px;font-weight:700;letter-spacing:0.2em;color:#e8e8ec;margin-bottom:32px;text-align:center;">
      ${escapeHtml(code)}
    </div>`;

  const htmlBody = buildHtmlWrapper(
    "Your Authentication Code",
    `Authentication <span style="background:rgba(255,179,0,0.15);color:#ffb300;border-radius:4px;padding:0 5px;margin:0 1px;border:1px solid rgba(255,179,0,0.2);font-weight:700;display:inline-block;">Code</span>`,
    "Enter this 6-digit code on the recovery page to complete the process. This code will expire soon.",
    actionHtml,
    undefined,
    mainGlobalDomain
  );

  return buildMultipartEmail(to, "Your Authentication Code", textBody, htmlBody, mainGlobalDomain);
}

export function buildNotificationEmail(to: string, subject: string, heading: string, bodyText: string, mainGlobalDomain: string = "example.com"): string {
  const textBody = `${subject}
=======================================

${bodyText}

— HideMyEmail (https://${mainGlobalDomain})`;

  const htmlBody = buildHtmlWrapper(
    subject,
    heading,
    bodyText,
    "",
    undefined,
    mainGlobalDomain,
    "This is an automated system notification from HideMyEmail."
  );

  return buildMultipartEmail(to, subject, textBody, htmlBody, mainGlobalDomain);
}
