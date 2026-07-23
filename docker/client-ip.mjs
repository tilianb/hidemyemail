import { isIP } from "node:net";

export const FORWARDING_HEADERS = [
  "cf-connecting-ip",
  "client-ip",
  "forwarded",
  "true-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-hide-my-email-client-ip",
  "x-hidemyemail-client-ip",
  "x-real-ip",
];

export function normalizeIp(value) {
  const ip = value?.trim();
  if (!ip || ip.includes(",")) return null;
  const family = isIP(ip);
  if (!family) return null;
  if (family === 4) return ip;

  // WHATWG URL parsing uses the platform's standards-compliant IPv6 parser
  // and serializes equivalent forms to one compressed, lowercase spelling.
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  if (!normalized.startsWith("::ffff:")) return normalized;

  const [high, low] = normalized.slice(7).split(":").map((part) => Number.parseInt(part, 16));
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function trustedProxySet(value = "") {
  const proxies = new Set();
  for (const entry of value.split(",")) {
    const ip = normalizeIp(entry);
    if (!ip) {
      if (entry.trim()) throw new Error(`Invalid TRUSTED_PROXY_IPS entry: ${entry.trim()}`);
      continue;
    }
    proxies.add(ip);
  }
  return proxies;
}

export function workerHeaders(incoming, socketAddress, trustedProxies) {
  const peerIp = normalizeIp(socketAddress);
  if (!peerIp) throw new Error("Request socket did not provide a valid peer IP");

  const proxyIp = normalizeIp(incoming.get("x-hidemyemail-client-ip"));
  const clientIp = trustedProxies.has(peerIp) ? proxyIp : peerIp;
  if (!clientIp) throw new Error("Trusted proxy did not provide one valid X-HideMyEmail-Client-IP value");

  const headers = new Headers(incoming);
  for (const name of FORWARDING_HEADERS) headers.delete(name);
  headers.set("x-hidemyemail-client-ip", clientIp);
  return headers;
}
