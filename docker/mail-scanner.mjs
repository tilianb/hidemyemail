import net from "node:net";
import { authenticate as mailAuthenticate } from "mailauth";

const AUTH = {
  pass: "PASS", fail: "FAIL", softfail: "GRAY", neutral: "GRAY", none: "GRAY",
  temperror: "PROCESSING_FAILED", permerror: "PROCESSING_FAILED",
};

export function clamScan(raw, { host = "clamav", port = 3310, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const response = [];
    const timer = setTimeout(() => socket.destroy(new Error("Virus scan timed out")), timeout);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(Buffer.concat(response).toString().replace(/\0+$/, "")); };
    socket.once("error", finish);
    socket.on("data", chunk => {
      response.push(chunk);
      if (chunk.includes(0)) { socket.destroy(); finish(); }
    });
    socket.once("connect", () => {
      const length = Buffer.alloc(4); length.writeUInt32BE(raw.length);
      socket.end(Buffer.concat([Buffer.from("zINSTREAM\0"), length, raw, Buffer.alloc(4)]));
    });
    socket.once("end", () => finish());
  });
}

export async function scanMail(raw, session, {
  authenticate = mailAuthenticate,
  fetch: scanFetch = fetch,
  clam = clamScan,
  rspamdUrl = "http://rspamd:11333/checkv2",
  hostname = "localhost",
} = {}) {
  const authentication = await authenticate(raw, {
    ip: session.ip, helo: session.helo, sender: session.from, mta: hostname,
    disableArc: true, disableBimi: true, strict: true, maxElapsedTime: 10000,
  });
  const spf = AUTH[authentication.spf?.status?.result] ?? "PROCESSING_FAILED";
  const dmarc = authentication.dmarc === false
    ? "PROCESSING_FAILED"
    : AUTH[authentication.dmarc?.status?.result] ?? "PROCESSING_FAILED";

  const scanResponse = await scanFetch(rspamdUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream", IP: session.ip, Helo: session.helo,
      From: session.from, Rcpt: session.to, Flags: "pass_all,no_log",
    },
    body: raw,
    signal: AbortSignal.timeout(30000),
  });
  if (!scanResponse.ok) throw new Error("Spam scanner unavailable");
  const scan = await scanResponse.json();
  if (scan.is_skipped || typeof scan.score !== "number") throw new Error("Spam scan incomplete");
  let spam;
  if (scan.action === "no action") spam = "PASS";
  else if (["add header", "rewrite subject", "reject"].includes(scan.action)) spam = "FAIL";
  else if (["soft reject", "greylist"].includes(scan.action)) throw new Error("Spam scan temporarily deferred");
  else throw new Error("Unknown spam scan result");

  const clamResult = await clam(raw);
  let virus;
  if (clamResult === "stream: OK") virus = "PASS";
  else if (/^stream: .+ FOUND$/.test(clamResult)) {
    virus = /Heuristics\.(Encrypted|OLE2\.ContainsMacros)/.test(clamResult) ? "GRAY" : "FAIL";
  } else throw new Error("Virus scan incomplete");
  return { spf, dmarc, spam, virus };
}
