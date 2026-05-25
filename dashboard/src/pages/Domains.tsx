import { useEffect, useState } from "react";
import { api } from "../api";

export function Domains() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ domain: "", default_destination: "" });

  async function load() { setRows(await api.domains()); }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await api.createDomain(form.domain, form.default_destination);
    setForm({ domain: "", default_destination: "" });
    load();
  }

  return (
    <div>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input placeholder="domain (e.g. hidemyemail.dev)" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} required />
        <input placeholder="default destination (real inbox)" value={form.default_destination} onChange={(e) => setForm({ ...form, default_destination: e.target.value })} required style={{ flex: 1 }} />
        <button type="submit">Add domain</button>
      </form>
      <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          <th>Domain</th><th>Default destination</th><th>Active</th>
        </tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{d.domain}</td><td>{d.default_destination}</td><td>{d.active ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
