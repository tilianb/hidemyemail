import { expect, test } from "vitest";
import { verifySnsMessage } from "../src/lib/sns";
import { makeSignedSnsBody } from "./sns-signature";

const ARN = "arn:aws:sns:ap-southeast-2:123:ses-notifs";
const X509_CERT = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUanfCU0lxEm4oc7Ar5bpvztPBBVUwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIc25zLnRlc3QwHhcNMjYwOTMwMDM1MjQ0WhcNMzYwOTI3
MDM1MjQ0WjATMREwDwYDVQQDDAhzbnMudGVzdDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBALBs0uI9GxYkJtKAkMg8httTUfUqrTb8e+PrGhx6yVToz9/G
eEk2ndpolV7VWr8mQS5etP8BvpL/7dE7rA23dBa9G4I1x3J/clpXmEdQ0yIKe11q
hkjyRFWwjhtoXimUM3GZx992/J+AHXS69AAlG9cW6kkzM+9AolJQmUCjbitq4Pt9
PQ54e0Ys+Q24zwxCHBYR7KWoh2Hndrfg969iVyK59ZzWEKXHYw7x55b7CzgohZy5
hlhLJILP3z9YQTiE8r05FX/rq9nosEA8ut+aYb8+oMbS1CXmfjnXIu93urpVtDk1
kMVRSSkuOn0Ov7PQYJ0MlaG2a9G11LUkenHI1N0CAwEAAaNTMFEwHQYDVR0OBBYE
FGDlVcI1v3gNy1C8Bi4CSz5Be/tTMB8GA1UdIwQYMBaAFGDlVcI1v3gNy1C8Bi4C
Sz5Be/tTMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAKmyUZfY
r7Yaz0DyCfgwQarfbuI9OFuUqsDnyubv1+ZehRR/UsalvayvnVhXAKobQorTYlXp
veQF8oiTAfMUF5m1PQxvVLeM3Vgva7Tlnadg0+VltaB2QMQWoBdRQTfdVtD6FyEW
I5XR/BM/VRco1euvfBfsK9xHOD46Ui6diPD3GwinYdobvw6yMs6Hh9RwutWnwxMe
5rtxpZxifrH6lcfEanLBbPfqAWmk7I3948I3rmup/haogQGS7AJo/ySghHA5EDg/
qNXvtt+oP5oN1v1oBtRM4Xr+zGUvMrK/iCNgZyKo5TVh2pRNYZEHRcwhg5HkP6QF
gIwIBkjMIluYMqo=
-----END CERTIFICATE-----`;

test.each(["1", "2"] as const)("verifies SNS signature version %s with a PUBLIC KEY fixture", async (signatureVersion) => {
  const signed = await makeSignedSnsBody({ topicArn: ARN, signatureVersion });
  expect(await verifySnsMessage(signed.body, {
    region: "ap-southeast-2",
    fetchCert: async () => new Response(signed.certPem),
  })).toEqual({ ok: true });
});

test("rejects a tampered SNS canonical field", async () => {
  const signed = await makeSignedSnsBody({ topicArn: ARN, subject: "original" });
  signed.body.Subject = "tampered";
  expect(await verifySnsMessage(signed.body, {
    region: "ap-southeast-2",
    fetchCert: async () => new Response(signed.certPem),
  })).toEqual({ ok: false, error: "invalid sns signature" });
});

test("parses an X.509 certificate before rejecting a mismatched signature", async () => {
  const signed = await makeSignedSnsBody({ topicArn: ARN });
  expect(await verifySnsMessage(signed.body, {
    region: "ap-southeast-2",
    fetchCert: async () => new Response(X509_CERT),
  })).toEqual({ ok: false, error: "invalid sns signature" });
});

test("rejects malformed certificates and disallowed certificate URLs", async () => {
  const signed = await makeSignedSnsBody({ topicArn: ARN });
  expect(await verifySnsMessage(signed.body, {
    region: "ap-southeast-2",
    fetchCert: async () => new Response("-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----"),
  })).toEqual({ ok: false, error: "sns verification failed" });

  signed.body.SigningCertURL = "https://sns.ap-southeast-2.amazonaws.com.evil.test/SimpleNotificationService-test.pem";
  let fetched = false;
  expect(await verifySnsMessage(signed.body, {
    region: "ap-southeast-2",
    fetchCert: async () => { fetched = true; return new Response(X509_CERT); },
  })).toEqual({ ok: false, error: "invalid sns signing cert url" });
  expect(fetched).toBe(false);
});
