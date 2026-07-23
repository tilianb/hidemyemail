import { fromBase64, streamToBytes, utf8 } from "./bytes";

type SnsBody = Record<string, string>;

const SNS_TYPES = new Set(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]);
export const MAX_SNS_BODY_BYTES = 256 * 1024;
const MAX_SNS_CERT_BYTES = 64 * 1024;

export async function readSnsJson(request: Request): Promise<{ body?: unknown; tooLarge?: true }> {
  try {
    const bytes = await streamToBytes(request.body!, MAX_SNS_BODY_BYTES);
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    if (error instanceof Error && error.name === "BodyTooLargeError") return { tooLarge: true };
    return {};
  }
}

function isSnsBody(body: unknown): body is SnsBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.Type === "string" && SNS_TYPES.has(b.Type) &&
    typeof b.Message === "string" &&
    typeof b.MessageId === "string" &&
    typeof b.TopicArn === "string" &&
    typeof b.Timestamp === "string" &&
    typeof b.SignatureVersion === "string" &&
    typeof b.Signature === "string" &&
    typeof b.SigningCertURL === "string";
}

function canonicalSnsString(body: SnsBody): string {
  if (body.Type === "Notification") {
    const keys = body.Subject
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "Timestamp", "TopicArn", "Type"];
    return keys.map((key) => `${key}\n${body[key]}\n`).join("");
  }
  return ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
    .map((key) => `${key}\n${body[key]}\n`).join("");
}

function isAllowedSigningCertUrl(value: string, region: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hostname === `sns.${region}.amazonaws.com` &&
      url.pathname.startsWith("/SimpleNotificationService-") &&
      url.pathname.endsWith(".pem") &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function pemToDer(pem: string, label: "PUBLIC KEY" | "CERTIFICATE"): Uint8Array | null {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (!match) return null;
  return fromBase64(match[1]!.replace(/\s+/g, ""));
}

function readLength(bytes: Uint8Array, offset: number): { length: number; offset: number } {
  const first = bytes[offset++];
  if (first === undefined) throw new Error("truncated der length");
  if ((first & 0x80) === 0) return { length: first, offset };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new Error("invalid der length");
  let length = 0;
  for (let i = 0; i < count; i++) {
    const b = bytes[offset++];
    if (b === undefined) throw new Error("truncated der length");
    length = (length << 8) | b;
  }
  return { length, offset };
}

function readTlv(bytes: Uint8Array, offset: number): { tag: number; start: number; valueStart: number; end: number } {
  const start = offset;
  const tag = bytes[offset++];
  if (tag === undefined) throw new Error("truncated der tag");
  const len = readLength(bytes, offset);
  const valueStart = len.offset;
  const end = valueStart + len.length;
  if (end > bytes.length) throw new Error("truncated der value");
  return { tag, start, valueStart, end };
}

function extractSpkiFromCertificate(cert: Uint8Array): Uint8Array {
  const certSeq = readTlv(cert, 0);
  if (certSeq.tag !== 0x30) throw new Error("invalid certificate");
  const tbs = readTlv(cert, certSeq.valueStart);
  if (tbs.tag !== 0x30) throw new Error("invalid certificate tbs");

  let offset = tbs.valueStart;
  const first = readTlv(cert, offset);
  if (first.tag === 0xa0) offset = first.end; // optional version
  for (let i = 0; i < 5; i++) offset = readTlv(cert, offset).end; // serial, signature, issuer, validity, subject
  const spki = readTlv(cert, offset);
  if (spki.tag !== 0x30) throw new Error("missing certificate public key");
  return cert.subarray(spki.start, spki.end);
}

function publicKeyDerFromPem(pem: string): Uint8Array {
  const publicKey = pemToDer(pem, "PUBLIC KEY");
  if (publicKey) return publicKey;
  const cert = pemToDer(pem, "CERTIFICATE");
  if (!cert) throw new Error("missing public key");
  return extractSpkiFromCertificate(cert);
}

export async function verifySnsMessage(
  body: unknown,
  options: { region: string; fetchCert?: typeof fetch },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!isSnsBody(body)) return { ok: false, error: "invalid sns body" };
    if (!options.region) return { ok: false, error: "missing sns region" };
    if (body.SignatureVersion !== "1" && body.SignatureVersion !== "2") {
      return { ok: false, error: "unsupported sns signature version" };
    }
    if ((body.Type === "SubscriptionConfirmation" || body.Type === "UnsubscribeConfirmation") &&
      (typeof body.SubscribeURL !== "string" || typeof body.Token !== "string")) {
      return { ok: false, error: "invalid sns confirmation body" };
    }
    const signingCertUrl = body.SigningCertURL!;
    const signature = body.Signature!;
    if (!isAllowedSigningCertUrl(signingCertUrl, options.region)) {
      return { ok: false, error: "invalid sns signing cert url" };
    }

    const certFetch = options.fetchCert ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let certRes: Response;
    try {
      certRes = await certFetch(signingCertUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!certRes.ok) return { ok: false, error: "sns cert fetch failed" };
    if (!certRes.body) return { ok: false, error: "sns cert fetch failed" };
    const certPem = new TextDecoder().decode(await streamToBytes(certRes.body, MAX_SNS_CERT_BYTES));
    const hash = body.SignatureVersion === "2" ? "SHA-256" : "SHA-1";
    const key = await crypto.subtle.importKey(
      "spki",
      publicKeyDerFromPem(certPem),
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64(signature),
      utf8(canonicalSnsString(body)),
    );
    return valid ? { ok: true } : { ok: false, error: "invalid sns signature" };
  } catch {
    return { ok: false, error: "sns verification failed" };
  }
}
