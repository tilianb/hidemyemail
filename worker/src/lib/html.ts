// Escape a string for safe interpolation into HTML text or double-quoted
// attributes. Shared by the transactional email templates and the unsubscribe
// confirmation page so the entity set never drifts between copies.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
