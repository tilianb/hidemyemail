import { useEffect, useState } from "react";
import { api, type Domain } from "../api";
import { useToast, TableSkeleton, EmptyState } from "../ui";
import { Users, Trash2, Globe, Cloud } from "lucide-react";

export function Admin() {
  const { toast } = useToast();
  const [users, setUsers] = useState<{ id: number; created_at: number; alias_count: number }[]>([]);
  const [stats, setStats] = useState<{ users: number; aliases: number; active: number } | null>(null);
  const [globalDomains, setGlobalDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [domainForm, setDomainForm] = useState("");
  const [submittingDomain, setSubmittingDomain] = useState(false);
  const [awsTab, setAwsTab] = useState<"auto" | "manual">("auto");

  async function load() {
    setLoading(true);
    try {
      const [uRes, sRes, doms] = await Promise.all([
        api.adminUsers(),
        api.adminStats(),
        api.domains()
      ]);
      setUsers(uRes.users);
      setStats(sRes.totals);
      setGlobalDomains(doms.filter(d => d.is_global === 1));
    } catch {
      toast("Failed to load admin data", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function removeUser(id: number) {
    if (id === 1) return toast("Cannot delete admin user", "error");
    if (!confirm("Are you sure? This will delete the user and all their aliases, domains, blocks, and events permanently.")) return;
    try {
      await api.adminDeleteUser(id);
      toast("User deleted", "success");
      await load();
    } catch (err: any) {
      toast(err.message || "Failed to delete user", "error");
    }
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

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 className="page-title">System Administration</h1>
        </div>
        <p className="page-subtitle">
          Manage system-wide settings, users, global domains, and AWS configuration.
        </p>
      </div>

      {stats && (
        <div className="stagger-1" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
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

      {/* AWS Onboarding Wizard */}
      <div className="card stagger-2" style={{ marginBottom: 24, borderLeft: "3px solid var(--accent-blue)" }}>
        <div className="card-header">
          <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cloud size={18} /> AWS Setup Wizard
          </span>
        </div>
        <div className="card-body">
          <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 16 }}>
            Set up the required AWS services (SES, SNS, S3) for inbound and outbound email routing.
            Choose your preferred deployment method below.
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
                Save the template below as <code>template.yaml</code> and deploy it in the AWS Console.
              </p>
              <textarea 
                className="input input-mono" 
                readOnly 
                style={{ width: "100%", height: 150, fontSize: "11px", marginBottom: 8 }}
                value={`AWSTemplateFormatVersion: '2010-09-09'
Resources:
  InboundBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "hidemyemail-inbound-\${AWS::AccountId}"
  InboundTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: hidemyemail-inbound
  OutboundTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: hidemyemail-outbound`}
              />
              <p className="text-muted">
                After deployment, copy the Bucket Name and SNS Topic ARNs to your <code>wrangler.jsonc</code> file.
              </p>
            </div>
          )}

          {awsTab === "manual" && (
            <div style={{ padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 6, fontSize: "0.85rem" }}>
              <p style={{ marginBottom: 12 }}>
                Run the following AWS CLI commands to provision the resources manually:
              </p>
              <pre style={{ overflowX: "auto", background: "#000", padding: 12, borderRadius: 4, color: "#0f0" }}>
{`# 1. Create S3 Bucket for inbound emails
aws s3api create-bucket --bucket hidemyemail-inbound-$RANDOM

# 2. Create SNS Topics
aws sns create-topic --name hidemyemail-inbound
aws sns create-topic --name hidemyemail-outbound

# 3. Save the output ARNs to your wrangler.jsonc secrets`}
              </pre>
            </div>
          )}
        </div>
      </div>

      <div className="card stagger-3" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Globe size={18} /> Global Domains
          </span>
        </div>
        <div className="card-body">
          <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 16 }}>
            Add domains that are available to all users on the platform.
          </p>
          <form onSubmit={createGlobalDomain} className="form-strip" style={{ gap: 12 }}>
            <div className="field grow">
              <label className="field-label" htmlFor="global-dom">Domain Name (e.g., example.com)</label>
              <input
                id="global-dom"
                className="input input-mono"
                type="text"
                value={domainForm}
                onChange={e => setDomainForm(e.target.value.toLowerCase())}
                required
                disabled={submittingDomain}
              />
            </div>
            <div style={{ paddingTop: 20 }}>
              <button className="btn btn-primary" type="submit" disabled={submittingDomain}>
                {submittingDomain ? "Adding..." : "Add Global Domain"}
              </button>
            </div>
          </form>
          
          {globalDomains.length > 0 && (
            <div style={{ marginTop: 24, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 16 }}>
              <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 12 }}>Active Global Domains</h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {globalDomains.map(d => (
                  <li key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 4 }}>
                    <span className="font-mono" style={{ fontSize: "0.85rem" }}>{d.domain}</span>
                    <span className="text-muted" style={{ fontSize: "0.75rem" }}>Added {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="stagger-4">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={18} /> Users
        </h2>
        <div className="table-wrap table-wrap-stack">
          <table className="dossier dossier-stack">
            <thead>
              <tr>
                <th>ID</th>
                <th>Joined</th>
                <th>Aliases</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={4} rows={3} />
            ) : (
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td data-label="ID">
                      <span className="font-mono">#{u.id} {u.id === 1 && <span className="badge badge-purple" style={{marginLeft: 8}}>Admin</span>}</span>
                    </td>
                    <td data-label="Joined">
                      <span className="text-muted">
                        {new Date(u.created_at > 1e11 ? u.created_at : u.created_at * 1000).toLocaleDateString()}
                      </span>
                    </td>
                    <td data-label="Aliases">
                      {u.alias_count}
                    </td>
                    <td>
                      {u.id !== 1 && (
                        <button className="btn-icon danger" onClick={() => removeUser(u.id)} title="Delete user">
                          <Trash2 size={16} />
                        </button>
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
    </div>
  );
}
