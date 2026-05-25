import { expect, test, vi } from "vitest";
import { sendRaw, SesTransientError, SesPermanentError } from "../src/lib/ses";

const creds = { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" };

test("posts signed request to SES v2 raw endpoint with correct body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ MessageId: "abc" }), { status: 200 });
  });
  const id = await sendRaw(creds, { from: "r.tok@d.dev", to: "boss@store.com", rawBase64: "QkFTRTY0" }, fetchMock as any);
  expect(id).toBe("abc");
  expect(calls[0]!.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  const body = JSON.parse(calls[0]!.init.body as string);
  expect(body.FromEmailAddress).toBe("r.tok@d.dev");
  expect(body.Destination.ToAddresses).toEqual(["boss@store.com"]);
  expect(body.Content.Raw.Data).toBe("QkFTRTY0");
});

test("maps status codes to error types", async () => {
  const f429 = async () => new Response("{}", { status: 429 });
  await expect(sendRaw(creds, { from: "a@d", to: "b@c", rawBase64: "x" }, f429 as any)).rejects.toBeInstanceOf(SesTransientError);
  const f400 = async () => new Response("{}", { status: 400 });
  await expect(sendRaw(creds, { from: "a@d", to: "b@c", rawBase64: "x" }, f400 as any)).rejects.toBeInstanceOf(SesPermanentError);
});
