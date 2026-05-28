import { useState } from "react";
import { CopyButton, useToast } from "../ui";
import { api } from "../api";

export function Recover() {
  const { toast } = useToast();
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.search).get("token") || "";
    if (value) window.history.replaceState(null, "", "/recover");
    return value;
  });

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");

  if (!token) {
    return (
      <div className="card recovery-card">
        <div className="logo-container icon-error">
          <svg viewBox="0 0 24 24">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <h1 className="recovery-title">Invalid Link</h1>
        <p className="recovery-copy">This recovery link is missing, malformed, or expired.</p>
        <button className="btn btn-soft recovery-button" onClick={() => window.location.href = "/"}>
          Go to Dashboard
        </button>
      </div>
    );
  }

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

  return (
    <div className="card recovery-card">
      {step === 1 && (
        <>
          <div className="logo-container icon-accent">
            <svg viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="16" rx="2"></rect>
              <path d="M22 6l-10 7L2 6"></path>
            </svg>
          </div>
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
          <div className="logo-container icon-accent">
            <svg viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="16" rx="2"></rect>
              <path d="M22 6l-10 7L2 6"></path>
            </svg>
          </div>
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

      {step === 3 && (
        <>
          <div className="logo-container icon-success">
            <svg viewBox="0 0 24 24">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <h1 className="recovery-title">Recovery Successful</h1>
          <p className="recovery-copy">
            A new master passphrase has been securely generated. 
            <strong className="text-primary"> You must save this in your password manager immediately.</strong>
          </p>
          <div className="email-badge recovery-passphrase">
            {newPassphrase}
          </div>
          <div className="recovery-actions">
            <CopyButton text={newPassphrase} />
            <button className="btn btn-primary recovery-button flex-1" onClick={() => window.location.href = "/"}>
              Go to Dashboard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
