// Over-quota banner matched to the compact-bar toolbar visual system:
// red-tinted top border, no card chrome, same wordmark + badge layout,
// explanation on row two so the wordmark/badge stay tight.
export function buildInlineWarningHtml(): string {
  return `
<div style="margin:0 0 16px;border-top:2px solid #d63b3b;border-bottom:1px solid #e5e7eb;padding:10px 0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <div style="line-height:1.4;">
    <span style="font-size:11px;font-weight:700;letter-spacing:0.05em;color:#1a1a1f;">
      hide<span style="background:#1a1a1f;color:#fff;padding:0 4px;border-radius:2px;">my</span>email
    </span>
    <span style="display:inline-block;background:#d63b3b;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-left:8px;vertical-align:1px;">Quota exceeded</span>
  </div>
  <div style="font-size:12px;color:#5a1f1f;line-height:1.5;margin-top:4px;">
    Auto-created so you wouldn't miss this — replies blocked until you free space.
  </div>
</div>
`.trim();
}

export function buildInlineWarningText(): string {
  return `--
[hidemyemail] QUOTA EXCEEDED
Auto-created so you wouldn't miss this — replies blocked until you free space.
--

`;
}
