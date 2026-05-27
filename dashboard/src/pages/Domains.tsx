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
  const [mainGlobalDomain, setMainGlobalDomain] = useState("hidemyemail.dev");

  async function load() {
    setLoading(true);
    try {
      const [doms, dests, conf] = await Promise.all([
        api.domains(),
        api.destinations(),
        api.config(),
      ]);
      setRows(doms);
      setDestinations(dests.filter(d => d.verified_at !== null));
      setMainGlobalDomain(conf.main_global_domain);
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
        <div className="page-title-row">
          <h1 className="page-title">Domains</h1>
        </div>
        <p className="page-subtitle">
          Managed domains — all inbound mail routes through these.
        </p>
      </div>

      <div className="card stagger-1 card-form-gap">
        <div className="card-header">
          <span className="card-title">Add Subdomain ({myDomainsCount} / 5 used)</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip">
            <div className="field form-field-lg">
              <label className="field-label" htmlFor="dom-prefix">Subdomain prefix</label>
              <div className="input-group">
                <input
                  id="dom-prefix"
                  className="input input-mono"
                  type="text"
                  placeholder="name"
                  value={form.prefix}
                  onChange={e => setForm(f => ({ ...f, prefix: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                  required
                  disabled={submitting || myDomainsCount >= 5}
                />
                <div className="input-suffix">
                  .{mainGlobalDomain}
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
            <button className="btn btn-primary form-submit" type="submit" disabled={submitting || destinations.length === 0 || myDomainsCount >= 5}>
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
          {destinations.length === 0 && (
            <div className="form-help">
              You must verify a destination email first.
            </div>
          )}
        </form>
      </div>

      <div className="stagger-2">
        <div className="table-wrap table-wrap-stack">
          <table className="dossier dossier-stack">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Default destination</th>
                <th>Added</th>
                <th className="th-actions"></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={5} rows={3} />
            ) : (
              <tbody>
                {rows.filter(d => !d.is_global).map(d => (
                  <tr key={d.id}>
                    <td data-label="Domain">
                      <div className="addr-cell">
                        <span className="addr-mono">{d.domain}</span>
                        <CopyButton text={d.domain} />
                      </div>
                    </td>
                    <td data-label="Type">
                      {d.is_global ? (
                        <span className="badge badge-purple">Global</span>
                      ) : (
                        <span className="badge badge-muted">Personal</span>
                      )}
                    </td>
                    <td data-label="Default destination">
                      {d.default_destination ? (
                        <div className="addr-cell">
                          <span
                            title={d.default_destination}
                            className="addr-mono redact redacted-token"
                          >
                            {d.default_destination}
                          </span>
                          <CopyButton text={d.default_destination} />
                        </div>
                      ) : (
                        <span className="muted-italic">None (Drop email)</span>
                      )}
                    </td>
                    <td data-label="Added">
                      <span className="font-mono text-muted">
                        {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      {!d.is_global && (
                        <button className="btn-icon danger" onClick={() => remove(d.id)} title="Delete domain">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && myDomainsCount === 0 && (
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
