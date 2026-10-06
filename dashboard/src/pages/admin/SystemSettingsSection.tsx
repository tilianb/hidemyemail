import { useEffect, useState } from "react";
import { Send, Settings } from "lucide-react";
import { api, type Domain, type MailRuntimeDto } from "../../api";
import { FreshAuthDialog, useFreshAuth } from "../../security/FreshAuth";
import { useToast } from "../../ui";

export type SettingsData = Record<string, { value: string; updated_at: number; source?: "override" | "environment" | "default" }>;

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
const TEST_EMAIL_TYPES = [
  { value: "recovery", label: "Recovery link" }, { value: "mfa", label: "MFA code" },
  { value: "notification", label: "System notification" }, { value: "demo_forward", label: "Demo forward (with toolbar)" },
  { value: "demo_oq", label: "Demo forward (over-quota)" },
];
function sanitizeSignedInteger(value: string) { return value.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, ""); }
function valuesOf(settings: SettingsData) { return Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value])); }

export function SystemSettingsSection({ initialSettings, globalDomains, onSaved }: { initialSettings: SettingsData; globalDomains: Domain[]; onSaved: (settings: SettingsData) => void }) {
  const { toast } = useToast();
  const [settingsData, setSettingsData] = useState(initialSettings);
  const [editedSettings, setEditedSettings] = useState<Record<string, string>>(() => valuesOf(initialSettings));
  const [savingSettings, setSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [runtime, setRuntime] = useState<MailRuntimeDto | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [runtimeRefresh, setRuntimeRefresh] = useState(0);
  const [inboundBytesInput, setInboundBytesInput] = useState(() => initialSettings.max_inbound_bytes?.value ? (parseInt(initialSettings.max_inbound_bytes.value, 10) / 1024 / 1024).toString() : "");
  const [listenerMbInput, setListenerMbInput] = useState(() => initialSettings.smtp_inbound_max_bytes?.value ? (Number(initialSettings.smtp_inbound_max_bytes.value) / 1024 / 1024).toString() : "");
  const [testEmailForm, setTestEmailForm] = useState({ type: "notification", to: "" });
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const freshAuth = useFreshAuth({ onError: message => toast(message, "error") });
  const freshGuard = freshAuth.guard;
  const currentMainGlobalDomain = editedSettings.main_global_domain || "";
  const selectableMainGlobalDomains = globalDomains.filter(domain => domain.active === 1 && domain.verified_at !== null);
  const isSettingsDirty = Object.keys(editedSettings).some(key => settingsData[key]?.value !== editedSettings[key]);
  const receiving = editedSettings.mail_inbound_provider || (editedSettings.smtp_inbound_enabled === "true" ? "gateway" : "ses");

  useEffect(() => {
    if (!showSettings) return;
    let cancelled = false;
    setRuntimeError(false);
    setRuntime(null);
    api.adminMailRuntime().then(value => { if (!cancelled) setRuntime(value); }).catch(() => { if (!cancelled) setRuntimeError(true); });
    return () => { cancelled = true; };
  }, [showSettings, runtimeRefresh]);

  useEffect(() => {
    if (!isSettingsDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isSettingsDirty]);

  function discardChanges() {
    setEditedSettings(valuesOf(settingsData));
    setInboundBytesInput(settingsData.max_inbound_bytes?.value ? (parseInt(settingsData.max_inbound_bytes.value, 10) / 1024 / 1024).toString() : "");
    setListenerMbInput(settingsData.smtp_inbound_max_bytes?.value ? (Number(settingsData.smtp_inbound_max_bytes.value) / 1024 / 1024).toString() : "");
  }

  async function reload() {
    const response = await api.adminSettings();
    setSettingsData(response.settings);
    setEditedSettings(valuesOf(response.settings));
    setInboundBytesInput(response.settings.max_inbound_bytes?.value ? (parseInt(response.settings.max_inbound_bytes.value, 10) / 1024 / 1024).toString() : "");
    setListenerMbInput(response.settings.smtp_inbound_max_bytes?.value ? (Number(response.settings.smtp_inbound_max_bytes.value) / 1024 / 1024).toString() : "");
    onSaved(response.settings);
  }
  async function saveSettings() {
    setSavingSettings(true);
    try {
      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(editedSettings)) if (settingsData[key]?.value !== value) changed[key] = value;
      if (!Object.keys(changed).length) { toast("No changes to save", "success"); return; }
      const result = await freshGuard(() => api.adminUpdateSettings(changed), saveSettings);
      if (!result.ok) return;
      toast("Settings saved", "success");
      if (result.value.restart_required) toast("Restart Docker to activate SMTP listener changes", "success");
      await reload();
    } catch (err: any) { toast(err.message || "Failed to save settings", "error"); }
    finally { setSavingSettings(false); }
  }
  async function resetMailSettings(keys: string[]) {
    if (isSettingsDirty || savingSettings) {
      toast("Save or discard your changes before restoring environment settings", "error");
      return;
    }
    setSavingSettings(true);
    try {
      const reset = Object.fromEntries(keys.map(key => [key, null]));
      const result = await freshGuard(() => api.adminUpdateSettings(reset), () => resetMailSettings(keys));
      if (!result.ok) return;
      toast("Environment/default mail settings restored. Restart Docker to activate them.", "success");
      await reload();
    } catch (err: any) { toast(err.message || "Failed to reset mail settings", "error"); }
    finally { setSavingSettings(false); }
  }
  async function sendTestEmail(event: React.FormEvent) {
    event.preventDefault(); setSendingTestEmail(true);
    try { const response = await api.adminSendTestEmail(testEmailForm); toast(`Test email sent to ${response.to}`, "success"); }
    catch (err: any) { toast(err.message || "Failed to send test email", "error"); }
    finally { setSendingTestEmail(false); }
  }

  return <>

        <div className={`card admin-panel-card admin-settings-card stagger-5 ${showSettings ? "is-open" : ""}`}>
          <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setShowSettings(!showSettings)}>
            <div>
              <span className="card-title admin-section-title">
                <Settings size={18} /> System Settings
              </span>
              <p className="admin-section-subtitle">Runtime policy, rate limits, registration, and relay behavior.</p>
            </div>
            <button className="admin-panel-toggle" type="button" aria-expanded={showSettings} aria-controls="admin-settings-body" onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}>
              {showSettings ? "Hide" : "Show"}
            </button>
          </div>
          {showSettings && (
          <div className="card-body" id="admin-settings-body">
            <p className="admin-settings-intro">
              Set instance-wide defaults here. Save changes before testing mail. SMTP listener and transport changes require a Docker restart.
            </p>
            <nav className="admin-jump-nav" aria-label="Settings sections">
              {[["mail", "Mail transport"], ["limits", "Limits"], ["defaults", "Account defaults"], ["privacy", "Filtering & privacy"], ["diagnostics", "Test mail & AWS"]].map(([id, label]) =>
                <button key={id} type="button" className="btn btn-outline btn-sm" onClick={() => { const heading = document.getElementById(`admin-setting-${id}`); heading?.scrollIntoView({ block: "start" }); heading?.focus({ preventScroll: true }); }}>{label}</button>
              )}
            </nav>

            <div className="settings-grid" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <h2 className="admin-settings-heading" id="admin-setting-mail" tabIndex={-1}>Mail transport</h2>
              <div className="setting-row" style={{ alignItems: "flex-start" }}>
                <div className="setting-info"><div className="setting-label">Running mail status</div><div className="setting-desc">Live Docker state, not the draft settings below. Restart Docker after saving transport changes.</div></div>
                <div className="setting-control mail-settings-control">
                  {runtimeError ? <div role="alert">Mail runtime status unavailable. Queue counts are unknown. <button type="button" className="btn btn-outline btn-sm" onClick={() => setRuntimeRefresh(value => value + 1)}>Retry runtime status</button></div> : !runtime ? <p>Loading mail runtime…</p> : !runtime.available ? <p>Docker mail runtime unavailable. Built-in receiving and direct sending are Docker-only. Existing settings are unchanged.</p> : <>
                    <p>Running: receiving {runtime.receiving}; sending {runtime.outbound}; hostname {runtime.hostname || "not set"}.</p>
                    <p>Inbound queued: {runtime.queue.inbound}; outbound queued: {runtime.queue.outbound}; failed: {runtime.queue.failed}.</p>
                    <p>Oldest pending: {runtime.queue.oldestPendingAt === null ? "none" : new Date(runtime.queue.oldestPendingAt).toLocaleString()}.</p>
                    <p>Spam scanner: {runtime.scanners.spam ? "ready" : "not ready"}; virus scanner: {runtime.scanners.virus ? "ready" : "not ready"}.</p>
                    {runtime.outbound === "direct" && <div><div className="setting-label">DKIM DNS records (TXT)</div>{runtime.dkim.length === 0 ? <p>No DKIM records ready. Verify domains and check Docker.</p> : runtime.dkim.map(record => <div key={record.name} className="mail-field"><span>{record.domain}</span><input className="input input-mono" aria-label={`DKIM name for ${record.domain}`} readOnly value={record.name} /><textarea className="input input-mono" aria-label={`DKIM value for ${record.domain}`} readOnly value={record.value} /><button type="button" className="btn btn-outline btn-sm" onClick={() => { void navigator.clipboard.writeText(`${record.name} TXT ${record.value}`).then(() => toast("DKIM record copied", "success")).catch(() => toast("Could not copy; select the DNS fields instead", "error")); }}>Copy DKIM record</button></div>)}</div>}
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setRuntimeRefresh(value => value + 1)}>Refresh runtime status</button>
                  </>}
                </div>
              </div>
              <div className="setting-row"><div className="setting-info"><label htmlFor="setting-mail-hostname" className="setting-label">Mail server hostname</label><div className="setting-desc">Canonical DNS hostname required for built-in receiving or direct sending. Point its A/AAAA records at your server.</div></div><div className="setting-control"><input id="setting-mail-hostname" className="input input-mono" placeholder="mail.example.com" value={editedSettings.mail_hostname || ""} onChange={e => setEditedSettings({...editedSettings, mail_hostname: e.target.value.toLowerCase()})} /></div></div>
              <div className="setting-row" style={{ alignItems: "flex-start" }}>
                <div className="setting-info">
                  <label htmlFor="setting-mail-provider" className="setting-label">Outbound mail transport</label>
                  <div className="setting-desc">SES remains the default. Provider SMTP on port 587 or 465 is recommended when your host blocks outbound port 25. Custom SMTP and direct delivery run only in Docker.</div>
                </div>
                <div className="setting-control mail-settings-control">
                  <select id="setting-mail-provider" className="input" value={editedSettings.mail_outbound_provider || "ses"} onChange={e => setEditedSettings({...editedSettings, mail_outbound_provider: e.target.value})}>
                    <option value="ses">AWS SES</option><option value="smtp">Custom SMTP</option><option value="direct" disabled={!runtime?.available}>Direct SMTP (Docker)</option>
                  </select>
                  <div className="setting-desc">Source: {settingsData.mail_outbound_provider?.source ?? "default"}. Saved SMTP changes become active after Docker restarts.</div>
                  {editedSettings.mail_outbound_provider === "direct" && <p className="setting-desc">Direct delivery needs outbound port 25, matching PTR (reverse DNS), SPF authorizing your server IP, and published DKIM records. It is optional; provider SMTP avoids outbound-25 restrictions. Opening inbound port 25 alone does not enable direct sending.</p>}
                  {editedSettings.mail_outbound_provider === "smtp" && <>
                    <label className="mail-field"><span className="setting-label">SMTP host</span><input className="input input-mono" aria-label="SMTP outbound host" placeholder="smtp.example.com" value={editedSettings.smtp_outbound_host || ""} onChange={e => setEditedSettings({...editedSettings, smtp_outbound_host: e.target.value})} /></label>
                    <div className="mail-connection-row">
                      <label className="mail-field"><span className="setting-label">Port</span><input className="input" aria-label="SMTP outbound port" inputMode="numeric" placeholder="587" value={editedSettings.smtp_outbound_port || ""} onChange={e => setEditedSettings({...editedSettings, smtp_outbound_port: e.target.value.replace(/\D/g, "")})} /></label>
                      <label className="mail-field"><span className="setting-label">Connection security</span><select className="input" aria-label="SMTP outbound TLS mode" value={editedSettings.smtp_outbound_tls || "starttls"} onChange={e => setEditedSettings({...editedSettings, smtp_outbound_tls: e.target.value})}>
                        <option value="starttls">Required STARTTLS</option><option value="implicit">Implicit TLS</option><option value="trusted-cleartext">Trusted port-25 relay</option>
                      </select></label>
                    </div>
                    <label className="mail-field"><span className="setting-label">Username (write-only)</span><input className="input input-mono" aria-label="SMTP outbound username" autoComplete="off" value={editedSettings.smtp_outbound_username || ""} onChange={e => setEditedSettings({...editedSettings, smtp_outbound_username: e.target.value})} /></label>
                    <label className="mail-field"><span className="setting-label">Password</span><input className="input" aria-label="SMTP outbound password" type="password" autoComplete="new-password" value={editedSettings.smtp_outbound_password || ""} onChange={e => setEditedSettings({...editedSettings, smtp_outbound_password: e.target.value})} /><span className="setting-desc">Leave unchanged to preserve the saved password.</span></label>
                    <div className="mail-settings-actions"><button type="button" className="btn btn-outline btn-sm" onClick={() => setEditedSettings({...editedSettings, smtp_outbound_username: "", smtp_outbound_password: ""})}>Remove credentials</button><button type="button" className="btn btn-outline btn-sm" onClick={() => resetMailSettings(["mail_outbound_provider", "smtp_outbound_host", "smtp_outbound_port", "smtp_outbound_tls", "smtp_outbound_username", "smtp_outbound_password"])}>Use environment</button></div>
                    <div className="setting-desc">Verified certificates stay mandatory. Disable provider click/open tracking in the supplier dashboard for privacy.</div>
                  </>}
                </div>
              </div>

              <div className="setting-row" style={{ alignItems: "flex-start" }}>
                <div className="setting-info">
                  <label htmlFor="setting-mail-receiving" className="setting-label">Receiving mail</label>
                  <div className="setting-desc">SES remains the default. Docker can receive mail itself or accept it from a trusted scanning gateway. Receiving and sending are separate choices; neither fetches IMAP/POP mail.</div>
                </div>
                <div className="setting-control mail-settings-control">
                  <select id="setting-mail-receiving" className="input" value={receiving} onChange={e => setEditedSettings({...editedSettings, mail_inbound_provider: e.target.value})}><option value="ses">AWS SES</option><option value="builtin" disabled={!runtime?.available}>Built-in SMTP (Docker)</option><option value="gateway">External gateway</option></select>
                  <div className="setting-desc">Source: {settingsData.mail_inbound_provider?.source ?? settingsData.smtp_inbound_enabled?.source ?? "default"}. Configured state may differ from the active listener until restart.</div>
                  {receiving === "builtin" && <p className="setting-desc">Publish inbound port 25 in Docker and open it in your firewall. Point alias-domain MX records at your mail server hostname. No external gateway is needed: spam and virus scans use bundled Compose services. Save and restart Docker. Inbound port 25 receives mail; outbound port 25 is only needed for direct sending.</p>}
                  {receiving === "gateway" && <details><summary>Advanced gateway listener settings</summary><p className="setting-desc">Your external gateway must queue mail, check sender authentication, and supply trusted spam and virus scan results. Save and restart Docker.</p>
                    <label className="mail-field"><span className="setting-label">Bind address</span><input className="input input-mono" aria-label="SMTP inbound bind address" placeholder="127.0.0.1" value={editedSettings.smtp_inbound_host || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_host: e.target.value})} /></label>
                    <div className="mail-connection-row">
                      <label className="mail-field"><span className="setting-label">Port</span><input className="input" aria-label="SMTP inbound port" inputMode="numeric" placeholder="2525" value={editedSettings.smtp_inbound_port || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_port: e.target.value.replace(/\D/g, "")})} /></label>
                      <label className="mail-field"><span className="setting-label">Connection security</span><select className="input" aria-label="SMTP inbound TLS mode" value={editedSettings.smtp_inbound_tls || "starttls"} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_tls: e.target.value})}><option value="starttls">Required STARTTLS</option><option value="implicit">Implicit TLS</option></select></label>
                    </div>
                    <label className="mail-field"><span className="setting-label">Gateway ID</span><input className="input input-mono" aria-label="SMTP inbound gateway ID" placeholder="stalwart-1" value={editedSettings.smtp_inbound_gateway_id || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_gateway_id: e.target.value})} /></label>
                    <label className="mail-field"><span className="setting-label">Trusted peer IPs</span><input className="input input-mono" aria-label="SMTP inbound trusted peers" placeholder="127.0.0.1, ::1" value={editedSettings.smtp_inbound_trusted_peers || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_trusted_peers: e.target.value})} /><span className="setting-desc">Exact IP addresses, separated by commas. Empty allows any peer with valid listener credentials.</span></label>
                    <label className="mail-field"><span className="setting-label">Listener size limit (MB)</span><input className="input input-mono" aria-label="SMTP inbound size limit (MB)" inputMode="decimal" placeholder="25" value={listenerMbInput} onChange={e => {
                      const value = e.target.value;
                      if (!/^\d*(\.\d*)?$/.test(value)) return;
                      setListenerMbInput(value);
                      setEditedSettings({...editedSettings, smtp_inbound_max_bytes: value === "" ? "" : Math.round(Number(value) * 1024 * 1024).toString()});
                    }} /><span className="setting-desc">Empty uses 25 MB. 1 MB = 1,048,576 bytes (MiB). The instance-wide inbound size limit below also applies.</span></label>
                    <label className="mail-field"><span className="setting-label">Listener username (write-only)</span><input className="input input-mono" aria-label="SMTP inbound username" autoComplete="off" value={editedSettings.smtp_inbound_username || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_username: e.target.value})} /></label>
                    <label className="mail-field"><span className="setting-label">Listener password</span><input className="input" aria-label="SMTP inbound password" type="password" autoComplete="new-password" value={editedSettings.smtp_inbound_password || ""} onChange={e => setEditedSettings({...editedSettings, smtp_inbound_password: e.target.value})} /><span className="setting-desc">Leave unchanged to preserve the saved password.</span></label>
                    <div className="mail-settings-actions"><button type="button" className="btn btn-outline btn-sm" onClick={() => setEditedSettings({...editedSettings, smtp_inbound_username: "", smtp_inbound_password: ""})}>Remove credentials</button><button type="button" className="btn btn-outline btn-sm" onClick={() => resetMailSettings(["smtp_inbound_enabled", "smtp_inbound_host", "smtp_inbound_port", "smtp_inbound_tls", "smtp_inbound_username", "smtp_inbound_password", "smtp_inbound_gateway_id", "smtp_inbound_trusted_peers", "smtp_inbound_max_bytes"])}>Use environment</button></div>
                    <div className="setting-desc">Certificate and key paths remain deployment-managed environment values. Non-loopback listeners refuse startup without them.</div>
                  </details>}
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">Mail DNS targets</div>
                  <div className="setting-desc">The Domains panel turns these choices into copy-ready MX and SPF records.</div>
                </div>
                <div className="setting-control mail-settings-control">
                  {receiving === "builtin" ? <p className="setting-desc">Inbound MX uses the mail server hostname above: <strong>{editedSettings.mail_hostname || "enter a hostname first"}</strong>.</p> : <label className="mail-field"><span className="setting-label">Inbound MX hostname</span><input className="input input-mono" aria-label="Inbound MX hostname" placeholder="mx.example.com" value={editedSettings.inbound_mx_host || ""} onChange={e => setEditedSettings({...editedSettings, inbound_mx_host: e.target.value.toLowerCase()})} /><span className="setting-desc">Empty uses the regional SES inbound hostname. Gateway mode should use the public gateway hostname.</span></label>}
                  {editedSettings.mail_outbound_provider === "direct" ? <p className="setting-desc">Direct sending authorizes the mail server hostname with SPF <code>a:{editedSettings.mail_hostname || "mail.example.com"}</code>. DKIM records appear in running mail status after restart.</p> : <label className="mail-field"><span className="setting-label">Outbound SPF include hostname</span><input className="input input-mono" aria-label="Outbound SPF include hostname" placeholder="amazonses.com" value={editedSettings.outbound_spf_include || ""} onChange={e => setEditedSettings({...editedSettings, outbound_spf_include: e.target.value.toLowerCase()})} /><span className="setting-desc">Empty uses <code>amazonses.com</code>. For provider SMTP, enter the supplier's SPF include hostname.</span></label>}
                  <button type="button" className="btn btn-outline btn-sm" disabled={isSettingsDirty || savingSettings} onClick={() => resetMailSettings(["inbound_mx_host", "outbound_spf_include"])}>Use environment</button>
                </div>
              </div>

              <h2 className="admin-settings-heading" id="admin-setting-limits" tabIndex={-1}>Limits & quotas</h2>
              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-rate-global" className="setting-label">Global Rate Limit (emails/hr)</label>
                  <div className="setting-desc">Max total forwards per hour across all aliases</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-rate-global"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.rate_limit_global ?? ""}
                    onChange={e => setEditedSettings({...editedSettings, rate_limit_global: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-rate-alias" className="setting-label">Per-Alias Rate Limit (emails/hr)</label>
                  <div className="setting-desc">Max forwards per alias per hour</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-rate-alias"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.rate_limit_per_alias ?? ""}
                    onChange={e => setEditedSettings({...editedSettings, rate_limit_per_alias: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-rate-reply" className="setting-label">Per-Alias Reply Rate Limit (emails/hr)</label>
                  <div className="setting-desc">Max replies per alias per hour (outbound; protects sender reputation). -1 to disable</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-rate-reply"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.rate_limit_reply_per_alias ?? ""}
                    onChange={e => setEditedSettings({...editedSettings, rate_limit_reply_per_alias: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-distinct-recipient-cap" className="setting-label">Per-Alias Distinct Reply Recipient Cap (per 24h)</label>
                  <div className="setting-desc">Max unique external recipients an alias may reply to in 24h. Tripping the cap auto-mutes the alias for 24h. -1 to disable</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-distinct-recipient-cap"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.reply_distinct_recipient_cap ?? ""}
                    onChange={e => setEditedSettings({...editedSettings, reply_distinct_recipient_cap: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-max-total-aliases" className="setting-label">Max Total Aliases</label>
                  <div className="setting-desc">Maximum number of aliases a user can have (-1 for unlimited)</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-max-total-aliases"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.max_total_aliases ?? "-1"}
                    onChange={e => setEditedSettings({...editedSettings, max_total_aliases: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">Alias Quota Buffer</div>
                  <div className="setting-desc">Allow one catch-all auto-created alias above the max total alias limit before dropping new unknown addresses</div>
                </div>
                <div className="setting-control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label="Alias Quota Buffer"
                      checked={editedSettings.alias_quota_buffer_enabled === "true"}
                      onChange={e => setEditedSettings({...editedSettings, alias_quota_buffer_enabled: e.target.checked ? "true" : "false"})}
                    />
                    <span className="switch-track"></span>
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-max-subdomains" className="setting-label">Max Subdomains</label>
                  <div className="setting-desc">Maximum number of custom subdomains a user can create (-1 for unlimited)</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-max-subdomains"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.max_subdomains ?? "-1"}
                    onChange={e => setEditedSettings({...editedSettings, max_subdomains: sanitizeSignedInteger(e.target.value)})}
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-soft-bounce-threshold" className="setting-label">Soft Bounce Threshold</label>
                  <div className="setting-desc">Number of transient (soft) bounces per 24h before suppressing a destination. Set to 1 to suppress on first soft bounce.</div>
                </div>
                <div className="setting-control">
                  <input
                    id="setting-soft-bounce-threshold"
                    className="input"
                    type="text"
                    inputMode="numeric"
                    value={editedSettings.soft_bounce_threshold ?? "3"}
                    onChange={e => setEditedSettings({...editedSettings, soft_bounce_threshold: e.target.value.replace(/[^0-9]/g, "")})}
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
                    type="text"
                    inputMode="numeric"
                    value={inboundBytesInput}
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9]/g, "");
                      setInboundBytesInput(val);
                      if (val === "") {
                        setEditedSettings({...editedSettings, max_inbound_bytes: ""});
                      } else {
                        const mb = parseInt(val, 10);
                        if (!isNaN(mb)) {
                          setEditedSettings({...editedSettings, max_inbound_bytes: (mb * 1024 * 1024).toString()});
                        }
                      }
                    }}
                    style={{ width: 100 }}
                  />
                  <span className="text-muted font-mono" style={{ marginLeft: 8 }}>MB</span>
                </div>
              </div>

              <h2 className="admin-settings-heading" id="admin-setting-defaults" tabIndex={-1}>Alias & account defaults</h2>
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">Catch-All Auto-Create</div>
                  <div className="setting-desc">Automatically create aliases when receiving emails to unknown addresses</div>
                </div>
                <div className="setting-control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label="Catch-All Auto-Create"
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
                      aria-label="User Registration"
                      checked={editedSettings.registration_enabled === "true"}
                      onChange={e => setEditedSettings({...editedSettings, registration_enabled: e.target.checked ? "true" : "false"})}
                    />
                    <span className="switch-track"></span>
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-inline-actions" className="setting-label">Inline Action Links — Default</label>
                  <div className="setting-desc">
                    Default for new users. Each user can override in their Settings page.
                    Choose where the Block / Mute&nbsp;7d / Disable alias bar appears in forwarded emails, or disable it entirely.
                    {" "}
                    <strong>Recommended: Disabled</strong> while sending domains are new — the three inline <code>mailto:</code> buttons pattern-match marketing footers and push forwards to Junk at Microsoft / Outlook.
                  </div>
                </div>
                <div className="setting-control" style={{ minWidth: 160 }}>
                  <select
                    id="setting-inline-actions"
                    className="input"
                    value={
                      editedSettings.inline_actions_default_enabled === "true"
                        ? ((editedSettings.inline_actions_default_position || "footer"))
                        : "disable"
                    }
                    onChange={e => {
                      const v = e.target.value;
                      if (v === "disable") {
                        setEditedSettings({ ...editedSettings, inline_actions_default_enabled: "false" });
                      } else {
                        setEditedSettings({
                          ...editedSettings,
                          inline_actions_default_enabled: "true",
                          inline_actions_default_position: v,
                        });
                      }
                    }}
                  >
                    <option value="disable">Disabled</option>
                    <option value="header">Header</option>
                    <option value="footer">Footer</option>
                  </select>
                </div>
              </div>

              <h2 className="admin-settings-heading" id="admin-setting-privacy" tabIndex={-1}>Filtering & privacy</h2>
              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-spam-verdict" className="setting-label">Spam Verdict Action</label>
                  <div className="setting-desc">
                    What to do when SES marks an inbound message as spam. Forwarded mail is DKIM-signed
                    by your domain, so forwarding spam burns your own sender reputation.
                    {" "}<strong>Flag</strong> adds <code>X-Spam-Flag: YES</code> so the destination inbox can filter it.
                  </div>
                </div>
                <div className="setting-control" style={{ minWidth: 160 }}>
                  <select
                    id="setting-spam-verdict"
                    className="input"
                    value={editedSettings.spam_verdict_action || "flag"}
                    onChange={e => setEditedSettings({...editedSettings, spam_verdict_action: e.target.value})}
                  >
                    <option value="flag">Flag (recommended)</option>
                    <option value="drop">Drop</option>
                    <option value="forward">Forward untouched</option>
                  </select>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-virus-verdict" className="setting-label">Virus Verdict Action</label>
                  <div className="setting-desc">What to do when SES detects malware in an inbound message.</div>
                </div>
                <div className="setting-control" style={{ minWidth: 160 }}>
                  <select
                    id="setting-virus-verdict"
                    className="input"
                    value={editedSettings.virus_verdict_action || "drop"}
                    onChange={e => setEditedSettings({...editedSettings, virus_verdict_action: e.target.value})}
                  >
                    <option value="drop">Drop (recommended)</option>
                    <option value="flag">Flag</option>
                    <option value="forward">Forward untouched</option>
                  </select>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-unsub-mode" className="setting-label">List-Unsubscribe Header</label>
                  <div className="setting-desc">
                    When to add the one-click unsubscribe header (disables the alias) to forwards.
                    Adding it to personal mail makes forwards look like bulk mail to spam filters;
                    {" "}the recommended <strong>Bulk mail only</strong> option adds it only when the original message already carried one.
                  </div>
                </div>
                <div className="setting-control" style={{ minWidth: 160 }}>
                  <select
                    id="setting-unsub-mode"
                    className="input"
                    value={editedSettings.unsubscribe_header_mode || "bulk_only"}
                    onChange={e => setEditedSettings({...editedSettings, unsubscribe_header_mode: e.target.value})}
                  >
                    <option value="bulk_only">Bulk mail only</option>
                    <option value="always">Every forward</option>
                    <option value="never">Never</option>
                  </select>
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

              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="setting-main-global-domain" className="setting-label">Main Global Domain</label>
                  <div className="setting-desc">The primary domain used for system emails and the default frontend display</div>
                </div>
                <div className="setting-control" style={{ flexGrow: 1, maxWidth: 400 }}>
                  <select
                    id="setting-main-global-domain"
                    className="input input-mono"
                    value={currentMainGlobalDomain}
                    onChange={e => setEditedSettings({...editedSettings, main_global_domain: e.target.value})}
                    style={{ width: "100%" }}
                  >
                    {!selectableMainGlobalDomains.find(d => d.domain === currentMainGlobalDomain) && currentMainGlobalDomain && (
                      <option value={currentMainGlobalDomain}>{currentMainGlobalDomain}</option>
                    )}
                    {selectableMainGlobalDomains.map(d => (
                      <option key={d.id} value={d.domain}>{d.domain}</option>
                    ))}
                  </select>
                </div>
              </div>

              <h2 className="admin-settings-heading" id="admin-setting-diagnostics" tabIndex={-1}>Test mail & AWS configuration</h2>
              <div className="setting-row">
                <div className="setting-info">
                  <label htmlFor="test-email-to" className="setting-label">Send Test Email</label>
                  <div className="setting-desc">Send using the saved transport. After SMTP changes, restart Docker first. Acceptance does not guarantee inbox delivery.</div>
                  {isSettingsDirty && <p className="setting-desc">Save or discard your changes before sending a test.</p>}
                </div>
                <form className="setting-control test-email-control" onSubmit={sendTestEmail}>
                  <select
                    className="input"
                    value={testEmailForm.type}
                    onChange={e => setTestEmailForm(f => ({ ...f, type: e.target.value }))}
                    aria-label="Test email type"
                  >
                    {TEST_EMAIL_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                  <input
                    id="test-email-to"
                    className="input input-mono"
                    type="email"
                    placeholder="operator@example.com"
                    value={testEmailForm.to}
                    onChange={e => setTestEmailForm(f => ({ ...f, to: e.target.value }))}
                    required
                  />
                  <button className="btn btn-primary" type="submit" disabled={sendingTestEmail || isSettingsDirty || savingSettings}>
                    <Send size={14} />
                    {sendingTestEmail ? "Sending..." : "Send"}
                  </button>
                </form>
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

            <div className="admin-settings-savebar">
              <span role="status">{isSettingsDirty ? "You have unsaved changes" : "No unsaved changes"}</span>
              <button
                className="btn btn-ghost"
                onClick={discardChanges}
                disabled={!isSettingsDirty || savingSettings}
                type="button"
              >
                Discard changes
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

    <FreshAuthDialog controller={freshAuth} body="This administrator action needs a recent identity check." />
  </>;
}
