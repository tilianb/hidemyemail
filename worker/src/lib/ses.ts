import { AwsClient } from "aws4fetch";

export class SesTransientError extends Error {}
export class SesPermanentError extends Error {}

export interface SesCreds { accessKeyId: string; secretAccessKey: string; region: string; }
export interface SesRawMessage { from: string; to: string; rawBase64: string; feedbackForwarding?: string; }

// Keep the request bound below mail.ts's five-minute in-flight deadline. If a
// process dies after remote acceptance but before persisting it, no API can
// prove acceptance; deadline takeover may then duplicate that one message.
const SES_REQUEST_TIMEOUT_MS = 4 * 60_000;

export async function sendRaw(
  creds: SesCreds, msg: SesRawMessage, fetchImpl?: typeof fetch,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    service: "ses", // CRITICAL: host is email.* so auto-parse would pick "email"
  });
  const url = `https://email.${creds.region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify({
    FromEmailAddress: msg.from,
    Destination: { ToAddresses: [msg.to] },
    Content: { Raw: { Data: msg.rawBase64 } },
    ...(msg.feedbackForwarding ? { FeedbackForwardingEmailAddress: msg.feedbackForwarding } : {}),
  });
  const signed = await aws.sign(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(signed.url, {
      method: "POST", headers: signed.headers, body,
      signal: AbortSignal.timeout(options.timeoutMs ?? SES_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SesTransientError(`SES request failed: ${String(error)}`);
  }
  if (res.ok) {
    const json = await res.json<{ MessageId: string }>();
    return json.MessageId;
  }
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) throw new SesTransientError(`SES ${res.status}: ${text}`);
  throw new SesPermanentError(`SES ${res.status}: ${text}`);
}
