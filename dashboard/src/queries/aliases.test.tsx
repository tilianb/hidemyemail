import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { aliasKeys, useAliases, useCreateAlias } from "./aliases";

vi.mock("../api", async importOriginal => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: { ...original.api, aliases: vi.fn(), createAlias: vi.fn() } };
});

const mockedApi = vi.mocked(api);

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Searches() {
  const [search, setSearch] = useState("old");
  const query = useAliases(7, search);
  return <><button onClick={() => setSearch("new")}>New search</button><output>{query.data?.[0]?.full_address}</output></>;
}

describe("alias queries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not render a delayed result from an older search", async () => {
    let resolveOld!: (value: never[]) => void;
    mockedApi.aliases.mockImplementation(search => search === "old"
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve([{ id: 2, full_address: "new@example.com" }] as never));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(<Searches />, { wrapper: wrapper(client) });
    await user.click(screen.getByRole("button", { name: "New search" }));
    expect(await screen.findByText("new@example.com")).toBeVisible();
    resolveOld([{ id: 1, full_address: "old@example.com" }] as never);
    await waitFor(() => expect(screen.queryByText("old@example.com")).not.toBeInTheDocument());
  });

  it("isolates cache entries by account and invalidates alias lists after mutation", async () => {
    mockedApi.aliases.mockResolvedValue([]);
    mockedApi.createAlias.mockResolvedValue({ id: 3 } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function Mutation() {
      const mutation = useCreateAlias(8);
      return <button onClick={() => mutation.mutate({ domain_id: 1, local_part: "x" })}>Create</button>;
    }
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    render(<Mutation />, { wrapper: wrapper(client) });
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockedApi.createAlias).toHaveBeenCalledOnce());
    expect(aliasKeys.list(7, "x")).not.toEqual(aliasKeys.list(8, "x"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: aliasKeys.account(8) });
  });
});
