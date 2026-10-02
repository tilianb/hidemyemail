import { useEffect, useState } from "react";
import { api, type Domain, type SuppressionEntry, type SuppressionSummary } from "../api";
import { useToast, TableSkeleton, EmptyState, ConfirmDialog, PromptDialog, ChoiceDialog, CopyButton } from "../ui";
import { FreshAuthDialog, useFreshAuth } from "../security/FreshAuth";
import { EnvironmentSection } from "./admin/EnvironmentSection";
import { SystemSettingsSection, type SettingsData } from "./admin/SystemSettingsSection";
import { Users, Trash2, Globe, Cloud, Edit3, Key, CheckCircle, XCircle, AlertTriangle } from "lucide-react";

function verificationRecords(domain: Domain, sesRegion: string) {
  return {
    txtHost: `_hidemyemail.${domain.domain}`,
    txtValue: `hidemyemail-verify=${domain.verification_token ?? ""}`,
    mxHost: domain.domain,
    mxValue: `inbound-smtp.${sesRegion}.amazonaws.com`,
    spfHost: domain.domain,
    spfValue: "v=spf1 include:amazonses.com ~all",
    wildcardMxHost: `*.${domain.domain}`,
    wildcardMxValue: `inbound-smtp.${sesRegion}.amazonaws.com`,
  };
}

