import { AwsClient } from "aws4fetch";
import type { SesCreds } from "./ses";

/**
 * Fetch a raw S3 object using SigV4.
 * Uses the same IAM creds as SES (requires s3:GetObject on the bucket).
 * SES message IDs are alphanumeric+hyphen — no URL encoding needed for the key.
 */
export async function fetchS3Object(
  creds: SesCreds,
  bucket: string,
  key: string,
  fetchImpl?: typeof fetch
): Promise<Uint8Array> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    service: "s3",
  });
  const url = `https://${bucket}.s3.${creds.region}.amazonaws.com/${key}`;
  const signed = await aws.sign(url, { method: "GET" });
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(signed);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 ${res.status}: ${text}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
