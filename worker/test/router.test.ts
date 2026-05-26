import { expect, test } from "vitest";
import { routeEmail } from "../src/email/router";

test("routes reverse-alias to reply, else inbound", async () => {
  const calls: string[] = [];
  const deps = {
    handleInbound: async () => { calls.push("inbound"); },
    handleReply: async (_m: any, _e: any, p: any) => { calls.push(`reply:${p.aliasLocal}:${p.externalSender}`); },
    handleAction: async (_m: any, _e: any, t: any, p: any) => { calls.push(`action:${t}:${p}`); },
  };
  await routeEmail({ to: "shop+alice=store.com@hidemyemail.dev" } as any, {} as any, deps);
  await routeEmail({ to: "action+disable=123_abc@hidemyemail.dev" } as any, {} as any, deps);
  await routeEmail({ to: "shop@hidemyemail.dev" } as any, {} as any, deps);
  expect(calls).toEqual(["reply:shop:alice@store.com", "action:disable:123_abc", "inbound"]);
});

test("threads SES auth verdicts into handleReply", async () => {
  let seen: any;
  const deps = {
    handleInbound: async () => {},
    handleReply: async (_m: any, _e: any, _p: any, auth: any) => { seen = auth; },
    handleAction: async () => {},
  };
  await routeEmail({ to: "shop+alice=store.com@hidemyemail.dev" } as any, {} as any, deps, { spf: "PASS" });
  expect(seen).toEqual({ spf: "PASS" });
});
