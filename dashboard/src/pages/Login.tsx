import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

export function Login() {
  const { setAuthed } = useAuth();
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api.login(pw); setAuthed(true); } catch { setErr("Invalid password"); }
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "10vh auto", display: "grid", gap: 12 }}>
      <h1>hidemyemail</h1>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus />
      <button type="submit">Sign in</button>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
    </form>
  );
}
