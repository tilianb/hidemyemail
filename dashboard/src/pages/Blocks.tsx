import { useEffect, useState } from "react";
import { api, type Alias, type Block, type Domain } from "../api";
import { useToast, CopyButton, ConfirmDialog, TableSkeleton, EmptyState } from "../ui";
import { ShieldAlert, Trash2 } from "lucide-react";

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
  const [subdomains, setSubdomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<"block" | "allow">("block");
  const [scope, setScope] = useState<"global" | "alias" | "subdomain">("global");
  const [aliasId, setAliasId] = useState<number | null>(null);
  const [domainId, setDomainId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const selectedAliasId = scope === "alias" ? aliasId ?? aliases[0]?.id ?? null : null;
  const selectedDomainId = scope === "subdomain" ? domainId ?? subdomains[0]?.id ?? null : null;

  function aliasLabel(id: number | null): string {
    if (id === null) return "global";
    return aliases.find(a => a.id === id)?.full_address ?? `alias #${id}`;
  }

  function domainLabel(id: number): string {
    return subdomains.find(d => d.id === id)?.domain ?? `domain #${id}`;
  }

  async function load() {
    setLoading(true);
    try {
      const [blockRows, aliasRows, domainRows] = await Promise.all([api.blocks(), api.aliases(), api.domains()]);
      setRows(blockRows);
      setAliases(aliasRows);
      setSubdomains(domainRows.filter(d => d.is_global === 0));
      setAliasId(current => current ?? aliasRows[0]?.id ?? null);
      setDomainId(current => current ?? domainRows.find(d => d.is_global === 0)?.id ?? null);
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
      toast("Create an alias before adding a per-alias rule", "error");
      return;
    }
    if (scope === "subdomain" && selectedDomainId === null) {
      toast("Create a subdomain before adding a per-subdomain rule", "error");
      return;
    }
    setSubmitting(true);
    try {
      await api.createBlock(pattern.trim(), {
        alias_id: scope === "alias" ? selectedAliasId ?? undefined : undefined,
        domain_id: scope === "subdomain" ? selectedDomainId ?? undefined : undefined,
        kind,
      });
      setPattern("");
      await load();
      toast(kind === "allow" ? "Allow rule added" : "Block added", "success");
    } catch {
      toast("Failed to add rule", "error");
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
        <strong>How rules work —</strong>{" "}
        <strong>Block</strong> rules drop matching senders before forwarding.{" "}
        <strong>Allow</strong> rules turn on allowlist mode for their scope: once any allow rule
        exists, only senders matching one are forwarded (everything else is dropped). Each rule is
        scoped <strong>globally</strong>, to a <strong>subdomain</strong> (all its aliases), or to a
        single <strong>alias</strong>. Patterns support wildcards:{" "}
        <code>*@spam.com</code>{" "}
        matches an entire domain;{" "}
        <code>evil@badactor.org</code>{" "}
        matches a specific sender.
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
              <label className="field-label" htmlFor="block-kind">Type</label>
              <select
                id="block-kind"
                className="input input-mono"
                value={kind}
                onChange={e => setKind(e.target.value === "allow" ? "allow" : "block")}
                disabled={submitting}
              >
                <option value="block">Block</option>
                <option value="allow">Allow</option>
              </select>
            </div>
            <div className="field form-field-sm">
              <label className="field-label" htmlFor="block-scope">Scope</label>
              <select
                id="block-scope"
                className="input input-mono"
                value={scope}
                onChange={e => {
                  const v = e.target.value;
                  setScope(v === "alias" ? "alias" : v === "subdomain" ? "subdomain" : "global");
                }}
                disabled={submitting}
              >
                <option value="global">Global</option>
                <option value="subdomain">Per subdomain</option>
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
            {scope === "subdomain" && (
              <div className="field grow">
                <label className="field-label" htmlFor="block-subdomain">Subdomain</label>
                <select
                  id="block-subdomain"
                  className="input input-mono"
                  value={selectedDomainId ?? ""}
                  onChange={e => setDomainId(Number(e.target.value))}
                  disabled={submitting || subdomains.length === 0}
                >
                  {subdomains.length === 0 ? (
                    <option value="">No subdomains available</option>
                  ) : (
                    subdomains.map(d => <option key={d.id} value={d.id}>{d.domain}</option>)
                  )}
                </select>
              </div>
            )}
            <button
              className="btn btn-primary form-submit"
              type="submit"
              disabled={
                submitting || !pattern.trim() ||
                (scope === "alias" && selectedAliasId === null) ||
                (scope === "subdomain" && selectedDomainId === null)
              }
            >
              {submitting ? "Saving…" : kind === "allow" ? "Add allow rule" : "Block sender"}
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
                <th>Type</th>
                <th>Scope</th>
                <th>Added</th>
                <th></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={5} rows={4} />
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
                      {b.kind === "allow" ? (
                        <span className="badge badge-purple">allow</span>
                      ) : (
                        <span className="badge badge-muted">block</span>
                      )}
                    </td>
                    <td>
                      {b.alias_id !== null ? (
                        <span className="badge badge-amber">{aliasLabel(b.alias_id)}</span>
                      ) : b.domain_id !== null ? (
                        <span className="badge badge-amber">{domainLabel(b.domain_id)}</span>
                      ) : (
                        <span className="badge badge-muted">global</span>
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
