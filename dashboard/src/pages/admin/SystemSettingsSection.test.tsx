import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FreshAuthRequiredError, api } from "../../api";
import { ToastProvider } from "../../ui";
import { SystemSettingsSection, type SettingsData } from "./SystemSettingsSection";

vi.mock("../../api", async importOriginal => {
  const original = await importOriginal<typeof import("../../api")>();
  return { ...original, api: { ...original.api, adminUpdateSettings: vi.fn(), adminSettings: vi.fn(), profile: vi.fn(), mfaStatus: vi.fn(), passkeyList: vi.fn(), reauth: vi.fn() } };
});

const mockedApi = vi.mocked(api);
const setting = (value: string, source: "override" | "environment" | "default" = "override") => ({ value, updated_at: 1, source });
const initial: SettingsData = {
  rate_limit_global: setting("1000"),
  max_inbound_bytes: setting("26214400"),
  mail_outbound_provider: setting("smtp"),
  smtp_outbound_host: setting("smtp.example.com"),
  smtp_outbound_password: setting("••••••••"),
  ses_secret_access_key: setting("••••••••"),
};

function mount() {
  render(<ToastProvider><SystemSettingsSection initialSettings={initial} globalDomains={[]} onSaved={vi.fn()} /></ToastProvider>);
}

async function open() {
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Show" }));
  return user;
}

describe("system settings editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.adminUpdateSettings.mockResolvedValue({ ok: true, updated: 1, reset: 0, restart_required: false });
    mockedApi.adminSettings.mockResolvedValue({ settings: initial });
  });

  it("sends only changed values and preserves untouched secret placeholders", async () => {
    const user = await open();
    const input = screen.getByLabelText("Global Rate Limit (emails/hr)");
    await user.clear(input); await user.type(input, "1200");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockedApi.adminUpdateSettings).toHaveBeenCalledWith({ rate_limit_global: "1200" }));
    expect(mockedApi.adminUpdateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ ses_secret_access_key: expect.anything(), smtp_outbound_password: expect.anything() }));
  });

  it("keeps reset null distinct from an empty credential", async () => {
    const user = await open();
    await user.click(screen.getAllByRole("button", { name: "Use environment" })[0]);
    expect(mockedApi.adminUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ smtp_outbound_password: null }));
  });

  it("discards drafts without changing saved mail configuration", async () => {
    const user = await open();
    const host = screen.getByLabelText("SMTP outbound host");
    await user.clear(host); await user.type(host, "draft.example.net");
    await user.clear(screen.getByLabelText("Max Inbound Email Size"));
    await user.type(screen.getByLabelText("Max Inbound Email Size"), "12");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(host).toHaveValue("smtp.example.com");
    expect(screen.getByLabelText("Max Inbound Email Size")).toHaveValue("25");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(mockedApi.adminUpdateSettings).not.toHaveBeenCalled();
  });

  it("does not send test mail with unsaved transport changes", async () => {
    const user = await open();
    await user.type(screen.getByLabelText("SMTP outbound host"), ".draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("attempts save before requesting fresh auth, then retries once", async () => {
    mockedApi.adminUpdateSettings.mockRejectedValueOnce(new FreshAuthRequiredError()).mockResolvedValueOnce({ ok: true, updated: 1, reset: 0, restart_required: false });
    mockedApi.profile.mockResolvedValue({ id: 1 } as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    mockedApi.reauth.mockResolvedValue({ ok: true } as never);
    const user = await open();
    const input = screen.getByLabelText("Global Rate Limit (emails/hr)");
    await user.clear(input); await user.type(input, "1200");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(mockedApi.adminUpdateSettings).toHaveBeenCalledTimes(1);
    await user.type(await screen.findByLabelText("Passphrase"), "secret");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockedApi.adminUpdateSettings).toHaveBeenCalledTimes(2));
  });
});
