import { expect, test, type BrowserContext } from "@playwright/test";

// Deterministic, synthetic data. The Worker separately tests the actual cookie
// guard; here two real tabs exercise the dashboard's binding and presentation.
async function mockApi(context: BrowserContext) {
  let fresh = false;
  let deletes = 0;
  const settings = Object.fromEntries(Object.entries({
    mail_outbound_provider: "smtp", smtp_outbound_host: "smtp.example.com",
    smtp_outbound_port: "587", smtp_outbound_tls: "starttls",
    smtp_outbound_username: "•••••• configured", smtp_outbound_password: "•••••• configured",
    smtp_inbound_enabled: "true", smtp_inbound_host: "127.0.0.1", smtp_inbound_port: "2525",
    smtp_inbound_tls: "starttls", smtp_inbound_gateway_id: "gateway-1",
    smtp_inbound_username: "•••••• configured", smtp_inbound_password: "•••••• configured",
    max_inbound_bytes: "26214400", ses_region: "us-east-1",
  }).map(([key, value]) => [key, { value, updated_at: 1, source: "override" }]));
  await context.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const cookie = request.headers().cookie ?? "";
    const account = Number(/test-account=(\d+)/.exec(cookie)?.[1] ?? 7);
    const expected = request.headers()["x-expected-user-id"];
    if (expected && Number(expected) !== account) {
      await route.fulfill({ status: 409, json: { error: "The signed-in account changed. Please reload this tab." } });
      return;
    }
    if (path === "/api/settings/reauth") { fresh = true; await route.fulfill({ json: { ok: true } }); return; }
    if (path === "/api/admin/settings" && request.method() === "PATCH") {
      if (!fresh) { await route.fulfill({ status: 401, json: { code: "fresh_auth_required", error: "Fresh authentication required" } }); return; }
      await route.fulfill({ json: { ok: true, restart_required: true } }); return;
    }
    if (path === "/api/aliases/1" && request.method() === "DELETE") {
      deletes++; await route.fulfill({ json: { ok: true } }); return;
    }
    const responses: Record<string, unknown> = {
      "/api/account/profile": { id: account, username: "demo", isAdmin: true, recovery_codes_remaining: 10 },
      "/api/stats": { isAdmin: true, userName: "Demo operator", totals: { aliases: 1, active: 1 }, last24h: {}, topAliases: [] },
      "/api/config": { max_total_aliases: 10, alias_quota_buffer_enabled: true },
      "/api/domains": [], "/api/destinations": [],
      "/api/aliases": [{ id: 1, domain_id: 1, full_address: `account${account}@example.com`, local_part: `account${account}`, active: 1, label: "Shopping", destination: null, source: "dashboard", fwd_count: 3, reply_count: 1, blocked_count: 0, created_at: 1700000000000, last_seen_at: null, muted_until: null }],
      "/api/admin/users": { users: [] }, "/api/admin/stats": { totals: { users: 1, aliases: 1, active: 1 } },
      "/api/admin/env": { vars: { SES_REGION: { value: "us-east-1", secret: false } }, secrets: {} },
      "/api/admin/settings": { settings },
      "/api/admin/suppressions": { suppressions: [], totals: {}, health: "healthy" },
      "/api/settings/mfa": { enabled: false, backupCodesRemaining: 0 },
      "/api/settings/passkeys": [], "/api/settings/api-keys": [],
      "/api/settings/preferences": { inline_actions_pref: null, inline_actions_position: null, defaults: { inline_actions_enabled: false, inline_actions_position: "footer" } },
    };
    if (!(path in responses)) throw new Error(`Unexpected mock API request: ${request.method()} ${path}`);
    await route.fulfill({ json: responses[path] });
  });
  return { deletes: () => deletes };
}

test("alias dialog stays centered, traps focus, and restores it", async ({ page, context }, info) => {
  await mockApi(context);
  await page.goto("/#aliases");
  const trigger = page.getByTitle("Delete alias", { exact: true });
  await trigger.click();
  const dialog = page.getByRole("alertdialog", { name: "Delete alias" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Delete alias" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const box = await dialog.boundingBox();
  expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThan(3);
  await page.screenshot({ path: info.outputPath("alias-dialog.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a shared-cookie account change cannot retarget a stale tab mutation", async ({ page, context }) => {
  const state = await mockApi(context);
  await page.goto("/#aliases");
  await expect(page.getByText("account7@example.com", { exact: true })).toBeVisible();
  await context.addCookies([{ name: "test-account", value: "8", url: "http://127.0.0.1:4173" }]);
  const other = await context.newPage();
  await other.goto("/#aliases");
  await expect(other.getByText("account8@example.com", { exact: true })).toBeVisible();
  await page.getByTitle("Delete alias", { exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete alias" }).click();
  await expect(page.getByText("Failed to delete alias", { exact: true })).toBeVisible();
  expect(state.deletes()).toBe(0);
});

test("mail settings render expanded and elevate through the shared prompt", async ({ page, context }, info) => {
  await mockApi(context);
  await page.goto("/#admin");
  await page.getByText("System Settings", { exact: true }).click();
  await expect(page.getByLabel("SMTP inbound gateway ID")).toHaveValue("gateway-1");
  await page.getByLabel("SMTP outbound host").fill("relay.example.com");
  await page.locator(".admin-settings-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("mail-settings.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath("fresh-auth.png"), animations: "disabled" });
  await page.getByLabel("Passphrase", { exact: true }).fill("synthetic-test-passphrase");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  await page.goto("/#settings");
  await expect(page.getByLabel("Inline action links")).toHaveValue("inherit");
  await page.screenshot({ path: info.outputPath("account-settings.png"), animations: "disabled" });
});
