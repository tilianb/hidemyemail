import { useState } from "react";
import { CopyButton, useToast } from "../ui";
import { api } from "../api";
import { Key } from "lucide-react";

export function Recover() {
  const { toast } = useToast();
  const token = new URLSearchParams(window.location.search).get("token") || "";

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");

  if (!token) {
    return (
      <div className="card" style={{ maxWidth: 400, margin: "10vh auto", textAlign: "center" }}>
        <h1 className="page-title">Invalid Link</h1>
        <p className="text-muted">This recovery link is missing or malformed.</p>
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
    <div className="card" style={{ maxWidth: 400, margin: "10vh auto" }}>
      <div className="card-header" style={{ marginBottom: 24, textAlign: "center" }}>
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <Key className="text-accent" /> Account Recovery
        </h1>
        {step === 1 && <p className="text-muted" style={{ marginTop: 8 }}>Click below to send an authentication code to your email.</p>}
        {step === 2 && <p className="text-muted" style={{ marginTop: 8 }}>Enter the 6-digit code sent to your email.</p>}
        {step === 3 && <p className="text-muted" style={{ marginTop: 8 }}>Your account has been recovered!</p>}
      </div>

      <div className="card-body">
        {step === 1 && (
          <form onSubmit={handleSendCode} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: "100%" }}>
              {loading ? "Sending..." : "Send Auth Code"}
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleVerify} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="field">
              <label className="field-label">Authentication Code</label>
              <input
                className="input input-mono"
                style={{ textAlign: "center", fontSize: "1.2rem", letterSpacing: "0.2em" }}
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
            <button className="btn btn-primary" type="submit" disabled={loading || code.length < 6} style={{ width: "100%" }}>
              {loading ? "Verifying..." : "Verify Code"}
            </button>
          </form>
        )}

        {step === 3 && (
          <div style={{ textAlign: "center" }}>
            <p style={{ marginBottom: 16 }}>
              A new master passphrase has been securely generated for your account. 
              <strong> You must save this in your password manager immediately.</strong>
            </p>
            <div style={{
              background: "rgba(255, 179, 0, 0.1)",
              border: "1px dashed var(--accent)",
              padding: 16,
              borderRadius: 6,
              marginBottom: 24,
              fontFamily: "var(--font-mono)",
              fontSize: "1.1rem",
              wordBreak: "break-all"
            }}>
              {newPassphrase}
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <CopyButton text={newPassphrase} />
              <button className="btn btn-primary" onClick={() => window.location.href = "/"} style={{ flex: 1 }}>
                Go to Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
