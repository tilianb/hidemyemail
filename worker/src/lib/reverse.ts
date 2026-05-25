import { REVERSE_PREFIX } from "../config";
import * as q from "../db/queries";
import type { ReverseRow } from "../types";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newToken(len = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out; // len chars; 24 chars ~= 120 bits of entropy
}

export function reverseAddress(token: string, domain: string): string {
  return `${REVERSE_PREFIX}${token}@${domain}`;
}

export function parseReverse(localPart: string): string | null {
  return localPart.startsWith(REVERSE_PREFIX) ? localPart.slice(REVERSE_PREFIX.length) : null;
}

export async function getOrCreateReverse(db: D1Database, aliasId: number, externalSender: string): Promise<ReverseRow> {
  return q.upsertReverse(db, aliasId, externalSender.toLowerCase(), newToken(24));
}
