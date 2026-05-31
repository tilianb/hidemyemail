import { useEffect, useState } from "react";
import { api, type Domain, type Destination } from "../api";
import { useToast, CopyButton, TableSkeleton, EmptyState } from "../ui";
import { Globe, Trash2, Pencil, Check, X } from "lucide-react";

export function Domains() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Domain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ prefix: "", default_destination: "", base_domain_id: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [maxSubdomains, setMaxSubdomains] = useState(-1);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDest, setEditDest] = useState("global");
  const [savingId, setSavingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [doms, dests, conf] = await Promise.all([
        api.domains(),
        api.destinations(),
        api.config(),
      ]);
      setRows(doms);
      const allowedBaseDomains = doms.filter(d => d.is_global === 1 && d.active === 1 && d.verified_at !== null && d.allow_subdomain_aliases === 1);
      const validDests = dests.filter(d => d.verified_at !== null);
      setDestinations(validDests);
      
      setForm(f => ({
        ...f,
        default_destination: f.default_destination || "global",
        base_domain_id: allowedBaseDomains.some(d => d.id === f.base_domain_id) ? f.base_domain_id : (allowedBaseDomains[0]?.id ?? 0),
      }));
      
      setMaxSubdomains(conf.max_subdomains);
    } catch {
      toast("Failed to load domains", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const myDomainsCount = rows.filter(d => d.is_global === 0).length;
  const allowedBaseDomains = rows.filter(d => d.is_global === 1 && d.active === 1 && d.verified_at !== null && d.allow_subdomain_aliases === 1);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createDomain(form.prefix, form.default_destination, form.base_domain_id || undefined);
      setForm(f => ({ ...f, prefix: "", default_destination: "global" }));
      await load();
      toast(`Subdomain created`, "success");
    } catch (err: any) {
      toast(err.message || "Failed to add domain", "error");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(d: Domain) {
    setEditingId(d.id);
    setEditDest(d.default_destination || "global");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: number) {
    setSavingId(id);
    try {
      await api.updateDomainDestination(id, editDest);
      setEditingId(null);
      await load();
      toast("Default destination updated", "success");
    } catch (err: any) {
      toast(err.message || "Failed to update destination", "error");
    } finally {
      setSavingId(null);
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

  async function patchDomain(id: number, data: Parameters<typeof api.patchDomain>[1], optimistic: Partial<Domain>) {
    const prev = rows;
    setRows(rs => rs.map(d => (d.id === id ? { ...d, ...optimistic } : d)));
    try {
      await api.patchDomain(id, data);
      toast("Subdomain updated", "success");
    } catch (err: any) {
      setRows(prev);
      toast(err.message || "Failed to update subdomain", "error");
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
          <span className="card-title">Add Subdomain {maxSubdomains >= 0 ? `(${myDomainsCount} / ${maxSubdomains} used)` : `(${myDomainsCount} used)`}</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip">
            <div className="field domain-builder-field">
              <label className="field-label" htmlFor="dom-prefix">Subdomain</label>
              <div className="input-group domain-builder">
                <input
                  id="dom-prefix"
                  className="input input-mono domain-prefix-input"
                  type="text"
                  placeholder="name"
                  value={form.prefix}
                  onChange={e => setForm(f => ({ ...f, prefix: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))}
                  required
                  disabled={submitting || allowedBaseDomains.length === 0}
                />
                <div className="domain-dot font-mono">.</div>
                <select
                  id="dom-base"
                  className="input input-mono domain-base-select"
                  value={form.base_domain_id}
                  onChange={e => setForm(f => ({ ...f, base_domain_id: Number(e.target.value) }))}
                  disabled={submitting || allowedBaseDomains.length === 0}
                >
                  {allowedBaseDomains.map(d => (
                    <option key={d.id} value={d.id}>{d.domain}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field grow">
              <label className="field-label" htmlFor="dom-dest">Default destination (optional)</label>
              <select
                id="dom-dest"
                className="input"
                value={form.default_destination}
                onChange={e => setForm(f => ({ ...f, default_destination: e.target.value }))}
                disabled={submitting || destinations.length === 0}
              >
                <option value="global">-- Global Default --</option>
                {destinations.map(d => (
                  <option key={d.id} value={d.email}>{d.email}</option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary form-submit" type="submit" disabled={submitting || destinations.length === 0 || allowedBaseDomains.length === 0}>
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
          {allowedBaseDomains.length === 0 && (
            <div className="form-help">
              No global domains currently allow subdomain aliases.
            </div>
          )}
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
                <th>Catch-all</th>
                <th>Inline actions</th>
                <th>Added</th>
                <th className="th-actions"></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={7} rows={3} />
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
                      {editingId === d.id ? (
                        <select
                          className="input"
                          value={editDest}
                          onChange={e => setEditDest(e.target.value)}
                          disabled={savingId === d.id}
                          autoFocus
                        >
                          <option value="global">-- Global Default --</option>
                          {destinations.map(dest => (
                            <option key={dest.id} value={dest.email}>{dest.email}</option>
                          ))}
                        </select>
                      ) : d.default_destination === "global" ? (
                        <span className="muted-italic">Global Default</span>
                      ) : d.default_destination ? (
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
                    <td data-label="Catch-all">
                      <select
                        className="input input-mono"
                        value={d.catch_all === null ? "inherit" : d.catch_all === 1 ? "on" : "off"}
                        onChange={e => {
                          const v = e.target.value;
                          const catch_all = v === "inherit" ? null : v === "on" ? 1 : 0;
                          patchDomain(d.id, { catch_all }, { catch_all });
                        }}
                        title="Auto-create an alias for any address on this subdomain"
                      >
                        <option value="inherit">Inherit</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    </td>
                    <td data-label="Inline actions">
                      <select
                        className="input input-mono"
                        value={d.inline_actions_pref ?? "inherit"}
                        onChange={e => {
                          const v = e.target.value;
                          const inline_actions_pref = v === "inherit" ? null : (v as "on" | "off");
                          patchDomain(d.id, { inline_actions_pref }, { inline_actions_pref });
                        }}
                        title="Show the unsubscribe/mute toolbar on mail forwarded from this subdomain"
                      >
                        <option value="inherit">Inherit</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    </td>
                    <td data-label="Added">
                      <span className="font-mono text-muted">
                        {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      {!d.is_global && (
                        <div className="addr-cell">
                          {editingId === d.id ? (
                            <>
                              <button className="btn-icon" onClick={() => saveEdit(d.id)} disabled={savingId === d.id} title="Save destination">
                                <Check size={16} />
                              </button>
                              <button className="btn-icon" onClick={cancelEdit} disabled={savingId === d.id} title="Cancel">
                                <X size={16} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="btn-icon" onClick={() => startEdit(d)} disabled={destinations.length === 0} title="Edit default destination">
                                <Pencil size={16} />
                              </button>
                              <button className="btn-icon danger" onClick={() => remove(d.id)} title="Delete domain">
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
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
