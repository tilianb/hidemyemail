import { createContext, useContext, useEffect, useState, useMemo, type ReactNode } from "react";
import { api } from "./api";

const Ctx = createContext<{ authed: boolean; isAdmin: boolean; setAuthed: (v: boolean) => void; loading: boolean }>({
  authed: false,
  isAdmin: false,
  setAuthed: () => {},
  loading: true,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stats()
      .then((data) => {
        setAuthed(true);
        setIsAdmin(!!data.isAdmin);
      })
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo(() => ({ authed, isAdmin, setAuthed, loading }), [authed, isAdmin, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
