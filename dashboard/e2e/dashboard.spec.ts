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
    inbound_mx_host: "mx.gateway.example", outbound_spf_include: "spf.relay.example",
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
      "/api/stats": { isAdmin: true, userName: "Demo operator", totals: { aliases: 1, active: 1 }, last24h: { forward: 3, reply: 1, block: 0, reject: 0, error: 0 }, topAliases: [] },
      "/api/config": { max_total_aliases: 10, max_subdomains: 5, alias_quota_buffer_enabled: true },
      "/api/domains": [{ id: 1, domain: "example.com", is_global: 1, active: 1, allow_custom_aliases: 1, allow_subdomain_aliases: 1, verified_at: 1700000000000 }],
      "/api/destinations": [{ id: 1, email: "operator@example.net", created_at: 1700000000000, verified_at: 1700000000000, is_default: 1 }],
      "/api/blocks": [],
      "/api/aliases": [{ id: 1, domain_id: 1, full_address: `account${account}@example.com`, local_part: `account${account}`, active: 1, label: "Shopping", destination: null, source: "dashboard", fwd_count: 3, reply_count: 1, blocked_count: 0, created_at: 1700000000000, last_seen_at: null, muted_until: null }],
      "/api/admin/users": { users: [
        { id: 1, name: "Operator", created_at: 1700000000000, alias_count: 4, active: 1, forwarding: 1 },
        { id: 12, name: "Camille", created_at: 1700000000000, alias_count: 2, active: 0, forwarding: 1 },
      ] }, "/api/admin/stats": { totals: { users: 2, aliases: 6, active: 5 } },
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
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toBeInViewport();
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

test("admin users are searchable by name or ID with labelled controls", async ({ page, context }, info) => {
  await mockApi(context);
  await page.goto("/#admin");
  await page.locator(".admin-users-card").getByRole("button").click();
  await page.getByLabel("Find users").fill("camille");
  await expect(page.getByText("Camille", { exact: true })).toBeVisible();
  await expect(page.locator(".admin-users-table tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Allow login for user #12")).not.toBeChecked();
  await expect(page.getByLabel("Forward email for user #12")).toBeChecked();
  await page.getByLabel("Find users").fill("#1");
  await expect(page.locator(".admin-users-table tbody tr")).toHaveCount(1);
  await page.getByLabel("Find users").fill("missing");
  await expect(page.getByText("No matching users", { exact: true })).toBeVisible();
  await page.getByLabel("Find users").fill("");
  await page.screenshot({ path: info.outputPath("admin-users.png"), animations: "disabled" });
});

test("admin loading failures offer retry instead of empty controls", async ({ page, context }, info) => {
  await mockApi(context);
  await page.route("**/api/admin/users", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/#admin");
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible();
  await expect(page.locator(".admin-domain-form")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("admin-load-error.png"), animations: "disabled" });
  await page.unroute("**/api/admin/users");
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeHidden();
  await expect(page.getByText("System Settings", { exact: true })).toBeVisible();
});

test("alias resource failure can be retried without creating against missing options", async ({ page, context }, info) => {
  await mockApi(context);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route("**/api/domains", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/#aliases");
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible();
  await page.getByLabel("Local part").fill("new-alias");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("alias-options-error.png"), animations: "disabled" });
  await page.unroute("**/api/domains");
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
});

