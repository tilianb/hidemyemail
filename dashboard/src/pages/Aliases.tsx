import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast, CopyButton, Switch, ConfirmDialog, TableSkeleton, EmptyState } from "../ui";
import { Mail, Trash2 } from "lucide-react";

interface Alias {
  id: number;
  domain_id: number;
  local_part: string;
  full_address: string;
  destination: string | null;
  label: string | null;
  active: 0 | 1;
  source: string;
  fwd_count: number;
  blocked_count: number;
  reply_count: number;
  created_at: number;
  last_seen_at: number | null;
}

interface Domain { id: number; domain: string }

interface DeleteTarget { id: number; full_address: string }

export function Aliases() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Alias[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ domain_id: 0, local_part: "", destination: "", label: "" });
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.aliases(q));
    } catch {
      toast("Failed to load aliases", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.domains().then(d => {
      setDomains(d);
      setForm(f => ({ ...f, domain_id: d[0]?.id ?? 0 }));
    });
  }, []);

  useEffect(() => { load(); }, [q]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createAlias({
        domain_id: Number(form.domain_id),
        local_part: form.local_part,
        destination: form.destination || undefined,
        label: form.label || undefined,
      });
      setForm(f => ({ ...f, local_part: "", destination: "", label: "" }));
      await load();
      toast("Alias created", "success");
    } catch {
      toast("Failed to create alias", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(alias: Alias, value: boolean) {
    setTogglingId(alias.id);
    try {
      await api.patchAlias(alias.id, { active: value ? 1 : 0 });
      setRows(prev => prev.map(a => a.id === alias.id ? { ...a, active: value ? 1 : 0 } : a));
      toast(`${alias.local_part} ${value ? "activated" : "deactivated"}`, "success");
    } catch {
      toast("Failed to update alias", "error");
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await api.deleteAlias(target.id);
      setRows(prev => prev.filter(a => a.id !== target.id));
      toast(`${target.full_address} deleted`, "success");
    } catch (err: any) {
      console.error("Failed to delete alias:", err);
      toast("Failed to delete alias", "error");
    }
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 className="page-title">Aliases</h1>
          {!loading && (
            <span className="badge badge-muted" style={{ position: "relative", top: -2 }}>
              {rows.length}
            </span>
          )}
        </div>
        <p className="page-subtitle">
          Email aliases — forward, reply, and block senders without exposing your real inbox.
        </p>
      </div>

      {/* Reply hint callout */}
      <div className="callout stagger-1" style={{ marginBottom: 24 }}>
        <strong>How replies work —</strong>{" "}
        When mail is forwarded, the{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78em" }}>Reply-To</span>{" "}
        header is set to a unique reverse-alias:{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78em" }}>
          alias+sender=domain@yourdomain
        </span>
        . Replying from your real inbox routes through SES and arrives as the alias — the sender
        never sees your real address.
      </div>

      {/* Create alias form */}
      <div className="card stagger-2" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">New Alias</span>
        </div>
        <form onSubmit={create}>
          <div className="form-strip" style={{ gap: 12 }}>
            <div className="field" style={{ minWidth: 130 }}>
              <label className="field-label" htmlFor="al-domain">Domain</label>
              <select
                id="al-domain"
                className="input input-mono"
                value={form.domain_id}
                onChange={e => setForm(f => ({ ...f, domain_id: Number(e.target.value) }))}
                disabled={submitting}
              >
                {domains.map(d => <option key={d.id} value={d.id}>@{d.domain}</option>)}
              </select>
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label className="field-label" htmlFor="al-local">Local part</label>
              <input
                id="al-local"
                className="input input-mono"
                type="text"
                placeholder="shopping"
                value={form.local_part}
                onChange={e => setForm(f => ({ ...f, local_part: e.target.value }))}
                required
                disabled={submitting}
              />
            </div>
            <div className="field grow">
              <label className="field-label" htmlFor="al-dest">Destination (optional)</label>
              <input
                id="al-dest"
                className="input input-mono"
                type="email"
                placeholder="override@inbox.com"
                value={form.destination}
                onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}
                disabled={submitting}
              />
            </div>
            <div className="field" style={{ minWidth: 120 }}>
              <label className="field-label" htmlFor="al-label">Label</label>
              <input
                id="al-label"
                className="input"
                type="text"
                placeholder="e.g. Amazon"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                disabled={submitting}
              />
            </div>
            <div style={{ paddingTop: 20 }}>
              <button className="btn btn-primary" type="submit" disabled={submitting || !form.local_part}>
                {submitting ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Search */}
      <div className="stagger-3" style={{ marginBottom: 16 }}>
        <input
          className="input"
          type="search"
          placeholder="Search aliases, labels, destinations…"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ maxWidth: 400 }}
        />
      </div>

      {/* Aliases table */}
      <div className="stagger-4">
        <div className="table-wrap">
          <table className="dossier">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Destination</th>
                <th>Fwd</th>
                <th>Reply</th>
                <th>Blocked</th>
                <th>Source</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={8} rows={6} />
            ) : (
              <tbody>
                {rows.map(a => (
                  <tr key={a.id}>
                    <td>
                      <div className="addr-cell" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                        <div className="addr-cell">
                          <span className="addr-mono">{a.full_address}</span>
                          <CopyButton text={a.full_address} />
                        </div>
                        {a.label && (
                          <span style={{
                            fontFamily: "var(--font-display)",
                            fontSize: "0.7rem",
                            color: "var(--text-muted)",
                            letterSpacing: "0.02em",
                          }}>
                            {a.label}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {a.destination ? (
                        <div className="addr-cell">
                          <span
                            className="addr-mono redact"
                            style={{ maxWidth: 180, display: "block", padding: "1px 4px", cursor: "default" }}
                            title={a.destination}
                          >
                            {a.destination}
                          </span>
                          <CopyButton text={a.destination} />
                        </div>
                      ) : (
                        <span style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "0.75rem",
                          color: "var(--text-muted)",
                          fontStyle: "italic",
                        }}>
                          domain default
                        </span>
                      )}
                    </td>
                    <td><span className="badge-count">{a.fwd_count}</span></td>
                    <td><span className="badge-count">{a.reply_count}</span></td>
                    <td>
                      <span className="badge-count" style={a.blocked_count > 0 ? { color: "var(--red)", background: "var(--red-dim)" } : {}}>
                        {a.blocked_count}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-${a.source === "manual" ? "amber" : "muted"}`}>
                        {a.source}
                      </span>
                    </td>
                    <td>
                      <Switch
                        checked={!!a.active}
                        onChange={v => toggleActive(a, v)}
                        disabled={togglingId === a.id}
                        label={a.active ? "Active" : "Inactive"}
                      />
                    </td>
                    <td>
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => setDeleteTarget({ id: a.id, full_address: a.full_address })}
                        title="Delete alias"
                        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "6px" }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && rows.length === 0 && (
            <EmptyState
              icon={<Mail size={40} />}
              title={q ? "No aliases match your search" : "No aliases yet"}
              body={q ? "Try a different search term." : "Create an alias above, or send mail to any address at your domain — it auto-creates."}
            />
          )}
        </div>
      </div>

      {/* Confirm delete dialog */}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete alias"
          body={`Permanently delete ${deleteTarget.full_address}? Forwarding to this address will stop immediately.`}
          confirmLabel="Delete alias"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
