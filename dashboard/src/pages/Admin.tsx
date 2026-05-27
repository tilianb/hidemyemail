import { useEffect, useState } from "react";
import { api, type Domain } from "../api";
import { useToast, TableSkeleton, EmptyState, ConfirmDialog, PromptDialog, ChoiceDialog } from "../ui";
import { Users, Trash2, Globe, Cloud, Edit3, Key, Server, Settings } from "lucide-react";

const FORWARDED_FROM_FORMATS = [
  { value: "name_address_parens", label: "Name (email at domain)", example: '"Alice (alice at store.com)" <alias@domain>' },
  { value: "name_address_parens_at", label: "Name (email@domain)", example: '"Alice (alice@store.com)" <alias@domain>' },
  { value: "name_address_dash", label: "Name - email at domain", example: '"Alice - alice at store.com" <alias@domain>' },
  { value: "name_address_dash_at", label: "Name - email@domain", example: '"Alice - alice@store.com" <alias@domain>' },
  { value: "name_only", label: "Name only", example: '"Alice" <alias@domain>' },
  { value: "address_only", label: "Email at domain only", example: '"alice at store.com" <alias@domain>' },
  { value: "address_only_at", label: "Email@domain only", example: '"alice@store.com" <alias@domain>' },
  { value: "via_hidemyemail", label: "Name via HideMyEmail", example: '"Alice via HideMyEmail" <alias@domain>' },
];

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

  const [envData, setEnvData] = useState<{ vars: Record<string, { value: string; secret: false }>; secrets: Record<string, { configured: boolean; preview?: string }> } | null>(null);
  const [settingsData, setSettingsData] = useState<Record<string, { value: string; updated_at: number }> | null>(null);
  const [editedSettings, setEditedSettings] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const workerOrigin = window.location.origin;

  async function load() {
    setLoading(true);
    try {
      const [uRes, sRes, doms, envRes, setRes] = await Promise.all([
        api.adminUsers(),
        api.adminStats(),
        api.domains(),
        api.adminEnv(),
        api.adminSettings()
      ]);
      setUsers(uRes.users);
      setStats(sRes.totals);
      setGlobalDomains(doms.filter(d => d.is_global === 1));
      setEnvData(envRes);
      setSettingsData(setRes.settings);
      
      const newEdited: Record<string, string> = {};
      for (const [k, v] of Object.entries(setRes.settings)) {
        newEdited[k] = v.value;
      }
      setEditedSettings(newEdited);
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

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const changed: Record<string, string> = {};
      if (settingsData) {
        for (const [k, v] of Object.entries(editedSettings)) {
          if (settingsData[k]?.value !== v) changed[k] = v;
        }
      }
      if (Object.keys(changed).length > 0) {
        await api.adminUpdateSettings(changed);
        toast("Settings saved", "success");
        await load();
      } else {
        toast("No changes to save", "success");
      }
    } catch (err: any) {
      toast(err.message || "Failed to save settings", "error");
    } finally {
      setSavingSettings(false);
    }
  }

  const isSettingsDirty = settingsData && Object.keys(editedSettings).some(k => settingsData[k]?.value !== editedSettings[k]);

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
                After deployment, copy <code>InboundBucketName</code>, <code>SnsInboundTopicArn</code>, and <code>SnsAllowedTopicArn</code> to your Worker environment. Confirm the SNS subscriptions in AWS if they are still pending. Also ensure that the "hidemyemail-rules" SES rule set is marked as active in the AWS console.
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

      {envData && (
        <div className="card stagger-3" style={{ marginBottom: 24 }}>
          <div className="card-header" style={{ cursor: "pointer", marginBottom: showEnvVars ? 24 : 0, borderBottom: showEnvVars ? "1px solid var(--border)" : "none", paddingBottom: showEnvVars ? 16 : 0 }} onClick={() => setShowEnvVars(!showEnvVars)}>
            <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Server size={18} /> Environment Variables
            </span>
            <button className="btn btn-ghost" type="button" onClick={(e) => { e.stopPropagation(); setShowEnvVars(!showEnvVars); }}>
              {showEnvVars ? "Hide" : "Show"}
            </button>
          </div>
          {showEnvVars && (
            <div className="card-body">
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 16 }}>
                Read-only view of Cloudflare Worker environment variables and secrets. Note that secrets cannot be modified here.
              </p>
              <div className="table-wrap">
                <table className="dossier">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Value / Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(envData.vars).map(([k, v]) => (
                      <tr key={k}>
                        <td className="font-mono" style={{ fontSize: "0.85rem" }}>{k}</td>
                        <td className="font-mono" style={{ fontSize: "0.85rem" }}>{v.value}</td>
                      </tr>
                    ))}
                    {Object.entries(envData.secrets).map(([k, v]) => (
                      <tr key={k}>
                        <td className="font-mono" style={{ fontSize: "0.85rem" }}>{k}</td>
                        <td>
                          {v.configured ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span className="badge badge-green">Configured</span>
                              {v.preview && <span className="font-mono text-muted" style={{ fontSize: "0.85rem" }}>{v.preview}</span>}
                            </div>
                          ) : (
                            <span className="badge badge-amber">Not Set</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {settingsData && (
        <div className="card stagger-4" style={{ marginBottom: 24 }}>
          <div className="card-header" style={{ cursor: "pointer", marginBottom: showSettings ? 24 : 0, borderBottom: showSettings ? "1px solid var(--border)" : "none", paddingBottom: showSettings ? 16 : 0 }} onClick={() => setShowSettings(!showSettings)}>
            <span className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Settings size={18} /> Runtime Settings
            </span>
            <button className="btn btn-ghost" type="button" onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}>
              {showSettings ? "Hide" : "Show"}
            </button>
          </div>
          {showSettings && (
          <div className="card-body">
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>
              These settings are stored in the database and can be modified at runtime without redeploying the worker.
            </p>
            
            <div className="settings-grid" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-rate-alias" className="setting-label">Per-Alias Rate Limit (emails/hr)</label>
                  <div className="setting-desc">Max forwards per alias per hour</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-rate-alias"
                    className="input"
                    type="number"
                    min="1"
                    value={editedSettings.rate_limit_per_alias || ""}
                    onChange={e => setEditedSettings({...editedSettings, rate_limit_per_alias: e.target.value})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-rate-global" className="setting-label">Global Rate Limit (emails/hr)</label>
                  <div className="setting-desc">Max total forwards per hour across all aliases</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-rate-global"
                    className="input"
                    type="number"
                    min="1"
                    value={editedSettings.rate_limit_global || ""}
                    onChange={e => setEditedSettings({...editedSettings, rate_limit_global: e.target.value})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-max-bytes" className="setting-label">Max Inbound Email Size</label>
                  <div className="setting-desc">Maximum email size accepted (in MB)</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-max-bytes"
                    className="input"
                    type="number"
                    min="1"
                    value={editedSettings.max_inbound_bytes ? (parseInt(editedSettings.max_inbound_bytes, 10) / 1024 / 1024).toString() : ""}
                    onChange={e => {
                      const mb = parseInt(e.target.value, 10);
                      if (!isNaN(mb)) {
                        setEditedSettings({...editedSettings, max_inbound_bytes: (mb * 1024 * 1024).toString()});
                      }
                    }}
                    style={{ width: 100 }}
                  />
                  <span className="text-muted font-mono" style={{ marginLeft: 8 }}>MB</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">Catch-All Auto-Create</div>
                  <div className="setting-desc">Automatically create aliases when receiving emails to unknown addresses</div>
                </div>
                <div className="setting-control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={editedSettings.catch_all_auto_create === "true"}
                      onChange={e => setEditedSettings({...editedSettings, catch_all_auto_create: e.target.checked ? "true" : "false"})}
                    />
                    <span className="switch-track"></span>
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">User Registration</div>
                  <div className="setting-desc">Allow new users to register accounts</div>
                </div>
                <div className="setting-control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={editedSettings.registration_enabled === "true"}
                      onChange={e => setEditedSettings({...editedSettings, registration_enabled: e.target.checked ? "true" : "false"})}
                    />
                    <span className="switch-track"></span>
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-cors" className="setting-label">CORS Allowed Origins</label>
                  <div className="setting-desc">Comma-separated exact origins allowed to access the API</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-cors"
                    className="input input-mono"
                    type="text"
                    value={editedSettings.cors_allowed_domains || ""}
                    onChange={e => setEditedSettings({...editedSettings, cors_allowed_domains: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-forwarded-from-format" className="setting-label">Forwarded Sender Display</label>
                  <div className="setting-desc">
                    How forwarded emails appear in your inbox. Default avoids raw @ signs for deliverability.
                  </div>
                  <div className="setting-desc input-mono" style={{ marginTop: 6 }}>
                    {FORWARDED_FROM_FORMATS.find(f => f.value === editedSettings.forwarded_from_format)?.example || FORWARDED_FROM_FORMATS[0].example}
                  </div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <select
                    id="setting-forwarded-from-format"
                    className="input"
                    value={editedSettings.forwarded_from_format || "name_address_parens"}
                    onChange={e => setEditedSettings({...editedSettings, forwarded_from_format: e.target.value})}
                    style={{ width: "100%" }}
                  >
                    {FORWARDED_FROM_FORMATS.map(format => (
                      <option key={format.value} value={format.value}>{format.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* AWS Config Overrides */}
              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-ses-region" className="setting-label">SES Region (Override)</label>
                  <div className="setting-desc">e.g. us-east-1</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-ses-region"
                    className="input input-mono"
                    type="text"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.ses_region || ""}
                    onChange={e => setEditedSettings({...editedSettings, ses_region: e.target.value})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-ses-key" className="setting-label">SES Access Key ID (Override)</label>
                  <div className="setting-desc">AWS access key with SES permissions</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-ses-key"
                    className="input input-mono"
                    type="text"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.ses_access_key_id || ""}
                    onChange={e => setEditedSettings({...editedSettings, ses_access_key_id: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-ses-secret" className="setting-label">SES Secret Access Key (Override)</label>
                  <div className="setting-desc">AWS secret key with SES permissions</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-ses-secret"
                    className="input input-mono"
                    type="password"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.ses_secret_access_key || ""}
                    onChange={e => setEditedSettings({...editedSettings, ses_secret_access_key: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-s3-bucket" className="setting-label">S3 Inbound Bucket (Override)</label>
                  <div className="setting-desc">Bucket name where SES stores inbound emails</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-s3-bucket"
                    className="input input-mono"
                    type="text"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.s3_inbound_bucket || ""}
                    onChange={e => setEditedSettings({...editedSettings, s3_inbound_bucket: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-sns-topic" className="setting-label">SNS Inbound Topic ARN (Override)</label>
                  <div className="setting-desc">Exact ARN of the SNS topic receiving SES inbound notifications</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-sns-topic"
                    className="input input-mono"
                    type="text"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.sns_inbound_topic_arn || ""}
                    onChange={e => setEditedSettings({...editedSettings, sns_inbound_topic_arn: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-sns-outbound-topic" className="setting-label">SNS Outbound Topic ARN (Override)</label>
                  <div className="setting-desc">Exact ARN of the SNS topic sending SES bounce/complaint notifications</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <input
                    id="setting-sns-outbound-topic"
                    className="input input-mono"
                    type="text"
                    placeholder="Fallback to ENV if empty"
                    value={editedSettings.sns_allowed_topic_arn || ""}
                    onChange={e => setEditedSettings({...editedSettings, sns_allowed_topic_arn: e.target.value})}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

            </div>
            
            <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
              <button 
                className="btn btn-ghost"
                onClick={() => {
                  setEditedSettings({
                    rate_limit_per_alias: "200",
                    rate_limit_global: "1000",
                    max_inbound_bytes: "26214400",
                    catch_all_auto_create: "true",
                    registration_enabled: "true",
                    cors_allowed_domains: "https://hidemyemail.dev,http://localhost:5173",
                    forwarded_from_format: "name_address_parens"
                  });
                }}
                type="button"
              >
                Reset to Defaults
              </button>
              <button 
                className="btn btn-primary"
                onClick={saveSettings}
                disabled={!isSettingsDirty || savingSettings}
              >
                {savingSettings ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
          )}
        </div>
      )}

      <div className="card stagger-5" style={{ marginBottom: 24 }}>
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

      <div className="stagger-6">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={18} /> Users
        </h2>
        <div className="table-wrap table-wrap-stack">
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
