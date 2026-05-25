import { useEffect, useState } from "react";
import { api } from "../api";

export function Blocks() {
  const [rows, setRows] = useState<any[]>([]);
  const [pattern, setPattern] = useState("");
  async function load() { setRows(await api.blocks()); }
  useEffect(() => { load(); }, []);
  return (
    <div>
      <form onSubmit={async (e) => { e.preventDefault(); await api.createBlock(pattern); setPattern(""); load(); }} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input placeholder="*@spam.com or evil@x.com" value={pattern} onChange={(e) => setPattern(e.target.value)} required style={{ flex: 1 }} />
        <button type="submit">Block</button>
      </form>
      <ul>{rows.map((b) => (
        <li key={b.id}>{b.pattern} {b.alias_id ? `(alias ${b.alias_id})` : "(global)"} <button onClick={async () => { await api.deleteBlock(b.id); load(); }}>x</button></li>
      ))}</ul>
    </div>
  );
}
