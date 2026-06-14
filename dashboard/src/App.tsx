import { useState } from "react";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { Domains } from "./pages/Domains";
import { Aliases } from "./pages/Aliases";
import { Blocks } from "./pages/Blocks";
import { Stats } from "./pages/Stats";
import { Destinations } from "./pages/Destinations";
import { Admin } from "./pages/Admin";
import { Settings } from "./pages/Settings";
import { Recover } from "./pages/Recover";
import { AppAuth } from "./pages/AppAuth";
import { api } from "./api";
import { Globe, Mail, Ban, BarChart3, LogOut, Send, Shield, Settings as SettingsIcon } from "lucide-react";
import { useToast } from "./ui";

type Tab = "domains" | "aliases" | "destinations" | "blocks" | "stats" | "settings" | "admin";

// `overflow` items leave the mobile bottom tab bar (max 5 tabs) and surface
// as icon buttons in the mobile top bar instead. Desktop sidebar shows all.
type NavItem = { id: Tab; label: string; icon: typeof Globe; title: string; overflow?: boolean };
const BASE_NAV: NavItem[] = [
  { id: "domains" as Tab, label: "Domains", icon: Globe, title: "Managed domains" },
  { id: "aliases" as Tab, label: "Aliases", icon: Mail, title: "Email aliases" },
  { id: "destinations" as Tab, label: "Destinations", icon: Send, title: "Verified destinations" },
  { id: "blocks" as Tab, label: "Rules", icon: Ban, title: "Sender rules" },
  { id: "stats" as Tab, label: "Stats", icon: BarChart3, title: "Activity & stats" },
  { id: "settings" as Tab, label: "Settings", icon: SettingsIcon, title: "Account preferences & security", overflow: true },
];

export function App() {
  const { authed, isAdmin, userName, setAuthed, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("domains");

  const { toast } = useToast();

  const navItems = isAdmin
    ? [...BASE_NAV, { id: "admin" as Tab, label: "Admin", icon: Shield, title: "System Administration", overflow: true }]
    : BASE_NAV;
  const overflowItems = navItems.filter(n => n.overflow);

  const logout = async () => {
    try {
      await api.logout();
      setAuthed(false);
    } catch (err: any) {
      toast(err.message || "Failed to sign out", "error");
    }
  };

  if (loading) {
    return (
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100dvh",
        width: "100%",
        background: "#0a0a0f",
        color: "#f3f4f6",
        fontFamily: "var(--font-display)"
      }}>
        <div style={{
          fontSize: "24px",
          fontWeight: 700,
          marginBottom: "20px",
          letterSpacing: "-0.03em"
        }}>
          hide<span className="brand-redact" style={{ fontSize: "16px", padding: "1px 5px", verticalAlign: "middle" }}>my</span>email
        </div>
        <div style={{
          width: "24px",
          height: "24px",
          border: "2px solid rgba(255, 179, 0, 0.1)",
          borderTop: "2px solid #ffb300",
          borderRadius: "50%",
          animation: "spin 1s linear infinite"
        }} />
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  if (window.location.pathname === "/recover") return <Recover />;
  if (window.location.pathname === "/app-auth") return <AppAuth />;

  if (!authed) return <Login />;

  return (
    <div id="app-shell" style={{ display: "flex", width: "100%", minHeight: "100dvh" }}>
      {/* Mobile-only top bar (hidden on desktop via CSS) */}
      <header className="mobile-topbar">
        <span className="sidebar-logo">
          hide<span className="brand-redact" style={{ fontSize: "0.85em", padding: "0 4px", verticalAlign: "middle" }}>my</span>email
        </span>
        <div className="mobile-top-actions">
          {overflowItems.map(n => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                className={`btn-ghost mobile-top-action${tab === n.id ? " active" : ""}`}
                onClick={() => setTab(n.id)}
                title={n.title}
                aria-label={n.label}
              >
                <Icon size={18} />
              </button>
            );
          })}
          <button className="btn-ghost mobile-signout" onClick={logout} title="Sign out" aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-logo">
            hide<span className="brand-redact" title="my email" style={{ fontSize: "0.85em", padding: "0 4px", verticalAlign: "middle" }}>my</span>email
          </span>
          <div className="sidebar-logo-sub">.dev — privacy console</div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(n => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                className={`nav-item${tab === n.id ? " active" : ""}${n.overflow ? " nav-overflow" : ""}`}
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
          <div className="user-chip" title={`Signed in as ${userName}`}>
            <span className="user-chip-dot" />
            <span style={{ minWidth: 0 }}>
              <span className="user-chip-role">{isAdmin ? "Operator" : "Session"}</span>
              <span className="user-chip-name" style={{ display: "block" }}>{userName}</span>
            </span>
          </div>
          <button
            className="nav-item"
            onClick={logout}
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
          {tab === "destinations" && <Destinations />}
          {tab === "blocks" && <Blocks />}
          {tab === "stats"  && <Stats />}
          {tab === "settings" && <Settings />}
          {tab === "admin" && isAdmin && <Admin />}
        </div>
      </main>
    </div>
  );
}
