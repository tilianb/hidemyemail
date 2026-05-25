import { expect, test } from "vitest";
import { routeEmail } from "../src/email/router";

test("routes reverse-alias to reply, else inbound", async () => {
  const calls: string[] = [];
  const deps = {
    handleInbound: async () => { calls.push("inbound"); },
    handleReply: async (_m: any, _e: any, t: string) => { calls.push("reply:" + t); },
  };
  const env = { REVERSE_PREFIX: "r." } as any;
  await routeEmail({ to: "r.abc@hidemyemail.dev" } as any, env, deps);
  await routeEmail({ to: "shop@hidemyemail.dev" } as any, env, deps);
  expect(calls).toEqual(["reply:abc", "inbound"]);
});
