import { useState } from "react";
import { CopyButton, useToast } from "../ui";
import { api } from "../api";

const MailIcon = (
  <div className="logo-container icon-accent">
    <svg viewBox="0 0 24 24">
      <rect x="2" y="4" width="20" height="16" rx="2"></rect>
      <path d="M22 6l-10 7L2 6"></path>
    </svg>
  </div>
);

export function Recover() {
  const { toast } = useToast();
  // An admin-issued recovery link carries ?token=…; without one we fall back to
  // self-service recovery (username + recovery code).
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.search).get("token") || "";
    if (value) window.history.replaceState(null, "", "/recover");
    return value;
  });

  // token flow: 1 send-code → 2 verify → 3 done. code flow: jumps to 3 on success.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.recoverSendCode(token);
      toast("Auth code sent to your email", "success");
      setStep(2);
    } catch (err: any) {
      toast(err.message || "Failed to send code", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.recoverVerify(token, code);
      setNewPassphrase(res.passphrase);
      toast("Account recovered successfully", "success");
      setStep(3);
    } catch (err: any) {
      toast(err.message || "Invalid code or token", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeRecover(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.recoverWithCode(username.trim(), recoveryCode.trim());
      setNewPassphrase(res.passphrase);
      toast("Account recovered successfully", "success");
      setStep(3);
    } catch (err: any) {
      toast(err.message || "Invalid username or recovery code", "error");
    } finally {
      setLoading(false);
    }
  }

  // ── Success (shared by both flows) ──
  if (step === 3) {
    return (
      <div className="card recovery-card">
        <div className="logo-container icon-success">
          <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <h1 className="recovery-title">Recovery Successful</h1>
        <p className="recovery-copy">
          A new master passphrase has been securely generated.
          <strong className="text-primary"> You must save this in your password manager immediately.</strong>
        </p>
        <div className="email-badge recovery-passphrase">{newPassphrase}</div>
        <div className="recovery-actions">
          <CopyButton text={newPassphrase} />
          <button className="btn btn-primary recovery-button flex-1" onClick={() => window.location.href = "/"}>
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Self-service flow (no admin token): username + recovery code ──
  if (!token) {
    return (
      <div className="card recovery-card">
        <div className="logo-container icon-accent">
          <svg viewBox="0 0 24 24">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"></path>
          </svg>
        </div>
        <h1 className="recovery-title">Account <span className="brand-redact">Recovery</span></h1>
        <p className="recovery-copy recovery-copy-loose">
          Enter your username and one of the recovery codes you saved when you created your account.
        </p>
        <form onSubmit={handleCodeRecover} className="recovery-form">
          <div className="field">
            <input
              className="input recovery-username-input"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              disabled={loading}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="username"
            />
          </div>
          <div className="field">
            <input
              className="input input-mono recovery-code-input"
              type="text"
              value={recoveryCode}
              onChange={e => setRecoveryCode(e.target.value)}
              required
              disabled={loading}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="XXXX-XXXX"
            />
          </div>
          <button className="btn btn-primary recovery-button" type="submit" disabled={loading || !username.trim() || !recoveryCode.trim()}>
            {loading ? "Recovering..." : "Recover Account"}
          </button>
        </form>
      </div>
    );
  }

  // ── Admin-token flow ──
  return (
    <div className="card recovery-card">
      {step === 1 && (
        <>
          {MailIcon}
          <h1 className="recovery-title">Account <span className="brand-redact">Recovery</span></h1>
          <p className="recovery-copy recovery-copy-loose">
            Click the button below to send a 6-digit authentication code to your default destination email address.
          </p>
          <form onSubmit={handleSendCode}>
            <button className="btn btn-primary recovery-button" type="submit" disabled={loading}>
              {loading ? "Sending..." : "Send Auth Code"}
            </button>
          </form>
        </>
      )}

      {step === 2 && (
        <>
          {MailIcon}
          <h1 className="recovery-title">Authentication <span className="brand-redact">Code</span></h1>
          <p className="recovery-copy">
            Enter the 6-digit authentication code sent to your email to verify your identity.
          </p>
          <form onSubmit={handleVerify} className="recovery-form">
            <div className="field">
              <input
                className="input input-mono recovery-code-input"
                type="text"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                disabled={loading}
                autoFocus
                placeholder="123456"
              />
            </div>
            <button className="btn btn-primary recovery-button" type="submit" disabled={loading || code.length < 6}>
              {loading ? "Verifying..." : "Verify Code"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
