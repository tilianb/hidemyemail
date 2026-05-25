import * as q from "../db/queries";
import type { ReverseRow } from "../types";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newToken(len = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out; // len chars; 24 chars ~= 120 bits of entropy
}

// e.g. "shop+d5fzli6aaamyvq3x@hidemyemail.dev"
export function reverseAddress(aliasLocal: string, token: string, domain: string): string {
  return `${aliasLocal}+${token}@${domain}`;
}

// Returns the 24-char base32 token if localPart ends with +{token}, else null.
export function parseReverse(localPart: string): string | null {
  const m = localPart.match(/\+([a-z2-7]{24})$/);
  return m ? m[1]! : null;
}

export async function getOrCreateReverse(db: D1Database, aliasId: number, externalSender: string): Promise<ReverseRow> {
  return q.upsertReverse(db, aliasId, externalSender.toLowerCase(), newToken(24));
}
