import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast, CopyButton, ConfirmDialog, TableSkeleton, EmptyState } from "../ui";
import { ShieldAlert, Trash2 } from "lucide-react";

interface Block {
  id: number;
  alias_id: number | null;
  pattern: string;
  created_at: number;
}

interface DeleteTarget {
  id: number;
  pattern: string;
}

function formatDate(ts: number): string {
  return new Date(ts > 1e11 ? ts : ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function Blocks() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.blocks());
    } catch {
      toast("Failed to load blocks", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pattern.trim()) return;
    setSubmitting(true);
    try {
      await api.createBlock(pattern.trim());
      setPattern("");
      await load();
      toast("Block added", "success");
    } catch {
      toast("Failed to add block", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await api.deleteBlock(target.id);
      setRows(prev => prev.filter(b => b.id !== target.id));
      toast(`Block removed`, "success");
    } catch {
      toast("Failed to remove block", "error");
    }
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 className="page-title">Blocks</h1>
          {!loading && (
            <span className="badge badge-muted" style={{ position: "relative", top: -2 }}>
              {rows.length}
            </span>
          )}
        </div>
        <p className="page-subtitle">
          Sender blocks — patterns matched against incoming mail before forwarding.
        </p>
      </div>

      {/* Explainer callout */}
      <div className="callout stagger-1" style={{ marginBottom: 24 }}>
        <strong>How blocks work —</strong>{" "}
        <strong>Global blocks</strong> apply across all aliases — any matching sender is silently
        dropped before forwarding. <strong>Per-alias blocks</strong> scope to a single alias and
        appear with a labeled badge. Patterns support wildcards:{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78em" }}>*@spam.com</span>{" "}
        blocks an entire domain;{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78em" }}>evil@badactor.org</span>{" "}
        blocks a specific sender.
      </div>

      {/* Add block form */}
      <div className="card stagger-2" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Add Block</span>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-strip">
            <div className="field grow">
              <label className="field-label" htmlFor="block-pattern">
                Pattern
              </label>
              <input
                id="block-pattern"
                className="input input-mono"
                type="text"
                placeholder="*@spam.com or evil@badactor.org"
                value={pattern}
                onChange={e => setPattern(e.target.value)}
                required
                disabled={submitting}
              />
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={submitting || !pattern.trim()}
              style={{ alignSelf: "flex-end" }}
            >
              {submitting ? "Blocking…" : "Block sender"}
            </button>
          </div>
        </form>
      </div>

      {/* Blocks table */}
      <div className="stagger-3">
        <div className="table-wrap">
          <table className="dossier">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Scope</th>
                <th>Added</th>
                <th></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={4} rows={4} />
            ) : (
              <tbody>
                {rows.map(b => (
                  <tr key={b.id}>
                    <td>
                      <div className="addr-cell">
                        <span className="addr-mono">{b.pattern}</span>
                        <CopyButton text={b.pattern} />
                      </div>
                    </td>
                    <td>
                      {b.alias_id === null ? (
                        <span className="badge badge-muted">global</span>
                      ) : (
                        <span className="badge badge-amber">alias #{b.alias_id}</span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-muted">{formatDate(b.created_at)}</span>
                    </td>
                    <td>
                      <button
                        className="btn-icon danger"
                        type="button"
                        onClick={() => setDeleteTarget({ id: b.id, pattern: b.pattern })}
                        title="Delete block"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && rows.length === 0 && (
            <EmptyState
              icon={<ShieldAlert size={40} />}
              title="No blocks yet"
              body="Add a sender pattern above to block unwanted mail globally or per-alias."
            />
          )}
        </div>
      </div>

      {/* Confirm delete dialog */}
      {deleteTarget && (
        <ConfirmDialog
          title="Remove block"
          body={`Remove the block for "${deleteTarget.pattern}"? Mail matching this pattern will no longer be filtered.`}
          confirmLabel="Remove block"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
