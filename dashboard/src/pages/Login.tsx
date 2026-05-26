import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { generatePassphrase } from "../lib/passphrase";

export function Login() {
  const { setAuthed } = useAuth();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const [generated, setGenerated] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.login(pw);
      setAuthed(true);
    } catch {
      setErr("Access denied — invalid credentials.");
      setPw("");
    } finally {
      setLoading(false);
    }
  }

  async function generate() {
    setErr("");
    setLoading(true);
    const newPw = generatePassphrase();
    try {
      await api.register(newPw);
      setGenerated(newPw);
      setPw(newPw);
      // We don't auto-login immediately so they have a chance to copy the password.
      // Or we can let them log in after they see it.
    } catch (e: any) {
      setErr("Failed to generate account. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: "flex",
      minHeight: "100dvh",
      width: "100%",
      background: "var(--canvas)",
    }}>
      {/* Left: decorative panel */}
      <div style={{
        flex: "0 0 42%",
        background: "var(--surface-0)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "48px",
        position: "relative",
        overflow: "hidden",
      }} className="login-panel-left">
        {/* Background pattern */}
        <div style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `repeating-linear-gradient(
            0deg,
            transparent,
            transparent 31px,
            var(--border) 31px,
            var(--border) 32px
          ), repeating-linear-gradient(
            90deg,
            transparent,
            transparent 31px,
            var(--border) 31px,
            var(--border) 32px
          )`,
          opacity: 0.35,
        }} />

        {/* Amber accent blob */}
        <div style={{
          position: "absolute",
          width: 300,
          height: 300,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,179,0,0.08) 0%, transparent 70%)",
          top: "30%",
          left: "10%",
          pointerEvents: "none",
        }} />

        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: "32px",
          }}>
            CLASSIFICATION: PRIVATE
          </div>
          <div style={{
            fontFamily: "var(--font-display)",
            fontSize: "2.2rem",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
            color: "var(--text-primary)",
          }}>
            hide<span className="brand-redact" title="hideMYemail" style={{ fontSize: "0.85em", padding: "0 6px", verticalAlign: "middle" }}>my</span>email
          </div>
          <div style={{
            fontFamily: "var(--font-body)",
            fontStyle: "italic",
            fontSize: "1rem",
            color: "var(--text-muted)",
            marginTop: "8px",
          }}>
            personal email alias console
          </div>
        </div>

        <div style={{ position: "relative", zIndex: 1 }}>
          {["Catch-all auto-alias creation", "Full two-way reply-from-alias", "Sender blocks & rate limits", "Cloudflare + SES — zero infra"].map((line, i) => (
            <div key={i} style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "10px",
              fontFamily: "var(--font-display)",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
              animation: `fade-up 400ms ease both ${120 + i * 80}ms`,
            }}>
              <span style={{ color: "var(--accent)", fontSize: "0.6rem" }}>◆</span>
              {line}
            </div>
          ))}
        </div>

        <div style={{ position: "relative", zIndex: 1 }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
            letterSpacing: "0.05em",
          }}>
            hidemyemail.dev
          </span>
        </div>
      </div>

      {/* Right: login form */}
      <div className="login-form-pane" style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px",
      }}>
        <div style={{
          width: "100%",
          maxWidth: 360,
          animation: "fade-up 350ms ease both 100ms",
        }}>
          <div style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: "28px",
          }}>
            AUTHENTICATE
          </div>

          {generated ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <div style={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "20px",
                textAlign: "center"
              }}>
                <h3 style={{ margin: "0 0 10px 0", color: "var(--text-primary)" }}>Account created!</h3>
                <p style={{ margin: "0 0 15px 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                  Please save this passphrase. You will need it to login in the future.
                </p>
                <div style={{
                  fontFamily: "var(--font-mono)",
                  background: "var(--canvas)",
                  padding: "12px",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--accent)",
                  fontSize: "1.1rem",
                  letterSpacing: "0.05em",
                  border: "1px solid var(--border)"
                }}>
                  {generated}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => setAuthed(true)}
                style={{ width: "100%", justifyContent: "center", padding: "10px 16px", fontSize: "0.85rem" }}
              >
                I have saved it, take me to dashboard
              </button>
            </div>
          ) : (
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <div className="field">
                <label className="field-label" htmlFor="login-pw">Access passphrase</label>
                <input
                  id="login-pw"
                  className="input"
                  type="password"
                  value={pw}
                  onChange={e => setPw(e.target.value)}
                  placeholder="Enter passphrase"
                  autoFocus
                  autoComplete="current-password"
                  disabled={loading}
                />
              </div>

              {err && (
                <div style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "0.8rem",
                  color: "var(--red)",
                  background: "var(--red-dim)",
                  border: "1px solid rgba(255,80,80,0.2)",
                  borderRadius: "var(--radius-sm)",
                  padding: "8px 12px",
                  animation: "fade-in 200ms ease",
                }}>
                  {err}
                </div>
              )}

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={loading || !pw}
                  style={{ flex: 1, justifyContent: "center", padding: "10px 16px", fontSize: "0.85rem" }}
                >
                  {loading ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span>
                      Authenticating…
                    </span>
                  ) : "Gain access"}
                </button>
                <button
                  type="button"
                  onClick={generate}
                  className="btn"
                  disabled={loading}
                  style={{ flex: 1, justifyContent: "center", padding: "10px 16px", fontSize: "0.85rem", background: "var(--surface-2)", color: "var(--text-secondary)" }}
                >
                  Generate New
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @media (max-width: 640px) {
          .login-panel-left { display: none !important; }
          .login-form-pane { padding: 24px !important; }
        }
      `}</style>
    </div>
  );
}
