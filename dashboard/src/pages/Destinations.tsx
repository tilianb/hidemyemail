import { useEffect, useState } from "react";
import { api, type Destination } from "../api";
import { useToast, TableSkeleton, EmptyState } from "../ui";
import { Send, CheckCircle2, Clock, Trash2 } from "lucide-react";

export function Destinations() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email: "" });
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.destinations());
    } catch {
      toast("Failed to load destinations", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createDestination(form.email);
      setForm({ email: "" });
      await load();
      toast(`Verification email sent to ${form.email}`, "success");
    } catch (err: any) {
      toast(err.message || "Failed to add destination", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Remove this destination?")) return;
    try {
      await api.deleteDestination(id);
      setRows(rs => rs.filter(r => r.id !== id));
      toast("Destination removed", "success");
    } catch (err: any) {
      toast(err.message || "Failed to remove destination", "error");
    }
  }

  async function setDefault(id: number) {
    try {
      await api.setDefaultDestination(id);
      setRows(rs => rs.map(r => ({ ...r, is_default: r.id === id ? 1 : 0 })));
      toast("Default destination updated", "success");
    } catch (err: any) {
      toast(err.message || "Failed to set default destination", "error");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">Destinations</h1>
        </div>
        <p className="page-subtitle">
          Verified email addresses where your aliases can forward mail. Your <strong>default</strong> destination is used for forwarding and account recovery.
        </p>
      </div>

      <div className="card stagger-1 card-form-gap">
        <div className="card-header">
          <span className="card-title">Add Destination</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip">
            <div className="field grow">
              <label className="field-label" htmlFor="dest-email">Email Address</label>
              <input
                id="dest-email"
                className="input input-mono"
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={e => setForm({ email: e.target.value })}
                required
                disabled={submitting}
              />
            </div>
            <button className="btn btn-primary form-submit" type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Send Verification"}
            </button>
          </div>
        </form>
      </div>

      <div className="stagger-2">
        <div className="table-wrap">
          <table className="dossier">
            <thead>
              <tr>
                <th>Email Address</th>
                <th>Status</th>
                <th>Added</th>
                <th className="th-actions"></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={4} rows={3} />
            ) : (
              <tbody>
                {rows.map(d => (
                  <tr key={d.id}>
                    <td>
                      <span className="addr-mono">{d.email}</span>
                    </td>
                    <td>
                      {d.verified_at ? (
                        <span className="badge badge-green">
                          <CheckCircle2 size={12} className="badge-icon" /> Verified
                        </span>
                      ) : (
                        <span className="badge badge-yellow">
                          <Clock size={12} className="badge-icon" /> Pending
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-muted">
                        {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        {d.is_default === 1 ? (
                          <span className="badge badge-accent">
                            Default
                          </span>
                        ) : d.verified_at && (
                          <button className="btn btn-secondary btn-compact" onClick={() => setDefault(d.id)} title="Set as default">
                            Set Default
                          </button>
                        )}
                        <button className="btn-icon danger" onClick={() => remove(d.id)} title="Remove destination">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && rows.length === 0 && (
            <EmptyState
              icon={<Send size={40} />}
              title="No destinations yet"
              body="Add an email address above to verify it for forwarding."
            />
          )}
        </div>
      </div>
    </div>
  );
}
