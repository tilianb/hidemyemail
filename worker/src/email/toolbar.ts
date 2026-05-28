import type { Env } from "../types";
import { signAction, encodeSender } from "./action";

export type ToolbarPosition = "header" | "footer";

export interface ToolbarLinks {
  disable: string;
  block: string;
  mute7: string;
}

// Build action+ mailto addresses for the inline toolbar. Each verb's signature
// is independent (different HMAC inputs) so a leaked link cannot pivot verbs.
export async function buildToolbarLinks(
  aliasId: number, sender: string, domainName: string, env: Env,
): Promise<ToolbarLinks> {
  const encSender = encodeSender(sender);
  const [disableSig, blockSig, muteSig] = await Promise.all([
    signAction("disable", String(aliasId), env),
    signAction("block", `${aliasId}:${encSender}`, env),
    signAction("mute7", String(aliasId), env),
  ]);
  return {
    disable: `action+disable=${aliasId}_${disableSig}@${domainName}`,
    block: `action+block=${aliasId}_${encSender}_${blockSig}@${domainName}`,
    mute7: `action+mute7=${aliasId}_${muteSig}@${domainName}`,
  };
}

// Compact bar (style C): thin top border, no card chrome, wordmark + small
// outlined buttons in a single table row. Identical for header and footer
// placements — same row geometry, only the border anchor differs.
export function buildToolbarHtml(links: ToolbarLinks, anchor: "top" | "bottom" = "bottom"): string {
  const borderProp = anchor === "top" ? "border-bottom" : "border-top";
  const margin = anchor === "top" ? "0 0 16px" : "18px 0 0";
  const padding = anchor === "top" ? "0 0 10px" : "10px 0 0";
  const button = "display:inline-block;padding:4px 10px;border:1px solid #d0d0d0;border-radius:4px;color:#333;text-decoration:none;font-size:12px;";
  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:${margin};${borderProp}:1px solid #e5e7eb;padding:${padding};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <tr>
    <td style="font-size:11px;font-weight:700;letter-spacing:0.05em;color:#1a1a1f;padding-right:12px;">
      hide<span style="background:#1a1a1f;color:#fff;padding:0 4px;border-radius:2px;">my</span>email
    </td>
    <td style="padding-right:6px;"><a href="mailto:${links.block}" style="${button}">Block</a></td>
    <td style="padding-right:6px;"><a href="mailto:${links.mute7}" style="${button}">Mute 7d</a></td>
    <td><a href="mailto:${links.disable}" style="${button}">Disable alias</a></td>
  </tr>
</table>
`.trim();
}

export function buildToolbarText(links: ToolbarLinks): string {
  return [
    "",
    "--",
    "hidemyemail actions:",
    `  Block sender:  mailto:${links.block}`,
    `  Mute 7 days:   mailto:${links.mute7}`,
    `  Disable alias: mailto:${links.disable}`,
  ].join("\n");
}
