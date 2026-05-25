import { useState } from "react";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { Domains } from "./pages/Domains";
import { Aliases } from "./pages/Aliases";
import { Blocks } from "./pages/Blocks";
import { Stats } from "./pages/Stats";
import { api } from "./api";

export function App() {
  const { authed, setAuthed } = useAuth();
  const [tab, setTab] = useState<"domains" | "aliases" | "blocks" | "stats">("domains");
  if (!authed) return <Login />;
  return (
    <div style={{ maxWidth: 900, margin: "2rem auto", fontFamily: "system-ui" }}>
      <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button onClick={() => setTab("domains")}>Domains</button>
        <button onClick={() => setTab("aliases")}>Aliases</button>
        <button onClick={() => setTab("blocks")}>Blocks</button>
        <button onClick={() => setTab("stats")}>Stats</button>
        <button style={{ marginLeft: "auto" }} onClick={async () => { await api.logout(); setAuthed(false); }}>Logout</button>
      </nav>
      {tab === "domains" && <Domains />}
      {tab === "aliases" && <Aliases />}
      {tab === "blocks" && <Blocks />}
      {tab === "stats" && <Stats />}
    </div>
  );
}