function DnsField({ label, value, flex = 1 }: { label: string; value: string; flex?: number }) {
  return (
    <div className="dns-field" style={{ flex }}>
      <div className="dns-field-label">{label}</div>
      <div className="dns-field-value">
        <code className="input-mono">{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

function DnsRecordRow({ type, fields, status }: { type: string; fields: { label: string; value: string; flex?: number }[], status?: "success" | "error" }) {
  return (
    <div className="dns-record-row">
      <div className="dns-record-type">
        <span>Type</span>
        <code className="input-mono">{type}</code>
      </div>
      {fields.map(field => <DnsField key={`${type}-${field.label}`} label={field.label} value={field.value} flex={field.flex} />)}
      {status === "success" && (
        <div style={{ display: "flex", alignItems: "center", paddingLeft: "1rem", marginLeft: "auto" }}>
          <CheckCircle size={20} style={{ color: "#10b981" }} />
        </div>
      )}
      {status === "error" && (
        <div style={{ display: "flex", alignItems: "center", paddingLeft: "1rem", marginLeft: "auto" }}>
          <XCircle size={20} style={{ color: "#ef4444" }} />
        </div>
      )}
    </div>
  );
}

export function Admin() {
  const { toast } = useToast();
  const [users, setUsers] = useState<{ id: number; created_at: number; alias_count: number; active: number; forwarding: number; name: string | null }[]>([]);
  const [stats, setStats] = useState<{ users: number; aliases: number; active: number } | null>(null);
  const [globalDomains, setGlobalDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [domainForm, setDomainForm] = useState("");
  const [submittingDomain, setSubmittingDomain] = useState(false);
  const [awsTab, setAwsTab] = useState<"auto" | "manual">("auto");
  const [showAwsSetup, setShowAwsSetup] = useState(false);
  const [showDomains, setShowDomains] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [confirmState, setConfirmState] = useState<{ title: string; body: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const [promptState, setPromptState] = useState<{ title: string; body: string; defaultValue?: string; confirmLabel?: string; onConfirm: (val: string) => void } | null>(null);
  const [choiceState, setChoiceState] = useState<{ title: string; body: string; primaryLabel: string; secondaryLabel: string; onPrimary: () => void; onSecondary: () => void; } | null>(null);
  const [expandedVerifyId, setExpandedVerifyId] = useState<number | null>(null);
  const [verifyingDomain, setVerifyingDomain] = useState(false);
  const [healthStatus, setHealthStatus] = useState<Record<number, { verify_txt?: "success" | "error"; mx?: "success" | "error"; spf?: "success" | "error"; wildcard_mx?: "success" | "error" }>>(() => {
    try { return JSON.parse(localStorage.getItem("domain_health") || "{}"); } catch { return {}; }
  });

  useEffect(() => {
    try { localStorage.setItem("domain_health", JSON.stringify(healthStatus)); } catch {}
  }, [healthStatus]);

  const [suppressions, setSuppressions] = useState<SuppressionEntry[]>([]);
  const [suppressionSummary, setSuppressionSummary] = useState<SuppressionSummary | null>(null);
  const [suppressionHealth, setSuppressionHealth] = useState<"healthy" | "attention">("healthy");
  const [showSuppressions, setShowSuppressions] = useState(false);
  const [envData, setEnvData] = useState<{ vars: Record<string, { value: string; secret: false }>; secrets: Record<string, { configured: boolean; preview?: string }> } | null>(null);
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const freshAuth = useFreshAuth({ onError: message => toast(message, "error") });
  const workerOrigin = window.location.origin;
  const currentMainGlobalDomain = settingsData?.main_global_domain?.value || "";
  const sesRegion = settingsData?.ses_region?.value || envData?.vars.SES_REGION.value || "us-east-1";
  const activeUserCount = users.filter(u => u.active === 1).length;
  const forwardingUserCount = users.filter(u => u.forwarding === 1).length;
  const sortedGlobalDomains = [...globalDomains].sort((a, b) => {
    if (a.domain === currentMainGlobalDomain) return -1;
    if (b.domain === currentMainGlobalDomain) return 1;
    return a.domain.localeCompare(b.domain);
  });

  async function load() {
    setLoading(true);
    try {
      const [uRes, sRes, doms, envRes, setRes, supRes] = await Promise.all([
        api.adminUsers(),
        api.adminStats(),
        api.domains(),
        api.adminEnv(),
        api.adminSettings(),
        api.adminSuppressions(),
      ]);
      setUsers(uRes.users);
      setStats(sRes.totals);
      setGlobalDomains(doms.filter(d => d.is_global === 1));
      setEnvData(envRes);
      setSettingsData(setRes.settings);
      setSuppressions(supRes.suppressions);
      setSuppressionSummary(supRes.totals);
      setSuppressionHealth(supRes.health);
    } catch {
      toast("Failed to load admin data", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const freshGuard = freshAuth.guard;

  async function deleteUser(id: number) {
    const result = await freshGuard(() => api.adminDeleteUser(id), () => deleteUser(id));
    if (!result.ok) return;
    toast("User deleted", "success");
    await load();
  }

  async function recoverUserByEmail(id: number) {
    const result = await freshGuard(() => api.adminRecoverUser(id, true), () => recoverUserByEmail(id));
    if (!result.ok) return;
    if (result.value.delivery === "manual" && result.value.token) {
      toast("Email delivery failed. Share the recovery link manually.", "error");
      showRecoveryLink(result.value.token);
      return;
    }
    toast("Recovery email sent to user", "success");
  }

  async function recoverUserByLink(id: number) {
    const result = await freshGuard(() => api.adminRecoverUser(id, false), () => recoverUserByLink(id));
    if (!result.ok) return;
    if (result.value.token) showRecoveryLink(result.value.token);
  }

  function showRecoveryLink(token: string) {
    const url = `${window.location.origin}/recover?token=${token}`;
    setPromptState({
      title: "Recovery Link",
      body: "Copy this secure 24-hour recovery link and send it to the user:",
      defaultValue: url,
      confirmLabel: "Done",
      onConfirm: () => {},
    });
  }

  function requestRemoveUser(id: number) {
    if (id === 1) return toast("Cannot delete admin user", "error");
    setConfirmState({
      title: "Delete User",
      body: "Are you sure? This will delete the user and all their aliases, domains, rules, and events permanently.",
      confirmLabel: "Delete User",
      onConfirm: async () => {
        try {
          await deleteUser(id);
        } catch (err: any) {
          toast(err.message || "Failed to delete user", "error");
        }
      }
    });
  }

  async function createGlobalDomain(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingDomain(true);
    try {
      await api.adminCreateDomain(domainForm);
      setDomainForm("");
      toast("Global domain created", "success");
      await load();
    } catch (err: any) {
      toast(err.message || "Failed to create domain", "error");
    } finally {
      setSubmittingDomain(false);
    }
  }

  async function clearSuppression(id: number) {
    try {
      await api.adminClearSuppression(id);
      await load();
      toast("Suppression cleared", "success");
    } catch (err: any) {
      toast(err.message || "Failed to clear suppression", "error");
    }
  }

  async function verifyDomain(domain: Domain) {
    setVerifyingDomain(true);
    setHealthStatus(prev => { const { [domain.id]: _, ...rest } = prev; return rest; });
    try {
      const res = await api.adminVerifyDomain(domain.id);
      if (res.results) {
        const wildcardStatus = domain.allow_subdomain_aliases === 1
          ? (res.results.wildcard_mx ? "success" : "error")
          : undefined;
        setHealthStatus(prev => ({
          ...prev,
          [domain.id]: {
            verify_txt: res.results!.verify_txt ? "success" : "error",
            mx: res.results!.mx ? "success" : "error",
            spf: res.results!.spf ? "success" : "error",
            wildcard_mx: wildcardStatus,
          }
        }));
      }
      if (res.verified) {
        toast("Domain verified successfully", "success");
        if (!domain.verified_at) setExpandedVerifyId(null);
        await load();
      } else {
        toast(res.error || "Domain not yet verified", "error");
      }
    } catch (err: any) {
      toast(err.message || "Failed to verify domain", "error");
    } finally {
      setVerifyingDomain(false);
    }
  }

  return (
    <div className="admin-control-room">
      <div className="page-header admin-hero">
        <div className="admin-hero-kicker">Control Room</div>
        <div className="admin-hero-title-row">
          <h1 className="page-title">System Administration</h1>
          <span className="badge badge-amber">Operator</span>
        </div>
        <p className="page-subtitle">
          Manage runtime policy, user access, global domains, and SES infrastructure from one coherent console.
        </p>
      </div>

      {stats && (
        <div className="admin-stat-grid stagger-1">
          <div className="stat-card">
            <div className="stat-label">Total Users</div>
            <div className="stat-value">{stats.users.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Total Aliases</div>
            <div className="stat-value">{stats.aliases.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Active Aliases</div>
            <div className="stat-value">{stats.active.toLocaleString()}</div>
          </div>
        </div>
      )}

      <div className={`card admin-panel-card admin-domain-card stagger-2 ${showDomains ? "is-open" : ""}`}>
        <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setShowDomains(!showDomains)}>
          <div>
            <span className="card-title admin-section-title">
              <Globe size={18} /> Domains
            </span>
            <p className="admin-section-subtitle">Domains all users can select after DNS and relay readiness checks pass.</p>
          </div>
          <button className="admin-panel-toggle" type="button" onClick={(e) => { e.stopPropagation(); setShowDomains(!showDomains); }}>
            {showDomains ? "Hide" : "Show"}
          </button>
        </div>
        {showDomains && (
        <div className="card-body">
          <form onSubmit={createGlobalDomain} className="form-strip admin-domain-form">
            <div className="field grow">
              <label className="field-label" htmlFor="global-dom">Add global domain</label>
              <input
                id="global-dom"
                className="input input-mono"
                type="text"
                placeholder="aliases.example.net"
                value={domainForm}
                onChange={e => setDomainForm(e.target.value.toLowerCase())}
                required
                disabled={submittingDomain}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={submittingDomain} style={{ alignSelf: "flex-end" }}>
              {submittingDomain ? "Adding..." : "Add Global Domain"}
            </button>
          </form>
          
          {globalDomains.length > 0 && (
            <div className="domain-control-stack">
              {sortedGlobalDomains.map(d => {
                const records = verificationRecords(d, sesRegion);
                const expanded = expandedVerifyId === d.id;
                const isMain = d.domain === currentMainGlobalDomain;
                return (
                  <section key={d.id} className={`domain-module ${isMain ? "domain-module-main" : ""}`}>
                    <div className="domain-module-mainline">
                      <div className="domain-identity">
                        {(() => {
                          let dotColor = "var(--text-muted)";
                          let shadowColor = "transparent";
                          const dh = healthStatus[d.id];
                          const hasHealthError = dh && (
                            dh.verify_txt === "error" ||
                            dh.mx === "error" ||
                            dh.spf === "error" ||
                            (d.allow_subdomain_aliases === 1 && dh.wildcard_mx === "error")
                          );
                          if (hasHealthError) {
                            dotColor = "#ef4444";
                            shadowColor = "rgba(239, 68, 68, 0.45)";
                          } else if (!d.verified_at) {
                            dotColor = "var(--accent)";
                            shadowColor = "rgba(255, 179, 0, 0.45)";
                          } else if (d.active === 1) {
                            dotColor = "#10b981";
                            shadowColor = "rgba(16, 185, 129, 0.45)";
                          }
                          return (
                            <span 
                              className="domain-signal" 
                              aria-hidden="true" 
                              style={{ background: dotColor, boxShadow: `0 0 18px ${shadowColor}` }} 
                            />
                          );
                        })()}
                        <div>
                          <div className="domain-name-line">
                            <span className="font-mono domain-name">{d.domain}</span>
                            {isMain && <span className="badge badge-amber">Primary</span>}
                            {d.verified_at ? <span className="badge badge-green">Verified</span> : <span className="badge badge-muted">Pending DNS</span>}
                          </div>
                          <div className="domain-meta">
                            {isMain ? "Pinned main global domain" : `Added ${new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}`}
                            <span>•</span>
                            <span>{d.active === 1 ? "Available to users" : "Disabled"}</span>
                          </div>
                        </div>
                      </div>
                      <div className="domain-actions">
                        <button className="btn btn-outline btn-sm" type="button" onClick={() => setExpandedVerifyId(expanded ? null : d.id)}>
                          {expanded ? "Hide DNS" : (d.verified_at ? "DNS records" : "Verify DNS")}
                        </button>

                        {!isMain && (
                          <label className="domain-toggle" style={{ opacity: !d.verified_at ? 0.5 : 1, cursor: !d.verified_at ? "not-allowed" : "pointer" }} title={!d.verified_at ? "Verify DNS before activating" : ""}>
                            <span>Active</span>
                            <div className="switch">
                              <input type="checkbox" checked={d.active === 1} disabled={!d.verified_at} onChange={async (e) => {
                                try {
                                  await api.adminUpdateDomain(d.id, { active: e.target.checked ? 1 : 0 });
                                  load();
                                } catch (err: any) { toast(err.message, "error"); }
                              }} />
                              <span className="switch-track"></span>
                            </div>
                          </label>
                        )}

                        <label className="domain-toggle" style={{ opacity: d.active && d.verified_at ? 1 : 0.5 }} title={!d.verified_at ? "Verify DNS before enabling subdomain aliases" : ""}>
                            <span>Subdomain aliases</span>
                            <div className="switch">
                              <input type="checkbox" checked={d.allow_subdomain_aliases === 1} disabled={!d.active || !d.verified_at} onChange={async (e) => {
                                try {
                                  await api.adminUpdateDomain(d.id, { allow_subdomain_aliases: e.target.checked ? 1 : 0 });
                                  load();
                                } catch (err: any) { toast(err.message, "error"); }
                              }} />
                              <span className="switch-track"></span>
                            </div>
                          </label>

                        <label className="domain-toggle" style={{ opacity: d.active ? 1 : 0.5 }}>
                          <span>Custom aliases</span>
                          <div className="switch">
                              <input type="checkbox" checked={d.allow_custom_aliases === 1} onChange={async (e) => {
                                try {
                                  await api.adminUpdateDomain(d.id, { allow_custom_aliases: e.target.checked ? 1 : 0 });
                                  load();
                                } catch (err: any) { toast(err.message, "error"); }
                              }} />
                              <span className="switch-track"></span>
                            </div>
                        </label>

                        {d.domain !== currentMainGlobalDomain ? (
                            <button 
                              className="btn-icon danger" 
                              title="Delete global domain"
                              onClick={() => {
                                setConfirmState({
                                  title: "Delete Global Domain",
                                  body: `Delete ${d.domain} and ALL associated aliases for ALL users?`,
                                  confirmLabel: "Delete Domain",
                                  onConfirm: async () => {
                                    try {
                                      await api.deleteDomain(d.id);
                                      toast("Global domain deleted", "success");
                                      await load();
                                    } catch (err: any) {
                                      toast(err.message || "Failed to delete domain", "error");
                                    }
                                  }
                                });
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                        ) : (
                            <button className="btn-icon danger" style={{ visibility: "hidden" }} disabled aria-hidden="true">
                              <Trash2 size={16} />
                            </button>
                        )}
                      </div>
                    </div>

                    {expanded && (
                      <div className="dns-panel">
                        <div className="dns-panel-header">
                          <div>
                            <div className="dns-panel-title">DNS records for <span className="font-mono">{d.domain}</span></div>
                            <p>Copy these exact provider-ready records. Use the full Host/FQDN shown below for your DNS host field.</p>
                          </div>
                          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <button 
                              className={d.verified_at ? "btn btn-outline btn-sm" : "btn btn-primary btn-sm"} 
                              onClick={() => verifyDomain(d)}
                              disabled={verifyingDomain}
                            >
                              {verifyingDomain ? "Checking..." : (d.verified_at ? "Check Health" : "Verify DNS")}
                            </button>
                          </div>
                        </div>
                        <div className="dns-record-grid">
                            <DnsRecordRow
                              type="MX"
                              status={healthStatus[d.id]?.mx}
                              fields={[
                                { label: "Host / FQDN", value: records.mxHost, flex: 1 },
                                { label: "Priority", value: "10", flex: 0.5 },
                                { label: "Value", value: records.mxValue, flex: 2 },
                              ]}
                            />
                            {d.allow_subdomain_aliases === 1 && (
                              <DnsRecordRow
                                type="MX (wildcard)"
                                status={healthStatus[d.id]?.wildcard_mx}
                                fields={[
                                  { label: "Host / FQDN", value: records.wildcardMxHost, flex: 1 },
                                  { label: "Priority", value: "10", flex: 0.5 },
                                  { label: "Value", value: records.wildcardMxValue, flex: 2 },
                                ]}
                              />
                            )}
                            <DnsRecordRow
                              type="TXT"
                              status={healthStatus[d.id]?.verify_txt}
                              fields={[
                                { label: "Host / FQDN", value: records.txtHost, flex: 1 },
                                { label: "Value", value: records.txtValue, flex: 2 },
                              ]}
                            />
                            <DnsRecordRow
                              type="TXT (SPF)"
                              status={healthStatus[d.id]?.spf}
                              fields={[
                                { label: "Host / FQDN", value: records.spfHost, flex: 1 },
                                { label: "Value", value: records.spfValue, flex: 2 },
                              ]}
                            />
                        </div>
                        </div>
                      )}
                  </section>
                  );
                })}
            </div>
          )}
        </div>
        )}
      </div>

      <div className={`card admin-panel-card admin-users-card stagger-3 ${showUsers ? "is-open" : ""}`}>
        <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setShowUsers(!showUsers)}>
          <div>
            <span className="card-title admin-section-title">
              <Users size={18} /> Users
            </span>
            <p className="admin-section-subtitle">Login access, forwarding state, recovery, and account controls.</p>
          </div>
          <div className="admin-section-actions">
            <button className="admin-panel-toggle" type="button" onClick={(e) => { e.stopPropagation(); setShowUsers(!showUsers); }}>
              {users.length} users · {showUsers ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {showUsers && (
        <div className="card-body">
          <div className="admin-user-summary">
            <span><strong>{activeUserCount}</strong> active</span>
            <span><strong>{forwardingUserCount}</strong> forwarding</span>
            <span><strong>{users.length - activeUserCount}</strong> disabled</span>
          </div>
          <div className="table-wrap table-wrap-stack admin-users-table">
          <table className="dossier dossier-stack">
            <thead>
                <tr>
                  <th style={{ width: 120 }}>User ID</th>
                  <th>Name</th>
                  <th>Joined</th>
                  <th>Aliases</th>
                  <th style={{ textAlign: "center" }}>Login</th>
                  <th style={{ textAlign: "center" }}>Email</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={4} rows={3} />
            ) : (
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td data-label="ID" className="font-mono text-muted">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>#{u.id}</span>
                        {u.id === 1 && <span className="badge badge-amber">Admin</span>}
                      </div>
                    </td>
                    <td data-label="Name">
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {u.name || <span className="text-muted" style={{ fontStyle: "italic" }}>Anonymous</span>}
                        {u.id !== 1 && (
                          <button className="btn-icon" title="Rename user" onClick={() => {
                            setPromptState({
                              title: "Rename User",
                              body: "Enter new name for User #" + u.id,
                              defaultValue: u.name || "",
                              onConfirm: async (newName) => {
                                try {
                                  await api.adminUpdateUser(u.id, { name: newName });
                                  toast("User renamed", "success");
                                  load();
                                } catch (e: any) { toast(e.message, "error"); }
                              }
                            });
                          }}>
                            <Edit3 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td data-label="Joined">
                      <span className="text-muted">
                        {new Date(u.created_at > 1e11 ? u.created_at : u.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td data-label="Aliases">{u.alias_count}</td>
                    <td data-label="Login" style={{ textAlign: "center" }}>
                      <label className="switch" style={{ margin: "0 auto", opacity: u.id === 1 ? 0.5 : 1 }}>
                        <input type="checkbox" checked={u.active === 1} disabled={u.id === 1} onChange={async (e) => {
                          try {
                            await api.adminUpdateUser(u.id, { active: e.target.checked ? 1 : 0 });
                            load();
                          } catch (err: any) { toast(err.message, "error"); }
                        }} />
                        <span className="switch-track"></span>
                      </label>
                    </td>
                    <td data-label="Email" style={{ textAlign: "center" }}>
                      <label className="switch" style={{ margin: "0 auto", opacity: u.id === 1 ? 0.5 : 1 }}>
                        <input type="checkbox" checked={u.forwarding === 1} disabled={u.id === 1} onChange={async (e) => {
                          try {
                            await api.adminUpdateUser(u.id, { forwarding: e.target.checked ? 1 : 0 });
                            load();
                          } catch (err: any) { toast(err.message, "error"); }
                        }} />
                        <span className="switch-track"></span>
                      </label>
                    </td>
                    <td data-label="Actions" style={{ textAlign: "right" }}>
                      {u.id !== 1 && (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button className="btn-icon" title="Recover User" onClick={() => {
                            setChoiceState({
                              title: "Recover User",
                              body: "How would you like to deliver the recovery link?",
                              primaryLabel: "Send via Email",
                              onPrimary: async () => {
                                try {
                                  await recoverUserByEmail(u.id);
                                } catch (err: any) { toast(err.message, "error"); }
                              },
                              secondaryLabel: "Copy Link",
                              onSecondary: async () => {
                                try {
                                  await recoverUserByLink(u.id);
                                } catch (err: any) { toast(err.message, "error"); }
                              }
                            });
                          }}>
                            <Key size={16} />
                          </button>
                          <button className="btn-icon danger" onClick={() => requestRemoveUser(u.id)} title="Delete user">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {!loading && users.length === 0 && (
            <EmptyState
              icon={<Users size={40} />}
              title="No users"
              body="No users have signed up yet."
            />
          )}
          </div>
        </div>
        )}
      </div>

      <div className={`card admin-panel-card stagger-4 ${showSuppressions ? "is-open" : ""}`}>
        <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setShowSuppressions(!showSuppressions)}>
          <div>
            <span className="card-title admin-section-title">
              <AlertTriangle size={18} /> Suppressions
            </span>
            <p className="admin-section-subtitle">Destinations suppressed due to bounces or complaints. Hard suppressions require admin clearance.</p>
          </div>
          <button className="admin-panel-toggle" type="button" onClick={(e) => { e.stopPropagation(); setShowSuppressions(!showSuppressions); }}>
            {suppressions.length} suppressed · {showSuppressions ? "Hide" : "Show"}
          </button>
        </div>
        {showSuppressions && (
          <div className="card-body">
            {suppressionSummary && (
              <div className="admin-stats-grid" style={{ marginBottom: 16 }}>
                <div className="stat-card">
                  <div className="stat-label">Reputation Health</div>
                  <div className="stat-value">
                    {suppressionHealth === "attention" ? (
                      <span className="badge badge-red">Attention</span>
                    ) : (
                      <span className="badge badge-green">Healthy</span>
                    )}
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Bounces 24h / 7d</div>
                  <div className="stat-value">{suppressionSummary.bounce_24h} / {suppressionSummary.bounce_7d}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Complaints 24h / 7d</div>
                  <div className="stat-value">{suppressionSummary.complaint_24h} / {suppressionSummary.complaint_7d}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Hard / Soft Suppressed</div>
                  <div className="stat-value">{suppressionSummary.hard_suppressed} / {suppressionSummary.soft_suppressed}</div>
                </div>
              </div>
            )}
            {suppressions.length === 0 ? (
              <EmptyState
                icon={<AlertTriangle size={40} />}
                title="No suppressions"
                body="No destinations are currently suppressed."
              />
            ) : (
              <div className="table-wrap table-wrap-stack">
                <table className="dossier dossier-stack">
                  <thead>
                    <tr>
                      <th>Destination ID</th>
                      <th>User</th>
                      <th>Class</th>
                      <th>Reason</th>
                      <th>Suppressed At</th>
                      <th>Bounces (24h / 7d)</th>
                      <th>Complaints (24h / 7d)</th>
                      <th className="th-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppressions.map(s => (
                      <tr key={s.id}>
                        <td data-label="Destination ID"><span className="font-mono text-muted">#{s.id}</span></td>
                        <td data-label="User"><span className="font-mono text-muted">#{s.user_id}</span></td>
                        <td data-label="Class">
                          {s.suppression_class === "hard" ? (
                            <span className="badge badge-red">Hard</span>
                          ) : (
                            <span className="badge badge-yellow">Soft</span>
                          )}
                        </td>
                        <td data-label="Reason"><span className="text-muted">{s.suppression_reason?.replace(/_/g, " ") ?? "—"}</span></td>
                        <td data-label="Suppressed At">
                          <span className="font-mono text-muted">
                            {new Date(s.suppressed_at > 1e11 ? s.suppressed_at : s.suppressed_at * 1000).toLocaleDateString()}
                          </span>
                        </td>
                        <td data-label="Bounces (24h / 7d)"><span className="font-mono">{s.bounce_24h} / {s.bounce_7d}</span></td>
                        <td data-label="Complaints (24h / 7d)"><span className="font-mono">{s.complaint_24h} / {s.complaint_7d}</span></td>
                        <td>
                          <div className="table-actions">
                            <button
                              className="btn btn-secondary btn-compact"
                              onClick={() => clearSuppression(s.id)}
                              title="Clear suppression"
                            >
                              Clear
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {settingsData && <SystemSettingsSection
        initialSettings={settingsData}
        globalDomains={globalDomains}
        onSaved={setSettingsData}
      />}
      {envData && <EnvironmentSection data={envData} />}

      {/* AWS Onboarding Wizard */}
      <div className={`card admin-panel-card admin-aws-card stagger-7 ${showAwsSetup ? "is-open" : ""}`}>
        <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setShowAwsSetup(!showAwsSetup)}>
          <div>
            <span className="card-title admin-section-title">
              <Cloud size={18} /> AWS Setup
            </span>
            <p className="admin-section-subtitle">One-time SES, SNS, and S3 provisioning templates.</p>
          </div>
          <button className="admin-panel-toggle" type="button" onClick={(e) => { e.stopPropagation(); setShowAwsSetup(!showAwsSetup); }}>
            {showAwsSetup ? "Hide" : "Show"}
          </button>
        </div>
        {showAwsSetup && (
          <div className="card-body">
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 16 }}>
            Set up the required AWS services (SES, SNS, S3) for inbound and outbound email routing.
            SNS requests are authenticated by AWS signature verification, so webhook URLs do not need shared secrets.
            Configure each environment with its own exact SNS topic ARNs.
          </p>
          
          <div className="tabs" style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            <button className={`btn ${awsTab === "auto" ? "btn-outline" : "btn-ghost"}`} onClick={() => setAwsTab("auto")}>
              Auto Setup (CloudFormation)
            </button>
            <button className={`btn ${awsTab === "manual" ? "btn-outline" : "btn-ghost"}`} onClick={() => setAwsTab("manual")}>
              Manual Setup (AWS CLI)
            </button>
          </div>
          
          {awsTab === "auto" && (
            <div style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 6, fontSize: "0.85rem" }}>
              <p style={{ marginBottom: 12 }}>
                We recommend using AWS CloudFormation to automatically provision all required resources securely.
                Save the template below as <code>template.yaml</code> and deploy it in the AWS Console. For preview/dev,
                use the preview Worker URL and copy the generated preview topic ARNs into that environment.
              </p>
              <textarea 
                className="input input-mono" 
                readOnly 
                style={{ width: "100%", height: 350, fontSize: "11px", marginBottom: 8 }}
                value={`AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  WorkerBaseUrl:
    Type: String
    Default: "${workerOrigin}"
    Description: Worker origin, for example https://hidemyemail-preview.example.workers.dev
Resources:
  InboundBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "hidemyemail-inbound-\${AWS::AccountId}"
  InboundBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref InboundBucket
      PolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: ses.amazonaws.com
            Action: s3:PutObject
            Resource: !Sub "arn:aws:s3:::\${InboundBucket}/*"
            Condition:
              StringEquals:
                "aws:Referer": !Ref AWS::AccountId
  InboundTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: hidemyemail-inbound
  OutboundTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: hidemyemail-outbound
  InboundWorkerSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      Protocol: https
      TopicArn: !Ref InboundTopic
      Endpoint: !Sub "\${WorkerBaseUrl}/api/ses/inbound"
  OutboundWorkerSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      Protocol: https
      TopicArn: !Ref OutboundTopic
      Endpoint: !Sub "\${WorkerBaseUrl}/api/ses/notification"
  InboundRuleSet:
    Type: AWS::SES::ReceiptRuleSet
    Properties:
      RuleSetName: "hidemyemail-rules"
  InboundRule:
    Type: AWS::SES::ReceiptRule
    Properties:
      RuleSetName: !Ref InboundRuleSet
      Rule:
        Name: "store-and-notify"
        Enabled: true
        ScanEnabled: true
        Actions:
          - S3Action:
              BucketName: !Ref InboundBucket
              TopicArn: !Ref InboundTopic
Outputs:
  InboundBucketName:
    Value: !Ref InboundBucket
  SnsInboundTopicArn:
    Value: !Ref InboundTopic
  SnsAllowedTopicArn:
    Value: !Ref OutboundTopic`}
              />
              <p className="text-muted">
                After deployment, copy <code>InboundBucketName</code>, <code>SnsInboundTopicArn</code>, and <code>SnsAllowedTopicArn</code> to your Worker environment. Confirm the SNS subscriptions in AWS if they are still pending. Also mark the "hidemyemail-rules" SES rule set active in the AWS console.
              </p>
            </div>
          )}

          {awsTab === "manual" && (
            <div style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 6, fontSize: "0.85rem" }}>
              <p style={{ marginBottom: 12 }}>
                Run the following AWS CLI commands to provision the resources manually. The subscription endpoints intentionally have no <code>secret</code> or <code>allowed_topic</code> query parameters.
              </p>
              <pre style={{ overflowX: "auto", background: "#000", padding: 12, borderRadius: 4, color: "#0f0" }}>
{`# 1. Create S3 Bucket for inbound emails
BUCKET_NAME="hidemyemail-inbound-$RANDOM"
aws s3api create-bucket --bucket $BUCKET_NAME

# 2. Attach S3 Policy for SES to write emails
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3api put-bucket-policy --bucket $BUCKET_NAME --policy "{\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"Service\\":\\"ses.amazonaws.com\\"},\\"Action\\":\\"s3:PutObject\\",\\"Resource\\":\\"arn:aws:s3:::$BUCKET_NAME/*\\",\\"Condition\\":{\\"StringEquals\\":{\\"aws:Referer\\":\\"$ACCOUNT_ID\\"}}}]}"

# 3. Create SNS Topics
WORKER_ORIGIN="${workerOrigin}"
INBOUND_TOPIC_ARN=$(aws sns create-topic --name hidemyemail-inbound --query TopicArn --output text)
OUTBOUND_TOPIC_ARN=$(aws sns create-topic --name hidemyemail-outbound --query TopicArn --output text)

# 4. Subscribe Worker webhooks. SNS signatures authenticate requests.
aws sns subscribe --topic-arn $INBOUND_TOPIC_ARN --protocol https --notification-endpoint "$WORKER_ORIGIN/api/ses/inbound"
aws sns subscribe --topic-arn $OUTBOUND_TOPIC_ARN --protocol https --notification-endpoint "$WORKER_ORIGIN/api/ses/notification"

# 5. Create SES Receipt Rule Set and Rule
aws ses create-receipt-rule-set --rule-set-name hidemyemail-rules
aws ses create-receipt-rule --rule-set-name hidemyemail-rules --rule "{\\"Name\\":\\"store-and-notify\\",\\"Enabled\\":true,\\"Actions\\":[{\\"S3Action\\":{\\"BucketName\\":\\"$BUCKET_NAME\\",\\"TopicArn\\":\\"$INBOUND_TOPIC_ARN\\"}}]}"
aws ses set-active-receipt-rule-set --rule-set-name hidemyemail-rules

# 6. Configure Worker environment
echo "S3_INBOUND_BUCKET=$BUCKET_NAME"
echo "SNS_INBOUND_TOPIC_ARN=$INBOUND_TOPIC_ARN"
echo "SNS_ALLOWED_TOPIC_ARN=$OUTBOUND_TOPIC_ARN"`}
              </pre>
            </div>
          )}
        </div>
        )}
      </div>

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          body={confirmState.body}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={() => { confirmState.onConfirm(); setConfirmState(null); }}
          onCancel={() => setConfirmState(null)}
        />
      )}
      {promptState && (
        <PromptDialog
          title={promptState.title}
          body={promptState.body}
          defaultValue={promptState.defaultValue}
          confirmLabel={promptState.confirmLabel}
          onConfirm={(val) => { promptState.onConfirm(val); setPromptState(null); }}
          onCancel={() => setPromptState(null)}
        />
      )}
      {choiceState && (
        <ChoiceDialog
          title={choiceState.title}
          body={choiceState.body}
          primaryLabel={choiceState.primaryLabel}
          secondaryLabel={choiceState.secondaryLabel}
          onPrimary={() => { choiceState.onPrimary(); setChoiceState(null); }}
          onSecondary={() => { choiceState.onSecondary(); setChoiceState(null); }}
          onCancel={() => setChoiceState(null)}
        />
      )}
      <FreshAuthDialog controller={freshAuth} body="This administrator action needs a recent identity check." />
    </div>
  );
}
