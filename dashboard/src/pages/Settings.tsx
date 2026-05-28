import { useEffect, useState } from "react";
import { QRCode } from "react-qr-code";
import { api } from "../api";
import { useToast } from "../ui";
import { ShieldCheck, ShieldOff, KeyRound, Copy, RefreshCw, Loader2, Fingerprint, Trash2, Pencil, Mail } from "lucide-react";

type SetupStep = "idle" | "qr" | "verify" | "backup";
type PasskeyRow = { id: string; device_name: string | null; created_at: number };

export function Settings() {
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

  // Email preferences
  type Tri = "on" | "off" | null;
  type Pos = "header" | "footer" | null;
  const [inlineActionsPref, setInlineActionsPref] = useState<Tri>(null);
  const [inlineActionsPosition, setInlineActionsPosition] = useState<Pos>(null);
  const [defaultsEnabled, setDefaultsEnabled] = useState(false);
  const [defaultsPosition, setDefaultsPosition] = useState("footer");
  const [savingInlineActions, setSavingInlineActions] = useState(false);

  async function loadStatus() {
    setLoading(true);
    try {
      const [mfa, pks, prefs] = await Promise.all([
        api.mfaStatus(),
        api.passkeyList().catch(() => []),
        api.preferences().catch(() => ({
          inline_actions_pref: null as Tri,
          inline_actions_position: null as Pos,
          defaults: { inline_actions_enabled: false, inline_actions_position: "footer" },
        })),
      ]);
      setEnabled(mfa.enabled);
      setBackupCodesRemaining(mfa.backupCodesRemaining);
      setPasskeys(pks);
      setInlineActionsPref(prefs.inline_actions_pref);
      setInlineActionsPosition(prefs.inline_actions_position);
      setDefaultsEnabled(prefs.defaults.inline_actions_enabled);
      setDefaultsPosition(prefs.defaults.inline_actions_position);
    } catch {
      toast("Failed to load settings", "error");
    } finally {
      setLoading(false);
    }
  }

  // Combined value used by the single select. "inherit" resets both fields to
  // NULL so the user picks back up whatever the admin's default is set to.
  type InlineChoice = "inherit" | "off" | "header" | "footer";

  async function updateInlineChoice(next: InlineChoice) {
    const prevPref = inlineActionsPref;
    const prevPos = inlineActionsPosition;
    let pref: Tri;
    let pos: Pos;
    if (next === "inherit") { pref = null; pos = null; }
    else if (next === "off") { pref = "off"; pos = null; }
    else { pref = "on"; pos = next; }

    setInlineActionsPref(pref);
    setInlineActionsPosition(pos);
    setSavingInlineActions(true);
    try {
      await api.updatePreferences({ inline_actions_pref: pref, inline_actions_position: pos });
    } catch (err: any) {
      setInlineActionsPref(prevPref);
      setInlineActionsPosition(prevPos);
      toast(err?.message || "Failed to update preference", "error");
    } finally {
      setSavingInlineActions(false);
    }
  }

  const effectiveEnabled = inlineActionsPref === "on" || (inlineActionsPref === null && defaultsEnabled);
  const effectivePosition = inlineActionsPosition ?? defaultsPosition;
  const currentChoice: InlineChoice =
    inlineActionsPref === null ? "inherit"
    : inlineActionsPref === "off" ? "off"
    : (inlineActionsPosition ?? (defaultsPosition === "header" ? "header" : "footer")) as InlineChoice;
  const defaultLabel = defaultsEnabled ? `${defaultsPosition}` : "disabled";

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
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage your account preferences and security.</p>
        </div>
        <div className="loading-center">
          <Loader2 size={24} className="spin" />
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
        <div className="card stagger-1 card-constrained">
          <div className="card-header">
            <span className="card-title">Scan QR Code</span>
          </div>
          <div className="card-body-lg stack">
            <p className="muted-copy">
              Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and scan the code below. Then click <strong className="text-secondary">Next</strong>.
            </p>

            <div className="qr-frame">
              <QRCode value={setupUri} size={180} />
            </div>

            <div>
              <div className="type-label">
                OR ENTER MANUALLY
              </div>
              <div className="secret-row">
                <span>
                  {setupSecret.match(/.{1,4}/g)?.join(" ")}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact shrink-0"
                  onClick={() => copyToClipboard(setupSecret, "Secret")}
                  title="Copy secret"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>

            <div className="inline-actions-lg">
              <button type="button" className="btn btn-soft flex-1 btn-center" onClick={cancelSetup}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary flex-2 btn-center" onClick={() => setSetupStep("verify")}>
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
        <div className="card stagger-1 card-constrained">
          <div className="card-header">
            <span className="card-title">Verify Code</span>
          </div>
          <form onSubmit={verifySetup} className="card-body-lg stack">
            <p className="muted-copy">
              Enter the 6-digit code currently shown in your authenticator app to confirm setup.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="verify-code">Authentication code</label>
              <input
                id="verify-code"
                type="text"
                inputMode="numeric"
                value={setupCode}
                onChange={e => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoFocus
                autoComplete="one-time-code"
                disabled={setupLoading}
                maxLength={6}
                className="input code-input"
              />
            </div>
            <div className="inline-actions-lg">
              <button type="button" className="btn btn-soft flex-1 btn-center" onClick={() => setSetupStep("qr")} disabled={setupLoading}>
                ← Back
              </button>
              <button type="submit" className="btn btn-primary flex-2 btn-center" disabled={setupLoading || setupCode.length !== 6}>
                {setupLoading ? (
                  <span className="inline-actions">
                    <Loader2 size={14} className="spin" /> Verifying…
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
        <div className="card stagger-1 card-constrained">
          <div className="card-header">
            <span className="card-title icon-green">
              <ShieldCheck size={16} />
              Backup Codes
            </span>
          </div>
          <div className="card-body-lg stack">
            <div className="backup-code-grid">
              {setupBackupCodes.map((code, i) => (
                <div key={i} className="backup-code">
                  {code}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-soft"
              onClick={() => copyToClipboard(setupBackupCodes.join("\n"), "Backup codes")}
            >
              <Copy size={14} /> Copy All Codes
            </button>
            <p className="muted-copy-sm">
              These codes will not be shown again. Save them in a password manager or a safe place.
            </p>
            <button type="button" className="btn btn-primary btn-center" onClick={finishSetup}>
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
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Manage your account preferences and security.</p>
      </div>

      {/* Email preferences card */}
      <div className="card stagger-1 card-spaced-bottom">
        <div className="card-header">
          <span className="card-title">Email Preferences</span>
        </div>
        <div className="card-body">
          <div className="inline-actions-wrap inline-actions-nowrap">
            <div className="security-status-media">
              <Mail size={20} className="icon-muted" />
              <div>
                <div className="status-title">Inline action links</div>
                <div className="status-caption">
                  Choose where the Block / Mute&nbsp;7d / Disable alias bar appears in your forwarded emails, or disable it entirely. Currently <strong>{effectiveEnabled ? effectivePosition : "disabled"}</strong>{inlineActionsPref === null ? <> (inheriting site default: <em>{defaultLabel}</em>)</> : null}.
                </div>
              </div>
            </div>
            <div className="inline-actions inline-actions-select">
              <select
                className="input"
                value={currentChoice}
                disabled={savingInlineActions}
                onChange={e => updateInlineChoice(e.target.value as InlineChoice)}
              >
                <option value="inherit">Inherit default ({defaultLabel})</option>
                <option value="off">Disabled</option>
                <option value="header">Header</option>
                <option value="footer">Footer</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 2FA status card */}
      <div className="card stagger-2 card-spaced-bottom">
        <div className="card-header">
          <span className="card-title">Two-Factor Authentication (2FA)</span>
        </div>
        <div className="card-body">
          <div className="inline-actions-wrap">
            <div className="security-status-media">
              {enabled ? (
                <ShieldCheck size={20} className="icon-green" />
              ) : (
                <ShieldOff size={20} className="icon-muted" />
              )}
              <div>
                <div className="status-title">
                  Authenticator app (TOTP)
                </div>
                <div className="status-caption">
                  {enabled
                    ? "Active — required at each login."
                    : "Not configured. Add an extra layer of security to your account."}
                </div>
              </div>
            </div>
            <div className="inline-actions shrink-0">
              {enabled ? (
                <button
                  type="button"
                  className="btn btn-danger-soft"
                  onClick={() => { setShowDisable(true); setDisableCode(""); }}
                >
                  <ShieldOff size={14} /> Disable 2FA
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={beginSetup}
                  disabled={setupLoading}
                >
                  {setupLoading ? (
                    <Loader2 size={14} className="spin" />
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
            <form onSubmit={disableMfa} className="security-danger-form">
              <div className="muted-copy">
                Enter your current authentication code or a backup code to confirm.
              </div>
              <div className="field field-tight">
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
              <div className="inline-actions">
                <button type="button" className="btn btn-soft" onClick={() => setShowDisable(false)} disabled={disableLoading}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-danger-soft" disabled={disableLoading || !disableCode}>
                  {disableLoading ? <Loader2 size={14} className="spin" /> : "Confirm Disable"}
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
          <div className="card-body">
            <p className="muted-copy card-spaced-bottom">
              Backup codes let you sign in if you lose access to your authenticator app. Each code can only be used once. Regenerating creates 8 new codes and invalidates all existing ones.
            </p>

            {newBackupCodes.length > 0 && (
              <div className="security-code-block">
                <div className="backup-code-grid">
                  {newBackupCodes.map((code, i) => (
                    <div key={i} className="backup-code">
                      {code}
                    </div>
                  ))}
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="btn btn-soft btn-compact"
                    onClick={() => copyToClipboard(newBackupCodes.join("\n"), "Backup codes")}
                  >
                    <Copy size={12} /> Copy All
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={() => setNewBackupCodes([])}
                  >
                    Hide
                  </button>
                </div>
              </div>
            )}

            {showRegen ? (
              <form onSubmit={regenBackupCodes} className="security-form-stack">
                <div className="muted-copy-sm">
                  Enter your current authentication code to generate 8 new backup codes.
                </div>
                <div className="security-inline-form">
                  <input
                    className="input code-input-small"
                    type="text"
                    inputMode="numeric"
                    value={regenCode}
                    onChange={e => setRegenCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    autoFocus
                    autoComplete="one-time-code"
                    disabled={regenLoading}
                    maxLength={6}
                  />
                  <button type="submit" className="btn btn-primary" disabled={regenLoading || regenCode.length !== 6}>
                    {regenLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                    Regenerate
                  </button>
                  <button type="button" className="btn btn-soft" onClick={() => { setShowRegen(false); setRegenCode(""); }} disabled={regenLoading}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => { setShowRegen(true); setNewBackupCodes([]); }}
              >
                <RefreshCw size={14} /> Regenerate Backup Codes
              </button>
            )}
          </div>
        </div>
      )}

      {/* Passkeys card */}
      <div className="card stagger-3 card-spaced-top">
        <div className="card-header">
          <span className="card-title">Passkeys</span>
          <span className="badge badge-muted">{passkeys.length}</span>
        </div>
        <div className="card-body">
          <p className="muted-copy card-spaced-bottom">
            Sign in with biometrics or a hardware key — no passphrase needed. Works on any device where you've saved a passkey.
          </p>

          {passkeys.length > 0 && (
            <div className="passkey-list">
              {passkeys.map(pk => (
                <div key={pk.id} className="passkey-row">
                  <Fingerprint size={16} className="icon-muted" />
                  {editingPasskeyId === pk.id ? (
                    <form
                      onSubmit={e => { e.preventDefault(); renamePasskey(pk.id, editingPasskeyName); }}
                      className="passkey-edit-form"
                    >
                      <input
                        className="input flex-input btn-compact"
                        value={editingPasskeyName}
                        onChange={e => setEditingPasskeyName(e.target.value)}
                        autoFocus
                        maxLength={64}
                      />
                      <button type="submit" className="btn btn-primary btn-compact">Save</button>
                      <button type="button" className="btn btn-soft btn-compact" onClick={() => setEditingPasskeyId(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <div className="flex-1">
                        <div className="passkey-name">
                          {pk.device_name || "Unnamed passkey"}
                        </div>
                        <div className="passkey-meta">
                          Added {new Date(pk.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => { setEditingPasskeyId(pk.id); setEditingPasskeyName(pk.device_name || ""); }}
                        title="Rename"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost icon-red"
                        onClick={() => deletePasskey(pk.id)}
                        title="Remove"
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
              <form onSubmit={addPasskey} className="security-form-stack">
                <div className="muted-copy-sm">
                  Give this passkey a name so you can recognise it later (optional).
                </div>
                <div className="security-inline-form">
                  <input
                    className="input flex-input"
                    value={newPasskeyName}
                    onChange={e => setNewPasskeyName(e.target.value)}
                    placeholder="e.g. MacBook Touch ID, iPhone Face ID"
                    maxLength={64}
                    disabled={addingPasskey}
                    autoFocus
                  />
                  <button type="submit" className="btn btn-primary shrink-0" disabled={addingPasskey}>
                    {addingPasskey ? <Loader2 size={14} className="spin" /> : <Fingerprint size={14} />}
                    {addingPasskey ? "Registering…" : "Register"}
                  </button>
                  <button type="button" className="btn btn-soft" onClick={() => { setShowAddPasskey(false); setNewPasskeyName(""); }} disabled={addingPasskey}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowAddPasskey(true)}
              >
                <Fingerprint size={14} /> Add Passkey
              </button>
            )
          ) : (
            <p className="muted-copy-sm">
              Passkeys are not supported in this browser.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
