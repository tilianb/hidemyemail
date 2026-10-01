import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export const aliasKeys = {
  account: (accountId: number) => ["account", accountId, "aliases"] as const,
  list: (accountId: number, search: string) => [...aliasKeys.account(accountId), "list", search] as const,
};

export function useAliases(accountId: number | null, search: string) {
  return useQuery({
    queryKey: aliasKeys.list(accountId ?? 0, search),
    queryFn: () => api.aliases(search),
    enabled: accountId !== null,
  });
}

function useAliasMutation<TVariables>(accountId: number | null, mutationFn: (variables: TVariables) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => accountId === null
      ? undefined
      : client.invalidateQueries({ queryKey: aliasKeys.account(accountId) }),
  });
}

export function useCreateAlias(accountId: number | null) {
  return useAliasMutation(accountId, api.createAlias);
}

export function usePatchAlias(accountId: number | null) {
  return useAliasMutation(accountId, ({ id, data }: { id: number; data: Record<string, unknown> }) => api.patchAlias(id, data));
}

export function useDeleteAlias(accountId: number | null) {
  return useAliasMutation(accountId, (id: number) => api.deleteAlias(id));
}
