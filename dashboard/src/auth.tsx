import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

const Ctx = createContext<{ authed: boolean; setAuthed: (v: boolean) => void }>({ authed: false, setAuthed: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  useEffect(() => { api.stats().then(() => setAuthed(true)).catch(() => setAuthed(false)); }, []);
  return <Ctx.Provider value={{ authed, setAuthed }}>{children}</Ctx.Provider>;
}
