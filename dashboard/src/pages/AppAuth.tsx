import { useEffect, useState } from "react";
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
 */
export function AppAuth() {
  const { authed, loading } = useAuth();
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const challenge = new URLSearchParams(window.location.search).get("challenge") ?? "";

  useEffect(() => {
    if (!authed || !challenge || done) return;
    let cancelled = false;
    (async () => {
      try {
        const { code } = await api.appAuthCode(challenge);
        if (cancelled) return;
        setDone(true);
        window.location.href = `hidemyemail://auth?code=${encodeURIComponent(code)}`;
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Could not authorize the app.");
      }
    })();
    return () => { cancelled = true; };
  }, [authed, challenge, done]);

  if (!challenge) {
    return <CenterMessage title="Missing challenge" body="Open this page from the HideMyEmail app." />;
  }
  if (loading) return null;
  if (!authed) return <Login />;
  if (err) return <CenterMessage title="Authorization failed" body={err} />;
  return (
    <CenterMessage
      title="Signed in"
      body="Returning to the app… If nothing happens, switch back to HideMyEmail manually."
    />
  );
}

function CenterMessage({ title, body }: { title: string; body: string }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 8,
      padding: "0 24px", textAlign: "center",
    }}>
      <div className="status-title" style={{ fontSize: "1.1rem" }}>{title}</div>
      <p className="muted-copy">{body}</p>
    </div>
  );
}
