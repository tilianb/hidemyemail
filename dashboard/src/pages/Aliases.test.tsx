import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ToastProvider } from "../ui";
import { Aliases } from "./Aliases";

vi.mock("../auth", () => ({ useAuth: () => ({ accountId: 12 }) }));
vi.mock("../api", async importOriginal => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: {
    ...original.api,
    aliases: vi.fn(), domains: vi.fn(), destinations: vi.fn(), config: vi.fn(),
    createAlias: vi.fn(), patchAlias: vi.fn(), deleteAlias: vi.fn(),
  } };
});

const mockedApi = vi.mocked(api);

describe("Aliases query pilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.domains.mockResolvedValue([]);
    mockedApi.destinations.mockResolvedValue([]);
    mockedApi.config.mockResolvedValue({ max_total_aliases: -1, alias_quota_buffer_enabled: true } as never);
  });

  it("renders aliases loaded through the account-scoped query", async () => {
    mockedApi.aliases.mockResolvedValue([{ id: 1, full_address: "pilot@example.com", local_part: "pilot", active: 1, source: "manual", fwd_count: 0, reply_count: 0, blocked_count: 0 }] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ToastProvider><Aliases /></ToastProvider></QueryClientProvider>);
    expect(await screen.findByText("pilot@example.com")).toBeVisible();
    expect(client.getQueryData(["account", 12, "aliases", "list", ""])).toBeDefined();
  });

  it("surfaces a loading error without retrying", async () => {
    mockedApi.aliases.mockRejectedValue(new Error("unauthorized"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ToastProvider><Aliases /></ToastProvider></QueryClientProvider>);
    expect(await screen.findByText("Failed to load aliases")).toBeVisible();
    expect(mockedApi.aliases).toHaveBeenCalledOnce();
  });
});
