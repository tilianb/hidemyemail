export function extractDisplayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m?.[1]?.trim() ?? "";
}

export function sanitizeDisplay(s: string): string {
  return s.replace(/["\r\n]/g, "").slice(0, 100);
}

export function buildForwardedFromDisplay(senderName: string, senderEmail: string, format: string): string {
  const safeName = senderName.replace(/@/g, " at ");
  const safeEmail = senderEmail.replace(/@/g, " at ");
  const name = safeName || safeEmail;

  switch (format) {
    case "name_address_parens_at":
      return safeName ? `${safeName} (${senderEmail})` : senderEmail;
    case "name_address_dash":
      return safeName ? `${safeName} - ${safeEmail}` : safeEmail;
    case "name_address_dash_at":
      return safeName ? `${safeName} - ${senderEmail}` : senderEmail;
    case "name_only":
      return name;
    case "address_only":
      return safeEmail;
    case "address_only_at":
      return senderEmail;
    case "via_hidemyemail":
      return `${name} via HideMyEmail`;
    case "name_address_parens":
    default:
      return safeName ? `${safeName} (${safeEmail})` : safeEmail;
  }
}
