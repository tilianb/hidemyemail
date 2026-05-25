import { useState } from "react";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { Domains } from "./pages/Domains";
import { Aliases } from "./pages/Aliases";
import { Blocks } from "./pages/Blocks";
import { Stats } from "./pages/Stats";
import { api } from "./api";
import { Globe, Mail, Ban, BarChart3, LogOut } from "lucide-react";

type Tab = "domains" | "aliases" | "blocks" | "stats";

const NAV = [
  { id: "domains" as Tab, label: "Domains", icon: Globe, title: "Managed domains" },
  { id: "aliases" as Tab, label: "Aliases", icon: Mail, title: "Email aliases" },
  { id: "blocks" as Tab, label: "Blocks", icon: Ban, title: "Blocked senders" },
  { id: "stats" as Tab, label: "Stats", icon: BarChart3, title: "Activity & stats" },
];

export function App() {
  const { authed, setAuthed } = useAuth();
  const [tab, setTab] = useState<Tab>("domains");

  if (!authed) return <Login />;

  return (
    <div id="app-shell" style={{ display: "flex", width: "100%", minHeight: "100dvh" }}>
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-logo">
            hide<span className="redact" title="my email" style={{ padding: "0 2px" }}>my</span>email
          </span>
          <div className="sidebar-logo-sub">.dev — privacy console</div>
        </div>

        <nav className="sidebar-nav">
          {NAV.map(n => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                className={`nav-item${tab === n.id ? " active" : ""}`}
                onClick={() => setTab(n.id)}
                title={n.title}
              >
                <span className="nav-icon">
                  <Icon size={16} />
                </span>
                <span className="nav-label">{n.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            className="nav-item"
            onClick={async () => { await api.logout(); setAuthed(false); }}
            title="Sign out"
          >
            <span className="nav-icon">
              <LogOut size={16} />
            </span>
            <span className="nav-label">Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="page-main">
        <div className="page-content">
          {tab === "domains" && <Domains />}
          {tab === "aliases" && <Aliases />}
          {tab === "blocks" && <Blocks />}
          {tab === "stats"  && <Stats />}
        </div>
      </main>
    </div>
  );
}
