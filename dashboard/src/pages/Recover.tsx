import { useState, useEffect } from "react";
import { ShieldAlert, ArrowRight } from "lucide-react";
import { api } from "../api";
import { useToast } from "../ui";

export function Recover() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) setToken(t);
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return toast("No recovery token found in URL", "error");
    if (password.length < 16) return toast("Passphrase must be at least 16 characters", "error");
    
    setLoading(true);
    try {
      await api.recover(token, password);
      // Success! Redirect to home to load app shell
      window.location.href = "/";
    } catch (err: any) {
      toast(err.message || "Recovery failed. Token may be invalid or expired.", "error");
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={styles.container}>
        <div style={styles.box}>
          <ShieldAlert size={48} style={{ color: "var(--red)", marginBottom: 16 }} />
          <h2 style={styles.title}>Invalid Recovery Link</h2>
          <p style={styles.subtitle}>This link is missing a secure recovery token.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.box}>
        <div style={styles.header}>
          <div style={styles.logo}>
            hide<span className="brand-redact" style={{ fontSize: "0.85em", padding: "0 4px", verticalAlign: "middle" }}>my</span>email
          </div>
          <p style={styles.subtitle}>Account Recovery</p>
        </div>

        <form onSubmit={onSubmit} style={styles.form}>
          <div className="field">
            <label className="field-label">New Master Passphrase</label>
            <input
              type="password"
              className="input input-mono"
              placeholder="e.g. correct horse battery staple"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%", justifyContent: "center", marginTop: 16 }}>
            {loading ? "Recovering..." : "Recover Account"} <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100dvh",
    background: "var(--canvas)",
    padding: "var(--space-6)",
  },
  box: {
    width: "100%",
    maxWidth: 380,
    background: "var(--surface-1)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-8)",
    boxShadow: "var(--shadow-lg)",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
  },
  header: {
    textAlign: "center" as const,
    marginBottom: "var(--space-8)",
  },
  logo: {
    fontFamily: "var(--font-display)",
    fontSize: "1.5rem",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "var(--text-primary)",
    lineHeight: 1,
    marginBottom: "var(--space-2)",
  },
  title: {
    fontFamily: "var(--font-display)",
    fontSize: "1.2rem",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: "var(--space-2)",
  },
  subtitle: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    color: "var(--text-muted)",
    letterSpacing: "0.02em",
  },
  form: {
    width: "100%",
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-4)",
  },
};
