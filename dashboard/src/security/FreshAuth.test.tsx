import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FreshAuthRequiredError, api } from "../api";
import { FreshAuthDialog, useFreshAuth } from "./FreshAuth";

const startAuthentication = vi.fn();
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));

vi.mock("../api", async importOriginal => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: { ...original.api, profile: vi.fn(), mfaStatus: vi.fn(), passkeyList: vi.fn(), reauth: vi.fn(), reauthPasskeyChallenge: vi.fn(), reauthPasskeyComplete: vi.fn() } };
});

const mockedApi = vi.mocked(api);

function Harness({ operation }: { operation: () => Promise<void> }) {
  const [messages, setMessages] = useState<string[]>([]);
  const fresh = useFreshAuth({ onError: message => setMessages(value => [...value, message]) });
  return <>
    <button onClick={() => void fresh.guard(operation, operation).catch(error => setMessages(value => [...value, error.message]))}>Run</button>
    <button onClick={() => fresh.cancel()}>Cancel externally</button>
    <output>{messages.join("|")}</output>
    <FreshAuthDialog controller={fresh} body="Sensitive action" />
  </>;
}

describe("fresh-auth continuation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens after the Strict Mode effect cleanup/setup cycle", async () => {
    mockedApi.profile.mockResolvedValue({ id: 7 } as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<StrictMode><Harness operation={vi.fn().mockRejectedValue(new FreshAuthRequiredError())} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("does not replay after unmount while the final account check is pending", async () => {
    let resolveProfile!: (value: unknown) => void;
    mockedApi.profile.mockResolvedValueOnce({ id: 7 } as never)
      .mockImplementationOnce(() => new Promise(resolve => { resolveProfile = resolve; }) as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    mockedApi.reauth.mockResolvedValue({ ok: true } as never);
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError()).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const view = render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.type(await screen.findByLabelText("Passphrase"), "secret");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockedApi.profile).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => resolveProfile({ id: 7 }));
    expect(operation).toHaveBeenCalledOnce();
  });

  it("replays a continuation no more than once", async () => {
    mockedApi.profile.mockResolvedValue({ id: 7 } as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    mockedApi.reauth.mockResolvedValue({ ok: true } as never);
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError()).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.type(await screen.findByLabelText("Passphrase"), "secret");
    await user.dblClick(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
  });

  it("does not open or replay after cancellation while preparation is pending", async () => {
    let resolveProfile!: (value: unknown) => void;
    mockedApi.profile.mockReturnValue(new Promise(resolve => { resolveProfile = resolve; }) as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError());
    const user = userEvent.setup();
    render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(mockedApi.profile).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Cancel externally" }));
    resolveProfile({ id: 7 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(operation).toHaveBeenCalledOnce();
  });

  it("abandons preparation when its owner unmounts", async () => {
    let resolveProfile!: (value: unknown) => void;
    mockedApi.profile.mockReturnValue(new Promise(resolve => { resolveProfile = resolve; }) as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError());
    const user = userEvent.setup();
    const view = render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(mockedApi.profile).toHaveBeenCalled());
    view.unmount();
    resolveProfile({ id: 7 });
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects replay when the account changes", async () => {
    mockedApi.profile.mockResolvedValueOnce({ id: 7 } as never).mockResolvedValueOnce({ id: 8 } as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([]);
    mockedApi.reauth.mockResolvedValue({ ok: true } as never);
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError());
    const user = userEvent.setup();
    render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.type(await screen.findByLabelText("Passphrase"), "secret");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/signed-in account changed/)).toBeVisible();
    expect(operation).toHaveBeenCalledOnce();
  });

  it("keeps the prompt available when passkey verification is cancelled", async () => {
    mockedApi.profile.mockResolvedValue({ id: 7 } as never);
    mockedApi.mfaStatus.mockResolvedValue({ enabled: false } as never);
    mockedApi.passkeyList.mockResolvedValue([{ id: "key" }] as never);
    mockedApi.reauthPasskeyChallenge.mockResolvedValue({ challenge: "test" } as never);
    startAuthentication.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    const operation = vi.fn().mockRejectedValueOnce(new FreshAuthRequiredError());
    const user = userEvent.setup();
    render(<Harness operation={operation} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(await screen.findByRole("button", { name: "Use Passkey" }));
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Confirm it’s you" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(operation).toHaveBeenCalledOnce();
  });
});
