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
  const { authed, setAuthed, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("domains");

  if (loading) {
    return (
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100dvh",
        background: "#0a0a0f",
        color: "#f3f4f6",
        fontFamily: "Outfit, Inter, system-ui, sans-serif"
      }}>
        <div style={{
          fontSize: "24px",
          fontWeight: 700,
          marginBottom: "20px",
          letterSpacing: "-0.03em"
        }}>
          hide<span style={{ padding: "2px 6px", margin: "0 2px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171", borderRadius: "4px" }}>my</span>email
        </div>
        <div style={{
          width: "24px",
          height: "24px",
          border: "2px solid rgba(248, 113, 113, 0.1)",
          borderTop: "2px solid #f87171",
          borderRadius: "50%",
          animation: "spin 1s linear infinite"
        }} />
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}} />
      </div>
    );
  }

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
