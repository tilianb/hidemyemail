import { useEffect, useState } from "react";
import { api, type Domain } from "../api";
import { useToast, TableSkeleton, EmptyState, ConfirmDialog, PromptDialog, ChoiceDialog } from "../ui";
import { Users, Trash2, Globe, Cloud, Edit3, Key } from "lucide-react";

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
  const [confirmState, setConfirmState] = useState<{ title: string; body: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const [promptState, setPromptState] = useState<{ title: string; body: string; defaultValue?: string; confirmLabel?: string; onConfirm: (val: string) => void } | null>(null);
  const [choiceState, setChoiceState] = useState<{ title: string; body: string; primaryLabel: string; secondaryLabel: string; onPrimary: () => void; onSecondary: () => void; } | null>(null);

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

  function requestRemoveUser(id: number) {
    if (id === 1) return toast("Cannot delete admin user", "error");
    setConfirmState({
      title: "Delete User",
      body: "Are you sure? This will delete the user and all their aliases, domains, blocks, and events permanently.",
      confirmLabel: "Delete User",
      onConfirm: async () => {
        try {
          await api.adminDeleteUser(id);
          toast("User deleted", "success");
          await load();
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

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
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
        <div className="card-header" style={{ cursor: "pointer", marginBottom: showAwsSetup ? 24 : 0, borderBottom: showAwsSetup ? "1px solid var(--border)" : "none", paddingBottom: showAwsSetup ? 16 : 0 }} onClick={() => setShowAwsSetup(!showAwsSetup)}>
          <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cloud size={18} /> AWS Setup Wizard
          </span>
          <button className="btn btn-ghost" type="button" onClick={(e) => { e.stopPropagation(); setShowAwsSetup(!showAwsSetup); }}>
            {showAwsSetup ? "Hide" : "Show"}
          </button>
        </div>
        {showAwsSetup && (
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
                style={{ width: "100%", height: 350, fontSize: "11px", marginBottom: 8 }}
                value={`AWSTemplateFormatVersion: '2010-09-09'
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
              TopicArn: !Ref InboundTopic`}
              />
              <p className="text-muted">
                After deployment, copy the Bucket Name and SNS Topic ARNs to your <code>wrangler.jsonc</code> file. Also ensure that the "hidemyemail-rules" SES rule set is marked as active in the AWS console.
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
BUCKET_NAME="hidemyemail-inbound-$RANDOM"
aws s3api create-bucket --bucket $BUCKET_NAME

# 2. Attach S3 Policy for SES to write emails
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3api put-bucket-policy --bucket $BUCKET_NAME --policy "{\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"Service\\":\\"ses.amazonaws.com\\"},\\"Action\\":\\"s3:PutObject\\",\\"Resource\\":\\"arn:aws:s3:::$BUCKET_NAME/*\\",\\"Condition\\":{\\"StringEquals\\":{\\"aws:Referer\\":\\"$ACCOUNT_ID\\"}}}]}"

# 3. Create SNS Topics
TOPIC_ARN=$(aws sns create-topic --name hidemyemail-inbound --query TopicArn --output text)
aws sns create-topic --name hidemyemail-outbound

# 4. Create SES Receipt Rule Set and Rule
aws ses create-receipt-rule-set --rule-set-name hidemyemail-rules
aws ses create-receipt-rule --rule-set-name hidemyemail-rules --rule "{\\"Name\\":\\"store-and-notify\\",\\"Enabled\\":true,\\"Actions\\":[{\\"S3Action\\":{\\"BucketName\\":\\"$BUCKET_NAME\\",\\"TopicArn\\":\\"$TOPIC_ARN\\"}}]}"
aws ses set-active-receipt-rule-set --rule-set-name hidemyemail-rules`}
              </pre>
            </div>
          )}
        </div>
        )}
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
            <button className="btn btn-primary" type="submit" disabled={submittingDomain} style={{ alignSelf: "flex-end" }}>
              {submittingDomain ? "Adding..." : "Add Global Domain"}
            </button>
          </form>
          
          {globalDomains.length > 0 && (
            <div style={{ marginTop: 24, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 16 }}>
              <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 12 }}>Active Global Domains</h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {globalDomains.map(d => (
                  <li key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 4 }}>
                    <div>
                      <span className="font-mono" style={{ fontSize: "0.85rem", display: "block" }}>{d.domain}</span>
                      <span className="text-muted" style={{ fontSize: "0.75rem" }}>Added {new Date(d.created_at > 1e11 ? d.created_at : d.created_at * 1000).toLocaleDateString()}</span>
                    </div>
                    {d.domain !== "hidemyemail.dev" && (
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
                    )}
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
                  <th style={{ width: 80 }}>User ID</th>
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
                      #{u.id} {u.id === 1 && <span className="badge badge-amber" style={{marginLeft: 8}}>Admin</span>}
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
                                  await api.adminRecoverUser(u.id, true);
                                  toast("Recovery email sent to user", "success");
                                } catch (err: any) { toast(err.message, "error"); }
                              },
                              secondaryLabel: "Copy Link",
                              onSecondary: async () => {
                                try {
                                  const { token } = await api.adminRecoverUser(u.id, false);
                                  const url = `${window.location.origin}/recover?token=${token}`;
                                  setPromptState({
                                    title: "Recovery Link",
                                    body: "Copy this secure 24-hour recovery link and send it to the user:",
                                    defaultValue: url,
                                    confirmLabel: "Done",
                                    onConfirm: () => {}
                                  });
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
    </div>
  );
}
