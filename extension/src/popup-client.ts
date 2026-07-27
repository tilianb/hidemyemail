import { isValidDomain, type Alias, type CreateAliasInput } from "./api";
import type { PopupRequest } from "./messages";

export const SAFE_ERROR = "HideMyEmail could not complete the request. Try again.";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validAlias = (value: unknown): value is Alias => {
  if (!record(value) || typeof value.id !== "string" || !/^[1-9]\d*$/.test(value.id) || typeof value.email !== "string" || typeof value.active !== "boolean" || !(value.description === null || typeof value.description === "string") || !isValidDomain(value.domain) || typeof value.local_part !== "string") return false;
  return value.email === `${value.local_part}@${value.domain}`;
};

export async function popupRequest(message: PopupRequest): Promise<{ aliases?: Alias[]; alias?: Alias }> {
  let value: unknown;
  try { value = await chrome.runtime.sendMessage(message); } catch { throw new Error(SAFE_ERROR); }
  if (!record(value) || value.ok !== true) throw new Error(SAFE_ERROR);
  if (message.type === "hme:aliases:list") {
    if (!Array.isArray(value.aliases) || value.aliases.length > 100 || !value.aliases.every(validAlias)) throw new Error(SAFE_ERROR);
    return { aliases: value.aliases };
  }
  if (message.type === "hme:aliases:create") {
    if (!validAlias(value.alias)) throw new Error(SAFE_ERROR);
    return { alias: value.alias };
  }
  if (Object.keys(value).some((key) => key !== "ok")) throw new Error(SAFE_ERROR);
  return {};
}

export function createInput(domain: string, format: CreateAliasInput["format"], description: string, localPart: string): CreateAliasInput {
  const input: CreateAliasInput = { domain, format };
  if (description.trim()) input.description = description.trim();
  if (format === "custom") input.local_part = localPart.trim();
  return input;
}
