import { createContext, useContext, useEffect, useState, useMemo, type ReactNode, useCallback } from "react";
import { api } from "./api";

const Ctx = createContext<{ 
  authed: boolean; 
  isAdmin: boolean; 
  userName: string; 
  setAuthed: (v: boolean) => void; 
  refreshAuth: () => Promise<void>;
  loading: boolean 
}>({
  authed: false,
  isAdmin: false,
  userName: "",
  setAuthed: () => {},
  refreshAuth: async () => {},
  loading: true,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(true);

  const refreshAuth = useCallback(async () => {
    try {
      const data = await api.stats();
      setAuthed(true);
      setIsAdmin(!!data.isAdmin);
      setUserName(data.userName || "");
    } catch {
      setAuthed(false);
      setIsAdmin(false);
      setUserName("");
    }
  }, []);

  useEffect(() => {
    refreshAuth().finally(() => setLoading(false));
  }, [refreshAuth]);

  const value = useMemo(() => ({ authed, isAdmin, userName, setAuthed, refreshAuth, loading }), [authed, isAdmin, userName, refreshAuth, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
