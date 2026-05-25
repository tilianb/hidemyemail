import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast, CopyButton, TableSkeleton, EmptyState } from "../ui";
import { Globe } from "lucide-react";

interface Domain {
  id: number;
  domain: string;
  default_destination: string;
  active: 0 | 1;
  created_at: number;
}

export function Domains() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ domain: "", default_destination: "" });
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.domains());
    } catch {
      toast("Failed to load domains", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createDomain(form.domain, form.default_destination);
      setForm({ domain: "", default_destination: "" });
      await load();
      toast(`Domain ${form.domain} added`, "success");
    } catch {
      toast("Failed to add domain", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {/* Page header */}
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

      {/* Add domain form */}
      <div className="card stagger-1" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Add Domain</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip" style={{ gap: 12 }}>
            <div className="field" style={{ minWidth: 200 }}>
              <label className="field-label" htmlFor="dom-domain">Domain</label>
              <input
                id="dom-domain"
                className="input input-mono"
                type="text"
                placeholder="hidemyemail.dev"
                value={form.domain}
                onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                required
                disabled={submitting}
              />
            </div>
            <div className="field grow">
              <label className="field-label" htmlFor="dom-dest">Default destination</label>
              <input
                id="dom-dest"
                className="input input-mono"
                type="email"
                placeholder="me@gmail.com"
                value={form.default_destination}
                onChange={e => setForm(f => ({ ...f, default_destination: e.target.value }))}
                required
                disabled={submitting}
              />
            </div>
            <div style={{ paddingTop: 20 }}>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Adding…" : "Add domain"}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Domains table */}
      <div className="stagger-2">
        <div className="table-wrap">
          <table className="dossier">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Default destination</th>
                <th>Status</th>
                <th>Added</th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={4} rows={3} />
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
                    </td>
                    <td>
                      {d.active
                        ? <span className="badge badge-green">active</span>
                        : <span className="badge badge-muted">inactive</span>
                      }
                    </td>
                    <td>
                      <span className="font-mono text-muted" style={{ fontSize: "0.78rem" }}>
                        {new Date(d.created_at * 1000).toLocaleDateString()}
                      </span>
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
              body="Add a domain above to start receiving email through aliases."
            />
          )}
        </div>
      </div>
    </div>
  );
}
