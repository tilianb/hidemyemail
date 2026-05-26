export function buildRecoveryEmail(to: string, url: string): string {
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  
  const textBody = `HideMyEmail Account Recovery
==============================

You have requested a recovery link for your HideMyEmail account.
Click the link below to verify your identity and generate a new secure passphrase:

${url}

This link expires in 24 hours.

— HideMyEmail (https://hidemyemail.dev)`;

  const msgLines = [
    `From: HideMyEmail <noreply@hidemyemail.dev>`,
    `To: ${to}`,
    `Subject: Account Recovery Link`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    textBody,
    ``,
    `--${boundary}--`,
  ];
  return btoa(unescape(encodeURIComponent(msgLines.join("\r\n"))));
}

export function buildMfaEmail(to: string, code: string): string {
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  
  const textBody = `Your HideMyEmail Authentication Code
=======================================

Your 6-digit authentication code is: ${code}

Enter this code on the recovery page to complete the process. This code expires soon.

— HideMyEmail (https://hidemyemail.dev)`;

  const msgLines = [
    `From: HideMyEmail <noreply@hidemyemail.dev>`,
    `To: ${to}`,
    `Subject: Your Authentication Code`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    textBody,
    ``,
    `--${boundary}--`,
  ];
  return btoa(unescape(encodeURIComponent(msgLines.join("\r\n"))));
}
