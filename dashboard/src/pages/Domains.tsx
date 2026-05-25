import { useEffect, useState } from "react";
import { api, type Domain, type Destination } from "../api";
import { useToast, CopyButton, TableSkeleton, EmptyState } from "../ui";
import { Globe, Trash2 } from "lucide-react";

export function Domains() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Domain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ prefix: "", default_destination: "" });
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [doms, dests] = await Promise.all([
        api.domains(),
        api.destinations(),
      ]);
      setRows(doms);
      setDestinations(dests.filter(d => d.verified_at !== null));
    } catch {
      toast("Failed to load domains", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const myDomainsCount = rows.filter(d => d.is_global === 0).length;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createDomain(form.prefix, form.default_destination);
      setForm({ prefix: "", default_destination: "" });
      await load();
      toast(`Subdomain created`, "success");
    } catch (err: any) {
      toast(err.message || "Failed to add domain", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this domain and ALL its aliases?")) return;
    try {
      await api.deleteDomain(id);
      await load();
      toast("Domain removed", "success");
    } catch (err: any) {
      toast(err.message || "Failed to remove domain", "error");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 className="page-title">Domains</h1>
          {!loading && (
            <span className="badge badge-muted" style={{ position: "relative", top: -2 }}>
              {rows.length}
            </span>
          )}
        </div>
        <p className="page-subtitle">
          Managed domains — all inbound mail routes through these.
        </p>
      </div>

      <div className="card stagger-1" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Add Subdomain ({myDomainsCount} / 5 used)</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip" style={{ gap: 12 }}>
            <div className="field" style={{ minWidth: 200, display: "flex", flexDirection: "column" }}>
              <label className="field-label" htmlFor="dom-prefix">Subdomain prefix</label>
              <div style={{ display: "flex", alignItems: "center" }}>
                <input
                  id="dom-prefix"
                  className="input input-mono"
                  style={{ borderRight: "none", borderTopRightRadius: 0, borderBottomRightRadius: 0, flex: 1, minWidth: 0 }}
                  type="text"
                  placeholder="name"
                  value={form.prefix}
                  onChange={e => setForm(f => ({ ...f, prefix: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                  required
                  disabled={submitting || myDomainsCount >= 5}
                />
                <div style={{ 
                  padding: "0 12px", 
                  background: "var(--bg-card)", 
                  border: "1px solid var(--border)", 
                  borderLeft: "none",
                  height: "36px", 
                  display: "flex", 
                  alignItems: "center",
                  borderTopRightRadius: 6,
                  borderBottomRightRadius: 6,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem"
                }}>
                  .hidemyemail.dev
                </div>
              </div>
            </div>
            <div className="field grow">
              <label className="field-label" htmlFor="dom-dest">Default destination (optional)</label>
              <select
                id="dom-dest"
                className="input"
                value={form.default_destination}
                onChange={e => setForm(f => ({ ...f, default_destination: e.target.value }))}
                disabled={submitting || destinations.length === 0 || myDomainsCount >= 5}
              >
                <option value="">-- None (Drop email) --</option>
                {destinations.map(d => (
                  <option key={d.id} value={d.email}>{d.email}</option>
                ))}
              </select>
            </div>
            <div style={{ paddingTop: 20 }}>
              <button className="btn btn-primary" type="submit" disabled={submitting || destinations.length === 0 || myDomainsCount >= 5}>
                {submitting ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
          {destinations.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 8 }}>
              You must verify a destination email first.
            </div>
          )}
        </form>
      </div>

      <div className="stagger-2">
        <div className="table-wrap">
          <table className="dossier">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Default destination</th>
                <th>Added</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={5} rows={3} />
            ) : (
              <tbody>
                {rows.map(d => (
                  <tr key={d.id}>
                    <td>
                      <div className="addr-cell">
                        <span className="addr-mono">{d.domain}</span>
                        <CopyButton text={d.domain} />
                      </div>
                    </td>
                    <td>
                      {d.is_global ? (
                        <span className="badge badge-purple">Global</span>
                      ) : (
                        <span className="badge badge-muted">Personal</span>
                      )}
                    </td>
                    <td>
                      {d.default_destination ? (
                        <div className="addr-cell">
                          <span
                            className="addr-mono redact"
                            title={d.default_destination}
                            style={{ maxWidth: 220, display: "block", padding: "1px 4px" }}
                          >
                            {d.default_destination}
                          </span>
                          <CopyButton text={d.default_destination} />
                        </div>
                      ) : (
                        <span className="text-muted italic">None (Drop email)</span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-muted" style={{ fontSize: "0.78rem" }}>
                        {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      {!d.is_global && (
                        <button className="btn-icon" onClick={() => remove(d.id)} title="Delete domain">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && rows.length === 0 && (
            <EmptyState
              icon={<Globe size={40} />}
              title="No domains yet"
              body="Add a subdomain above to start receiving email."
            />
          )}
        </div>
      </div>
    </div>
  );
}