for (const width of [390, 768, 1280]) {
  test(`form fields stay readable at ${width}px`, async ({ page, context }, info) => {
    await mockApi(context);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#admin");
    await page.getByText("System Settings", { exact: true }).click();
    await page.getByLabel("SMTP inbound gateway ID").waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const description of await page.locator(".admin-settings-card .setting-info").all()) {
      expect((await description.boundingBox())!.width).toBeGreaterThanOrEqual(200);
    }
    const clipped = await page.locator(".admin-settings-card select").evaluateAll(elements => elements.flatMap(element => {
      const select = element as HTMLSelectElement;
      const style = getComputedStyle(select);
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const longest = Math.max(...Array.from(select.options, option => canvas.measureText(option.text).width));
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24;
      return longest > available ? [select.id || select.getAttribute("aria-label")] : [];
    }));
    expect(clipped).toEqual([]);
    for (const name of ["SMTP inbound gateway ID", "SMTP inbound trusted peers", "SMTP outbound password"]) {
      const field = page.getByLabel(name, { exact: true });
      await expect(field.locator("xpath=ancestor::label")).toBeVisible();
      expect((await field.boundingBox())!.width).toBeGreaterThan(240);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Limits", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Limits & quotas" })).toBeFocused();
    await expect(page.getByRole("heading", { name: "Limits & quotas" })).toBeInViewport();
    await page.getByLabel("SMTP inbound gateway ID").scrollIntoViewIfNeeded();
    await page.getByLabel("SMTP inbound gateway ID").focus();
    const savebar = await page.locator(".admin-settings-savebar").boundingBox();
    const field = await page.getByLabel("SMTP inbound gateway ID").boundingBox();
    expect(field!.y + field!.height).toBeLessThanOrEqual(savebar!.y);
    if (width === 390) {
      const nav = await page.locator(".sidebar").boundingBox();
      expect(savebar!.y + savebar!.height).toBeLessThanOrEqual(nav!.y);
    }
    await page.screenshot({ path: info.outputPath(`receiving-${width}.png`), animations: "disabled" });
    await page.goto("/#settings");
    await page.getByRole("button", { name: "Create API Key", exact: true }).click();
    expect((await page.getByPlaceholder("e.g. Bitwarden").boundingBox())!.width).toBeGreaterThan(240);
    await page.screenshot({ path: info.outputPath(`account-fields-${width}.png`), animations: "disabled" });
  });
}

test("custom-provider DNS records match saved configuration", async ({ page, context }, info) => {
  await mockApi(context);
  await page.goto("/#admin");
  await page.locator(".admin-domain-card").getByRole("button", { name: "Show" }).click();
  await page.getByRole("button", { name: "DNS records", exact: true }).click();
  await expect(page.getByText("mx.gateway.example", { exact: true })).toHaveCount(2);
  await expect(page.getByText("v=spf1 include:spf.relay.example ~all", { exact: true })).toBeVisible();
  await page.locator(".admin-domain-card").screenshot({ path: info.outputPath("provider-dns.png"), animations: "disabled" });
});

for (const width of [390, 1280]) {
  test(`dashboard page audit at ${width}px`, async ({ page, context }, info) => {
    await mockApi(context);
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ["domains", "aliases", "destinations", "blocks", "stats", "settings", "admin"]) {
      await page.goto(`/#${tab}`);
      await expect(page.locator(".page-title")).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), tab).toBe(true);
      const overflow = await page.locator("input.input:visible, select.input:visible").evaluateAll(fields => fields.flatMap(field => {
        const rect = field.getBoundingClientRect();
        return rect.x < 0 || rect.right > innerWidth || rect.width < 80 ? [field.outerHTML] : [];
      }));
      expect(overflow, tab).toEqual([]);
      const clippedHints = await page.locator("input[placeholder]:visible").evaluateAll(fields => fields.flatMap(field => {
        const input = field as HTMLInputElement;
        if (input.value) return [];
        const style = getComputedStyle(input);
        const canvas = document.createElement("canvas").getContext("2d")!;
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return canvas.measureText(input.placeholder).width > input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          ? [input.placeholder] : [];
      }));
      expect(clippedHints, tab).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${tab}-${width}.png`), animations: "disabled" });
    }
    await page.route("**/api/account/profile", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
    await page.route("**/api/stats", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
    for (const path of ["/", "/recover"]) {
      await page.goto(path);
      await expect(page.locator("input").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${path === "/" ? "login" : "recovery"}-${width}.png`), animations: "disabled" });
    }
  });
}
