import { useEffect, useState } from "react";
import { QRCode } from "react-qr-code";
import { api } from "../api";
import { useToast } from "../ui";
import { ShieldCheck, ShieldOff, KeyRound, Copy, RefreshCw, Loader2, Fingerprint, Trash2, Pencil } from "lucide-react";

type SetupStep = "idle" | "qr" | "verify" | "backup";
type PasskeyRow = { id: string; device_name: string | null; created_at: number };

export function Security() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [backupCodesRemaining, setBackupCodesRemaining] = useState(0);
  const [loading, setLoading] = useState(true);

  // Passkey state
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [passkeysSupported] = useState(() => typeof window !== "undefined" && !!window.PublicKeyCredential);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [showAddPasskey, setShowAddPasskey] = useState(false);
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [editingPasskeyName, setEditingPasskeyName] = useState("");

  // Setup wizard state
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupSecret, setSetupSecret] = useState("");
  const [setupUri, setSetupUri] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [setupBackupCodes, setSetupBackupCodes] = useState<string[]>([]);
  const [setupLoading, setSetupLoading] = useState(false);

  // Disable dialog state
  const [showDisable, setShowDisable] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [disableLoading, setDisableLoading] = useState(false);

  // Backup code regeneration state
  const [showRegen, setShowRegen] = useState(false);
  const [regenCode, setRegenCode] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[]>([]);

  async function loadStatus() {
    setLoading(true);
    try {
      const [mfa, pks] = await Promise.all([api.mfaStatus(), api.passkeyList().catch(() => [])]);
      setEnabled(mfa.enabled);
      setBackupCodesRemaining(mfa.backupCodesRemaining);
      setPasskeys(pks);
    } catch {
      toast("Failed to load security settings", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function addPasskey(e: React.FormEvent) {
    e.preventDefault();
    setAddingPasskey(true);
    try {
      const options = await api.passkeyChallenge();
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      const result = await api.passkeyRegister({ response, deviceName: newPasskeyName || undefined });
      setPasskeys(prev => [...prev, { id: result.id, device_name: newPasskeyName || null, created_at: Date.now() }]);
      setShowAddPasskey(false);
      setNewPasskeyName("");
      toast("Passkey added successfully", "success");
    } catch (err: any) {
      if (err?.name === "NotAllowedError") {
        toast("Passkey registration was cancelled", "error");
      } else {
        toast(err?.message || "Failed to add passkey", "error");
      }
    } finally {
      setAddingPasskey(false);
    }
  }

  async function deletePasskey(id: string) {
    if (!confirm("Remove this passkey?")) return;
    try {
      await api.passkeyDelete(id);
      setPasskeys(prev => prev.filter(p => p.id !== id));
      toast("Passkey removed", "success");
    } catch (err: any) {
      toast(err?.message || "Failed to remove passkey", "error");
    }
  }

  async function renamePasskey(id: string, name: string) {
    try {
      await api.passkeyRename(id, name);
      setPasskeys(prev => prev.map(p => p.id === id ? { ...p, device_name: name } : p));
      setEditingPasskeyId(null);
      toast("Passkey renamed", "success");
    } catch (err: any) {
      toast(err?.message || "Failed to rename passkey", "error");
    }
  }

  async function beginSetup() {
    setSetupLoading(true);
    try {
      const data = await api.mfaSetup();
      setSetupSecret(data.secret);
      setSetupUri(data.uri);
      setSetupStep("qr");
    } catch (err: any) {
      toast(err.message || "Failed to start setup", "error");
    } finally {
      setSetupLoading(false);
    }
  }

  async function verifySetup(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(setupCode)) {
      toast("Enter a 6-digit code", "error");
      return;
    }
    setSetupLoading(true);
    try {
      const data = await api.mfaVerify(setupCode);
      setSetupBackupCodes(data.backupCodes);
      setSetupStep("backup");
    } catch (err: any) {
      toast(err.message || "Code verification failed", "error");
      setSetupCode("");
    } finally {
      setSetupLoading(false);
    }
  }

  function finishSetup() {
    setEnabled(true);
    setBackupCodesRemaining(setupBackupCodes.length);
    setSetupStep("idle");
    setSetupSecret("");
    setSetupUri("");
    setSetupCode("");
    setSetupBackupCodes([]);
    toast("Two-factor authentication enabled", "success");
  }

  function cancelSetup() {
    setSetupStep("idle");
    setSetupSecret("");
    setSetupUri("");
    setSetupCode("");
    setSetupBackupCodes([]);
  }

  async function disableMfa(e: React.FormEvent) {
    e.preventDefault();
    setDisableLoading(true);
    try {
      await api.mfaDisable(disableCode);
      setEnabled(false);
      setBackupCodesRemaining(0);
      setShowDisable(false);
      setDisableCode("");
      toast("Two-factor authentication disabled", "success");
    } catch (err: any) {
      toast(err.message || "Failed to disable 2FA", "error");
      setDisableCode("");
    } finally {
      setDisableLoading(false);
    }
  }

  async function regenBackupCodes(e: React.FormEvent) {
    e.preventDefault();
    setRegenLoading(true);
    try {
      const data = await api.mfaRegenerateBackupCodes(regenCode);
      setNewBackupCodes(data.backupCodes);
      setBackupCodesRemaining(data.backupCodes.length);
      setRegenCode("");
    } catch (err: any) {
      toast(err.message || "Failed to regenerate codes", "error");
      setRegenCode("");
    } finally {
      setRegenLoading(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => toast(`${label} copied`, "success"),
      () => toast("Failed to copy", "error")
    );
  }

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Security</h1>
          <p className="page-subtitle">Manage your account security settings.</p>
        </div>
        <div style={{ display: "flex", justifyContent: "center", padding: "48px", color: "var(--text-muted)" }}>
          <Loader2 size={24} style={{ animation: "spin 1s linear infinite" }} />
        </div>
      </div>
    );
  }

  // ── TOTP setup wizard ──────────────────────────────────────────────────────

  if (setupStep === "qr") {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Set Up Two-Factor Authentication</h1>
          <p className="page-subtitle">Step 1 of 2 — scan the QR code with your authenticator app.</p>
        </div>
        <div className="card stagger-1" style={{ maxWidth: 520 }}>
          <div className="card-header">
            <span className="card-title">Scan QR Code</span>
          </div>
          <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
              Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and scan the code below. Then click <strong style={{ color: "var(--text-secondary)" }}>Next</strong>.
            </p>

            <div style={{
              display: "flex",
              justifyContent: "center",
              padding: "20px",
              background: "#fff",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
            }}>
              <QRCode value={setupUri} size={180} />
            </div>

            <div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "6px", fontFamily: "var(--font-display)", letterSpacing: "0.05em" }}>
                OR ENTER MANUALLY
              </div>
              <div style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: "var(--canvas)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
              }}>
                <span style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  color: "var(--accent)",
                  letterSpacing: "0.1em",
                  wordBreak: "break-all",
                }}>
                  {setupSecret.match(/.{1,4}/g)?.join(" ")}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "4px 8px", flexShrink: 0 }}
                  onClick={() => copyToClipboard(setupSecret, "Secret")}
                  title="Copy secret"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, paddingTop: 4, alignItems: "center" }}>
              <button type="button" className="btn" onClick={cancelSetup} style={{ flex: 1, background: "var(--surface-2)", color: "var(--text-secondary)", justifyContent: "center" }}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setSetupStep("verify")} style={{ flex: 2, justifyContent: "center" }}>
                Next: Verify →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (setupStep === "verify") {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Set Up Two-Factor Authentication</h1>
          <p className="page-subtitle">Step 2 of 2 — verify the code from your authenticator app.</p>
        </div>
        <div className="card stagger-1" style={{ maxWidth: 520 }}>
          <div className="card-header">
            <span className="card-title">Verify Code</span>
          </div>
          <form onSubmit={verifySetup} style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
              Enter the 6-digit code currently shown in your authenticator app to confirm setup.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="verify-code">Authentication code</label>
              <input
                id="verify-code"
                className="input"
                type="text"
                inputMode="numeric"
                value={setupCode}
                onChange={e => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoFocus
                autoComplete="one-time-code"
                disabled={setupLoading}
                maxLength={6}
                style={{ fontFamily: "var(--font-mono)", fontSize: "1.2rem", letterSpacing: "0.2em", textAlign: "center" }}
              />
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button type="button" className="btn" onClick={() => setSetupStep("qr")} disabled={setupLoading} style={{ flex: 1, background: "var(--surface-2)", color: "var(--text-secondary)", justifyContent: "center" }}>
                ← Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={setupLoading || setupCode.length !== 6} style={{ flex: 2, justifyContent: "center" }}>
                {setupLoading ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Verifying…
                  </span>
                ) : "Enable 2FA"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  if (setupStep === "backup") {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">2FA Enabled — Save Your Backup Codes</h1>
          <p className="page-subtitle">Store these codes safely. Each can only be used once if you lose access to your authenticator.</p>
        </div>
        <div className="card stagger-1" style={{ maxWidth: 520 }}>
          <div className="card-header">
            <span className="card-title" style={{ color: "var(--green, #4ade80)" }}>
              <ShieldCheck size={16} style={{ display: "inline", marginRight: 6, verticalAlign: "text-bottom" }} />
              Backup Codes
            </span>
          </div>
          <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              background: "var(--canvas)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "16px",
            }}>
              {setupBackupCodes.map((code, i) => (
                <div key={i} style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.9rem",
                  color: "var(--accent)",
                  letterSpacing: "0.05em",
                  padding: "4px 0",
                }}>
                  {code}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => copyToClipboard(setupBackupCodes.join("\n"), "Backup codes")}
              style={{ background: "var(--surface-2)", color: "var(--text-secondary)", gap: 8 }}
            >
              <Copy size={14} /> Copy All Codes
            </button>
            <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
              These codes will not be shown again. Save them in a password manager or a safe place.
            </p>
            <button type="button" className="btn btn-primary" onClick={finishSetup} style={{ justifyContent: "center" }}>
              I've saved my backup codes →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main security page ─────────────────────────────────────────────────────

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Security</h1>
        <p className="page-subtitle">Manage your account security settings.</p>
      </div>

      {/* 2FA status card */}
      <div className="card stagger-1" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Two-Factor Authentication (2FA)</span>
        </div>
        <div style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {enabled ? (
                <ShieldCheck size={20} style={{ color: "var(--green, #4ade80)", flexShrink: 0 }} />
              ) : (
                <ShieldOff size={20} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              )}
              <div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "0.9rem" }}>
                  Authenticator app (TOTP)
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {enabled
                    ? "Active — required at each login."
                    : "Not configured. Add an extra layer of security to your account."}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {enabled ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => { setShowDisable(true); setDisableCode(""); }}
                  style={{ background: "var(--red-dim)", color: "var(--red)", border: "1px solid rgba(255,80,80,0.2)", gap: 6 }}
                >
                  <ShieldOff size={14} /> Disable 2FA
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={beginSetup}
                  disabled={setupLoading}
                  style={{ gap: 6 }}
                >
                  {setupLoading ? (
                    <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                  ) : (
                    <KeyRound size={14} />
                  )}
                  Enable 2FA
                </button>
              )}
            </div>
          </div>

          {/* Disable dialog (inline) */}
          {showDisable && (
            <form onSubmit={disableMfa} style={{
              marginTop: 20,
              padding: "16px",
              background: "var(--canvas)",
              border: "1px solid rgba(255,80,80,0.2)",
              borderRadius: "var(--radius)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Enter your current authentication code or a backup code to confirm.
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <input
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={disableCode}
                  onChange={e => setDisableCode(e.target.value.replace(/\s/g, ""))}
                  placeholder="000000 or XXXX-XXXX"
                  autoFocus
                  autoComplete="one-time-code"
                  disabled={disableLoading}
                  maxLength={20}
                />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" className="btn" onClick={() => setShowDisable(false)} disabled={disableLoading} style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={disableLoading || !disableCode} style={{ background: "var(--red-dim)", color: "var(--red)", border: "1px solid rgba(255,80,80,0.2)" }}>
                  {disableLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : "Confirm Disable"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Backup codes card — only shown when 2FA is enabled */}
      {enabled && (
        <div className="card stagger-2">
          <div className="card-header">
            <span className="card-title">Backup Codes</span>
            <span className="badge badge-muted">{backupCodesRemaining} remaining</span>
          </div>
          <div style={{ padding: "20px 24px" }}>
            <p style={{ margin: "0 0 16px 0", fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
              Backup codes let you sign in if you lose access to your authenticator app. Each code can only be used once. Regenerating creates 8 new codes and invalidates all existing ones.
            </p>

            {newBackupCodes.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "8px",
                  background: "var(--canvas)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "16px",
                  marginBottom: 8,
                }}>
                  {newBackupCodes.map((code, i) => (
                    <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "0.9rem", color: "var(--accent)", letterSpacing: "0.05em", padding: "2px 0" }}>
                      {code}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => copyToClipboard(newBackupCodes.join("\n"), "Backup codes")}
                    style={{ background: "var(--surface-2)", color: "var(--text-secondary)", gap: 6, fontSize: "0.8rem" }}
                  >
                    <Copy size={12} /> Copy All
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setNewBackupCodes([])}
                    style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}
                  >
                    Hide
                  </button>
                </div>
              </div>
            )}

            {showRegen ? (
              <form onSubmit={regenBackupCodes} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Enter your current authentication code to generate 8 new backup codes.
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={regenCode}
                    onChange={e => setRegenCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    autoFocus
                    autoComplete="one-time-code"
                    disabled={regenLoading}
                    maxLength={6}
                    style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.15em", textAlign: "center", maxWidth: 140 }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={regenLoading || regenCode.length !== 6} style={{ gap: 6 }}>
                    {regenLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
                    Regenerate
                  </button>
                  <button type="button" className="btn" onClick={() => { setShowRegen(false); setRegenCode(""); }} disabled={regenLoading} style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => { setShowRegen(true); setNewBackupCodes([]); }}
                style={{ background: "var(--surface-2)", color: "var(--text-secondary)", gap: 6 }}
              >
                <RefreshCw size={14} /> Regenerate Backup Codes
              </button>
            )}
          </div>
        </div>
      )}

      {/* Passkeys card */}
      <div className="card stagger-3" style={{ marginTop: 24 }}>
        <div className="card-header">
          <span className="card-title">Passkeys</span>
          <span className="badge badge-muted">{passkeys.length}</span>
        </div>
        <div style={{ padding: "20px 24px" }}>
          <p style={{ margin: "0 0 16px 0", fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
            Sign in with biometrics or a hardware key — no passphrase needed. Works on any device where you've saved a passkey.
          </p>

          {passkeys.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {passkeys.map(pk => (
                <div key={pk.id} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  background: "var(--canvas)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                }}>
                  <Fingerprint size={16} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  {editingPasskeyId === pk.id ? (
                    <form
                      onSubmit={e => { e.preventDefault(); renamePasskey(pk.id, editingPasskeyName); }}
                      style={{ flex: 1, display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <input
                        className="input"
                        value={editingPasskeyName}
                        onChange={e => setEditingPasskeyName(e.target.value)}
                        autoFocus
                        maxLength={64}
                        style={{ flex: 1, padding: "4px 8px", fontSize: "0.85rem" }}
                      />
                      <button type="submit" className="btn btn-primary" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>Save</button>
                      <button type="button" className="btn" onClick={() => setEditingPasskeyId(null)} style={{ padding: "4px 8px", background: "var(--surface-2)", color: "var(--text-secondary)", fontSize: "0.8rem" }}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "0.85rem", color: "var(--text-primary)", fontWeight: 500 }}>
                          {pk.device_name || "Unnamed passkey"}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          Added {new Date(pk.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => { setEditingPasskeyId(pk.id); setEditingPasskeyName(pk.device_name || ""); }}
                        title="Rename"
                        style={{ padding: "4px 6px" }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => deletePasskey(pk.id)}
                        title="Remove"
                        style={{ padding: "4px 6px", color: "var(--red)" }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {passkeysSupported ? (
            showAddPasskey ? (
              <form onSubmit={addPasskey} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Give this passkey a name so you can recognise it later (optional).
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="input"
                    value={newPasskeyName}
                    onChange={e => setNewPasskeyName(e.target.value)}
                    placeholder="e.g. MacBook Touch ID, iPhone Face ID"
                    maxLength={64}
                    disabled={addingPasskey}
                    autoFocus
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={addingPasskey} style={{ gap: 6, flexShrink: 0 }}>
                    {addingPasskey ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Fingerprint size={14} />}
                    {addingPasskey ? "Registering…" : "Register"}
                  </button>
                  <button type="button" className="btn" onClick={() => { setShowAddPasskey(false); setNewPasskeyName(""); }} disabled={addingPasskey} style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowAddPasskey(true)}
                style={{ gap: 6 }}
              >
                <Fingerprint size={14} /> Add Passkey
              </button>
            )
          ) : (
            <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Passkeys are not supported in this browser.
            </p>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
