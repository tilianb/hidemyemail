/// <reference types="node" />
import { X509Certificate, createPublicKey, verify } from "node:crypto";
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

function publicKeyFromPem(pem: string) {
  return pem.includes("-----BEGIN CERTIFICATE-----")
    ? new X509Certificate(pem).publicKey
    : createPublicKey(pem);
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
    const hash = body.SignatureVersion === "2" ? "sha256" : "sha1";
    const valid = verify(
      hash,
      utf8(canonicalSnsString(body)),
      publicKeyFromPem(certPem),
      fromBase64(signature),
    );
    return valid ? { ok: true } : { ok: false, error: "invalid sns signature" };
  } catch {
    return { ok: false, error: "sns verification failed" };
  }
}
