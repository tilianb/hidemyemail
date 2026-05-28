import { concat, utf8 } from "./bytes";

export interface Header { name: string; value: string; }
export interface Mime { headers: Header[]; body: Uint8Array; }

function findBodyStart(bytes: Uint8Array): { headerEnd: number; bodyStart: number } {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return { headerEnd: i, bodyStart: i + 4 };
    }
  }
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { headerEnd: i, bodyStart: i + 2 };
  }
  return { headerEnd: bytes.length, bodyStart: bytes.length };
}

export function parseMime(bytes: Uint8Array): Mime {
  const { headerEnd, bodyStart } = findBodyStart(bytes);
  const headerText = new TextDecoder("ascii").decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split(/\r?\n/);
  const headers: Header[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && headers.length) {
      headers[headers.length - 1]!.value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return { headers, body: bytes.subarray(bodyStart) };
}

export function getHeader(m: Mime, name: string): string | undefined {
  const lower = name.toLowerCase();
  return m.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

export function setHeader(m: Mime, name: string, value: string): Mime {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error("Invalid header name");
  if (value.includes("\r") || value.includes("\n")) throw new Error("Invalid header value");
  const lower = name.toLowerCase();
  const kept = m.headers.filter((h) => h.name.toLowerCase() !== lower);
  return { headers: [...kept, { name, value }], body: m.body };
}

export function removeHeaders(m: Mime, names: string[]): Mime {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return { headers: m.headers.filter((h) => !drop.has(h.name.toLowerCase())), body: m.body };
}

export function serializeMime(m: Mime): Uint8Array {
  const headerText = m.headers.map((h) => `${h.name}: ${h.value}`).join("\r\n") + "\r\n\r\n";
  return concat(utf8(headerText), m.body);
}
