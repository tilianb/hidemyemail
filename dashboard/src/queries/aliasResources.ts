import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export const aliasResourceKeys = {
  account: (accountId: number) => ["account", accountId, "alias-resources"] as const,
};

export function useAliasResources(accountId: number | null) {
  return useQuery({
    queryKey: aliasResourceKeys.account(accountId ?? 0),
    queryFn: async () => {
      const [domains, destinations, config] = await Promise.all([api.domains(), api.destinations(), api.config()]);
      return { domains, destinations, config };
    },
    enabled: accountId !== null,
  });
}
