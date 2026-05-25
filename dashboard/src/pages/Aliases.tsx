import { useEffect, useState } from "react";
import { api } from "../api";

export function Aliases() {
  const [rows, setRows] = useState<any[]>([]);
  const [domains, setDomains] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ domain_id: 0, local_part: "", destination: "", label: "" });

  async function load() { setRows(await api.aliases(q)); }
  useEffect(() => { api.domains().then((d) => { setDomains(d); setForm((f) => ({ ...f, domain_id: d[0]?.id ?? 0 })); }); }, []);
  useEffect(() => { load(); }, [q]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await api.createAlias({ domain_id: Number(form.domain_id), local_part: form.local_part, destination: form.destination || undefined, label: form.label || undefined });
    setForm((f) => ({ ...f, local_part: "", destination: "", label: "" }));
    load();
  }

  return (
    <div>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <select value={form.domain_id} onChange={(e) => setForm({ ...form, domain_id: Number(e.target.value) })}>
          {domains.map((d) => <option key={d.id} value={d.id}>@{d.domain}</option>)}
        </select>
        <input placeholder="local part" value={form.local_part} onChange={(e) => setForm({ ...form, local_part: e.target.value })} required />
        <input placeholder="destination (optional)" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
        <input placeholder="label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <button type="submit">Create</button>
      </form>
      <input placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12, width: "100%" }} />
      <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          <th>Alias</th><th>Dest</th><th>Fwd</th><th>Reply</th><th>Blocked</th><th>Active</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{a.full_address}{a.label ? ` (${a.label})` : ""}</td>
              <td>{a.destination ?? <em>default</em>}</td>
              <td>{a.fwd_count}</td><td>{a.reply_count}</td><td>{a.blocked_count}</td>
              <td><input type="checkbox" checked={!!a.active} onChange={async (e) => { await api.patchAlias(a.id, { active: e.target.checked ? 1 : 0 }); load(); }} /></td>
              <td><button onClick={async () => { if (confirm(`Delete ${a.full_address}?`)) { await api.deleteAlias(a.id); load(); } }}>x</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
