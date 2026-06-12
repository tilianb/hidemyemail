import { useState, useEffect } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { generatePassphrase } from "../lib/passphrase";
import { CopyButton } from "../ui";
import { Fingerprint } from "lucide-react";

export function Login() {
  const { refreshAuth } = useAuth();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mainGlobalDomain, setMainGlobalDomain] = useState("");
  const [showRestore, setShowRestore] = useState(false);

  useEffect(() => {
    api.config().then(conf => setMainGlobalDomain(conf.main_global_domain)).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const result = await api.login(pw);
      if ("mfa_required" in result && result.mfa_required) {
        setMfaRequired(true);
      } else {
        await refreshAuth();
      }
    } catch (e: any) {
      if (e?.message === "Account has been deleted") {
        // Tombstoned during the 7-day grace window — offer to cancel deletion
        setShowRestore(true);
        setErr("This account is scheduled for deletion.");
      } else {
        setErr("Access denied — invalid credentials.");
        setPw("");
      }
    } finally {
      setLoading(false);
    }
  }

  async function restoreAccount() {
    setErr("");
    setLoading(true);
    try {
      await api.restoreAccount(pw);
      setShowRestore(false);
      const result = await api.login(pw);
      if ("mfa_required" in result && result.mfa_required) {
        setMfaRequired(true);
      } else {
        await refreshAuth();
      }
    } catch (e: any) {
      setErr(e?.message || "Restore failed.");
    } finally {
      setLoading(false);
    }
  }

  async function loginWithPasskey() {
    setErr("");
    setLoading(true);
    try {
      const options = await api.passkeyLoginChallenge();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication({ optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      await api.passkeyLoginVerify(response);
      await refreshAuth();
    } catch (err: any) {
      if (err?.name === "NotAllowedError") {
        setErr("Passkey sign-in was cancelled.");
      } else {
        setErr(err?.message || "Passkey sign-in failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.completeMfa(mfaCode);
      await refreshAuth();
    } catch {
      setErr("Invalid authentication code.");
      setMfaCode("");
    } finally {
      setLoading(false);
    }
  }

  async function generate() {
    setErr("");
    setLoading(true);
    const newPw = generatePassphrase();
    try {
      const res = await api.register(newPw);
      setGenerated(newPw);
      setRecoveryCodes(res.recovery_codes ?? []);
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
    <div className="login-shell">
      {/* Left: decorative panel */}
      <div className="login-panel-left">
        <div className="login-layer">
          <div className="login-kicker brand-kicker">
            CLASSIFICATION: PRIVATE
          </div>
          <div className="login-brand-title">
            hide<span className="brand-redact login-brand-mark" title="hideMYemail">my</span>email
          </div>
          <div className="login-tagline">
            personal email alias console
          </div>
          <div className="login-redactions" aria-hidden="true">
            <span /><span /><span /><span /><span /><span />
          </div>
        </div>

        <div className="login-layer">
          {["Catch-all auto-alias creation", "Full two-way reply-from-alias", "Sender blocks & rate limits", "Cloudflare + SES — zero infra"].map((line, i) => (
            <div key={i} className="login-feature-row">
              <span className="login-feature-dot">◆</span>
              {line}
            </div>
          ))}
        </div>

        <div className="login-layer">
          <span className="login-domain">
            {mainGlobalDomain}
          </span>
        </div>
      </div>

      {/* Right: login form */}
      <div className="login-form-pane">
        <div className="login-card">
          <div className="login-kicker">
            AUTHENTICATE
          </div>

          {mfaRequired ? (
            <form onSubmit={submitMfa} className="stack">
              <div>
                <div className="status-title">
                  Two-Factor Authentication
                </div>
                <p className="muted-copy">
                  Enter the 6-digit code from your authenticator app, or one of your backup codes.
                </p>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="mfa-code">Authentication code</label>
                <input
                  id="mfa-code"
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value.replace(/\s/g, ""))}
                  placeholder="000000 or XXXX-XXXX"
                  autoFocus
                  autoComplete="one-time-code"
                  disabled={loading}
                  maxLength={20}
                />
              </div>
              {err && (
                <div className="auth-error">
                  {err}
                </div>
              )}
              <div className="inline-actions-lg">
                <button
                  type="button"
                  className="btn btn-soft flex-1 btn-center"
                  onClick={() => { setMfaRequired(false); setMfaCode(""); setErr(""); }}
                  disabled={loading}
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  className="btn btn-primary flex-2 btn-center"
                  disabled={loading || !mfaCode}
                >
                  {loading ? (
                    <span className="inline-actions">
                      <span className="inline-spinner">◌</span>
                      Verifying…
                    </span>
                  ) : "Verify"}
                </button>
              </div>
            </form>
          ) : generated ? (
            <div className="stack">
              <div className="login-success-card">
                <h3 className="login-success-title">Account created!</h3>
                <p className="login-success-copy">
                  Please save this passphrase. You will need it to login in the future.
                </p>
                <div className="login-secret">
                  {generated}
                </div>
              </div>
              {recoveryCodes.length > 0 && (
                <div className="login-success-card">
                  <h3 className="login-success-title">Recovery codes</h3>
                  <p className="login-success-copy">
                    Save these too. Set a username later, then use any one of these (each works once) to recover your account if you lose your passphrase. They won't be shown again.
                  </p>
                  <div className="backup-code-grid">
                    {recoveryCodes.map((code, i) => (
                      <div key={i} className="backup-code">{code}</div>
                    ))}
                  </div>
                  <div className="inline-actions" style={{ marginTop: "var(--space-3)" }}>
                    <CopyButton text={recoveryCodes.join("\n")} />
                  </div>
                </div>
              )}
              <button
                className="btn btn-primary btn-full btn-center"
                onClick={() => refreshAuth()}
              >
                I have saved it, take me to dashboard
              </button>
            </div>
          ) : (
            <div className="stack">
              {typeof window !== "undefined" && window.PublicKeyCredential && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-full btn-center"
                    onClick={loginWithPasskey}
                    disabled={loading}
                  >
                    <Fingerprint size={16} />
                    {loading ? "Signing in…" : "Sign in with Passkey"}
                  </button>
                  <div className="login-divider">
                    <div className="login-divider-line" />
                    <span className="login-divider-text">OR</span>
                    <div className="login-divider-line" />
                  </div>
                </>
              )}
            <form onSubmit={submit} className="stack">
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
                <div className="auth-error">
                  {err}
                </div>
              )}

              {showRestore && (
                <button
                  type="button"
                  className="btn btn-primary btn-full btn-center"
                  onClick={restoreAccount}
                  disabled={loading || !pw}
                >
                  {loading ? "Restoring…" : "Cancel deletion & restore account"}
                </button>
              )}

              <div className="inline-actions-lg">
                <button
                  type="submit"
                  className="btn btn-primary flex-1 btn-center"
                  disabled={loading || !pw}
                >
                  {loading ? (
                    <span className="inline-actions">
                      <span className="inline-spinner">◌</span>
                      Authenticating…
                    </span>
                  ) : "Gain access"}
                </button>
                <button
                  type="button"
                  onClick={generate}
                  className="btn btn-soft flex-1 btn-center"
                  disabled={loading}
                >
                  Generate New
                </button>
              </div>
            </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
