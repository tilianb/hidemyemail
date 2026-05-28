import { useEffect, useState } from "react";
import { api, type Alias } from "../api";
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
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState("");
  const [scope, setScope] = useState<"global" | "alias">("global");
  const [aliasId, setAliasId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const selectedAliasId = scope === "alias" ? aliasId ?? aliases[0]?.id ?? null : null;

  function aliasLabel(id: number | null): string {
    if (id === null) return "global";
    return aliases.find(a => a.id === id)?.full_address ?? `alias #${id}`;
  }

  async function load() {
    setLoading(true);
    try {
      const [blockRows, aliasRows] = await Promise.all([api.blocks(), api.aliases()]);
      setRows(blockRows);
      setAliases(aliasRows);
      setAliasId(current => current ?? aliasRows[0]?.id ?? null);
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
    if (scope === "alias" && selectedAliasId === null) {
      toast("Create an alias before adding a per-alias block", "error");
      return;
    }
    setSubmitting(true);
    try {
      await api.createBlock(pattern.trim(), selectedAliasId ?? undefined);
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
        <div className="page-title-row">
          <h1 className="page-title">Blocks</h1>
        </div>
        <p className="page-subtitle">
          Sender blocks — patterns matched against incoming mail before forwarding.
        </p>
      </div>

      {/* Explainer callout */}
      <div className="callout stagger-1 card-form-gap">
        <strong>How blocks work —</strong>{" "}
        <strong>Global blocks</strong> apply across all aliases — any matching sender is silently
        dropped before forwarding. <strong>Per-alias blocks</strong> scope to a single alias and
        appear with a labeled badge. Patterns support wildcards:{" "}
        <code>*@spam.com</code>{" "}
        blocks an entire domain;{" "}
        <code>evil@badactor.org</code>{" "}
        blocks a specific sender.
      </div>

      {/* Add block form */}
      <div className="card stagger-2 card-form-gap">
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
            <div className="field form-field-sm">
              <label className="field-label" htmlFor="block-scope">Scope</label>
              <select
                id="block-scope"
                className="input input-mono"
                value={scope}
                onChange={e => setScope(e.target.value === "alias" ? "alias" : "global")}
                disabled={submitting}
              >
                <option value="global">Global</option>
                <option value="alias">Per alias</option>
              </select>
            </div>
            {scope === "alias" && (
              <div className="field grow">
                <label className="field-label" htmlFor="block-alias">Alias</label>
                <select
                  id="block-alias"
                  className="input input-mono"
                  value={selectedAliasId ?? ""}
                  onChange={e => setAliasId(Number(e.target.value))}
                  disabled={submitting || aliases.length === 0}
                >
                  {aliases.length === 0 ? (
                    <option value="">No aliases available</option>
                  ) : (
                    aliases.map(a => <option key={a.id} value={a.id}>{a.full_address}</option>)
                  )}
                </select>
              </div>
            )}
            <button
              className="btn btn-primary form-submit"
              type="submit"
              disabled={submitting || !pattern.trim() || (scope === "alias" && selectedAliasId === null)}
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
                        <span className="badge badge-amber">{aliasLabel(b.alias_id)}</span>
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
