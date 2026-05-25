import { createContext, useContext, useEffect, useState, useMemo, type ReactNode } from "react";
import { api } from "./api";

const Ctx = createContext<{ authed: boolean; setAuthed: (v: boolean) => void; loading: boolean }>({
  authed: false,
  setAuthed: () => {},
  loading: true,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stats()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo(() => ({ authed, setAuthed, loading }), [authed, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
