import { createContext, useContext, useEffect, useState, useMemo, type ReactNode } from "react";
import { api } from "./api";

const Ctx = createContext<{ authed: boolean; isAdmin: boolean; userName: string; setAuthed: (v: boolean) => void; loading: boolean }>({
  authed: false,
  isAdmin: false,
  userName: "",
  setAuthed: () => {},
  loading: true,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stats()
      .then((data) => {
        setAuthed(true);
        setIsAdmin(!!data.isAdmin);
        setUserName(data.userName || "");
      })
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo(() => ({ authed, isAdmin, userName, setAuthed, loading }), [authed, isAdmin, userName, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
