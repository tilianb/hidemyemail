import { createContext, useContext, useEffect, useState, useMemo, type ReactNode, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

interface AuthContextValue {
  authed: boolean; 
  isAdmin: boolean; 
  userName: string; 
  accountId: number | null;
  setAuthed: (v: boolean) => void; 
  refreshAuth: () => Promise<void>;
  loading: boolean;
}

const Ctx = createContext<AuthContextValue>({
  authed: false,
  isAdmin: false,
  userName: "",
  accountId: null,
  setAuthed: () => {},
  refreshAuth: async () => {},
  loading: true,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const accountRef = useRef<number | null>(null);
  const generation = useRef(0);

  const clearAccount = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
    accountRef.current = null;
    setAccountId(null);
  }, [queryClient]);

  const updateAuthed = useCallback((value: boolean) => {
    generation.current++;
    setAuthed(value);
    setLoading(false);
    if (!value) {
      clearAccount();
      setIsAdmin(false);
      setUserName("");
    }
  }, [clearAccount]);

  const refreshAuth = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      // profile() establishes this tab's X-Expected-User-ID binding before
      // any account data is requested.
      const profile = await api.profile();
      if (requestGeneration !== generation.current) return;
      if (accountRef.current !== null && accountRef.current !== profile.id) clearAccount();
      accountRef.current = profile.id;
      setAccountId(profile.id);
      const data = await api.stats();
      if (requestGeneration !== generation.current) return;
      setAuthed(true);
      setIsAdmin(!!data.isAdmin);
      setUserName(data.userName || "");
    } catch {
      if (requestGeneration === generation.current) updateAuthed(false);
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [clearAccount, updateAuthed]);

  useEffect(() => {
    void refreshAuth();
    return () => { generation.current++; };
  }, [refreshAuth]);

  const value = useMemo(() => ({ authed, isAdmin, userName, accountId, setAuthed: updateAuthed, refreshAuth, loading }), [authed, isAdmin, userName, accountId, updateAuthed, refreshAuth, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
