import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AuthProvider, useAuth } from "./auth";

vi.mock("./api", async importOriginal => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: { ...original.api, profile: vi.fn(), stats: vi.fn() } };
});

const mockedApi = vi.mocked(api);

function Status() {
  const auth = useAuth();
  return <><output>{auth.loading ? "loading" : `${auth.accountId}:${auth.authed}`}</output><button onClick={() => auth.setAuthed(false)}>Sign out</button></>;
}

describe("account query lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not restore an account when an old refresh finishes after sign-out", async () => {
    let resolveStats!: (value: any) => void;
    mockedApi.profile.mockResolvedValue({ id: 7 } as never);
    mockedApi.stats.mockImplementation(() => new Promise(resolve => { resolveStats = resolve; }));
    const client = new QueryClient();
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><AuthProvider><Status /></AuthProvider></QueryClientProvider>);
    await waitFor(() => expect(mockedApi.stats).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await act(async () => resolveStats({ isAdmin: true, userName: "previous" }));
    expect(await screen.findByText("null:false")).toBeVisible();
  });

  it("binds the profile before loading account data and clears cache on sign-out", async () => {
    const order: string[] = [];
    mockedApi.profile.mockImplementation(async () => { order.push("profile"); return { id: 7 } as never; });
    mockedApi.stats.mockImplementation(async () => { order.push("stats"); return { totals: {}, last24h: {} } as never; });
    const client = new QueryClient();
    client.setQueryData(["account", 7, "aliases"], ["private"]);
    const clear = vi.spyOn(client, "clear");
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><AuthProvider><Status /></AuthProvider></QueryClientProvider>);
    expect(await screen.findByText("7:true")).toBeVisible();
    expect(order).toEqual(["profile", "stats"]);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(client.getQueryData(["account", 7, "aliases"])).toBeUndefined();
  });

  it("does not load stats when profile binding rejects an account change", async () => {
    mockedApi.profile.mockRejectedValue(new Error("The signed-in account changed. Please reload this tab."));
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><AuthProvider><Status /></AuthProvider></QueryClientProvider>);
    expect(await screen.findByText("null:false")).toBeVisible();
    expect(mockedApi.stats).not.toHaveBeenCalled();
  });
});
