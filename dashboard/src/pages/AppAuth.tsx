import { useState, type ReactNode } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Login } from "./Login";

/**
 * /app-auth — native-app login handoff.
 *
 * The mobile app opens this page in an in-app web sheet with a PKCE
 * `challenge` query param. We let the user sign in with the full web login
 * (passkeys included — that's the point: native passkey association can't
 * cover self-hosted domains), then ask the Worker for a short-lived code
 * bound to the challenge and bounce back to the app's custom URL scheme.
 *
 * The code is minted only after an explicit click. A custom URL scheme cannot
 * authenticate which app receives the redirect, so silently auto-minting would
 * let any app drive this page against an existing dashboard session and walk
 * away with a bearer token. The consent click keeps a hostile app from doing
 * that invisibly.
 */
export function AppAuth() {
  const { authed, loading } = useAuth();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const challenge = new URLSearchParams(window.location.search).get("challenge") ?? "";

  const approve = async () => {
    setBusy(true);
    try {
      const { code } = await api.appAuthCode(challenge);
      setDone(true);
      window.location.href = `hidemyemail://auth?code=${encodeURIComponent(code)}`;
    } catch (e: any) {
      setErr(e?.message || "Could not authorize the app.");
    } finally {
      setBusy(false);
    }
  };

  if (!challenge) {
    return <CenterMessage title="Missing challenge" body="Open this page from the HideMyEmail app." />;
  }
  if (loading) return null;
  if (!authed) return <Login />;
  if (err) return <CenterMessage title="Authorization failed" body={err} />;
  if (done) {
    return (
      <CenterMessage
        title="Signed in"
        body="Returning to the app… If nothing happens, switch back to HideMyEmail manually."
      />
    );
  }
  return (
    <CenterMessage
      title="Authorize app sign-in?"
      body="An app on this device is asking to sign in to your HideMyEmail account. Only continue if you just started this from the HideMyEmail app."
    >
      <button className="btn btn-primary btn-center" disabled={busy} onClick={approve}>
        {busy ? "Authorizing…" : "Authorize the app"}
      </button>
    </CenterMessage>
  );
}

function CenterMessage({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 8,
      padding: "0 24px", textAlign: "center",
    }}>
      <div className="status-title" style={{ fontSize: "1.1rem" }}>{title}</div>
      <p className="muted-copy">{body}</p>
      {children}
    </div>
  );
}
