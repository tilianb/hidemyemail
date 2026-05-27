type SnsType = "Notification" | "SubscriptionConfirmation";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function wrapPem(base64: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function canonicalSnsString(body: Record<string, string>): string {
  if (body.Type === "Notification") {
    const keys = body.Subject
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "Timestamp", "TopicArn", "Type"];
    return keys.map((key) => `${key}\n${body[key]}\n`).join("");
  }
  return ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
    .map((key) => `${key}\n${body[key]}\n`).join("");
}

export async function makeSignedSnsBody(input: {
  type?: SnsType;
  topicArn: string;
  region?: string;
  message?: string;
  subject?: string;
  subscribeUrl?: string;
  token?: string;
}): Promise<{ body: Record<string, string>; certPem: string }> {
  const region = input.region ?? "ap-southeast-2";
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const exportedSpki = await crypto.subtle.exportKey("spki", keyPair.publicKey) as ArrayBuffer;
  const spki = new Uint8Array(exportedSpki);
  const certPem = wrapPem(toBase64(spki));
  const type = input.type ?? "Notification";
  const body: Record<string, string> = {
    Type: type,
    MessageId: crypto.randomUUID(),
    TopicArn: input.topicArn,
    Message: input.message ?? "{}",
    Timestamp: "2026-05-27T00:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-test.pem`,
  };
  if (input.subject) body.Subject = input.subject;
  if (type === "SubscriptionConfirmation") {
    body.SubscribeURL = input.subscribeUrl ?? `https://sns.${region}.amazonaws.com/confirm?Token=abc`;
    body.Token = input.token ?? "abc";
  }
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(canonicalSnsString(body)),
  ));
  body.Signature = toBase64(signature);
  return { body, certPem };
}
