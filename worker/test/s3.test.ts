import { expect, test } from "vitest";
import { fetchS3Object } from "../src/lib/s3";

test("returns bytes from S3 object", async () => {
  const expected = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const mockFetch = async (_req: Request) => new Response(expected);
  const result = await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "abc123-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(result).toEqual(expected);
});

test("URL uses virtual-hosted S3 path", async () => {
  let capturedUrl = "";
  const mockFetch = async (req: Request) => {
    capturedUrl = req.url;
    return new Response(new Uint8Array([1]));
  };
  await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "my-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(capturedUrl).toContain("hidemyemail-inbound-raw.s3.ap-southeast-2.amazonaws.com");
  expect(capturedUrl).toContain("my-message-id");
});

test("request has SigV4 Authorization header", async () => {
  let capturedAuth = "";
  const mockFetch = async (req: Request) => {
    capturedAuth = req.headers.get("Authorization") ?? "";
    return new Response(new Uint8Array([1]));
  };
  await fetchS3Object(
    { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
    "hidemyemail-inbound-raw",
    "my-message-id",
    mockFetch as unknown as typeof fetch
  );
  expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256 /);
});

test("throws on non-OK S3 response", async () => {
  const mockFetch = async () => new Response("NoSuchKey", { status: 404 });
  await expect(
    fetchS3Object(
      { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "ap-southeast-2" },
      "hidemyemail-inbound-raw",
      "missing-key",
      mockFetch as unknown as typeof fetch
    )
  ).rejects.toThrow("S3 404");
});
