import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api } from "../../api";
import { useToast } from "../../ui";

type Tri = "on" | "off" | null;
type Position = "header" | "footer" | null;
type Choice = "inherit" | "off" | "header" | "footer";

export function InlineForwardingPreferences() {
  const { toast } = useToast();
  const [preference, setPreference] = useState<Tri>(null);
  const [position, setPosition] = useState<Position>(null);
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const [defaultPosition, setDefaultPosition] = useState("footer");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.preferences().then(result => {
      if (!active) return;
      setPreference(result.inline_actions_pref);
      setPosition(result.inline_actions_position);
      setDefaultEnabled(result.defaults.inline_actions_enabled);
      setDefaultPosition(result.defaults.inline_actions_position);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function update(next: Choice) {
    const previous = { preference, position };
    const nextPreference: Tri = next === "inherit" ? null : next === "off" ? "off" : "on";
    const nextPosition: Position = next === "header" || next === "footer" ? next : null;
    setPreference(nextPreference); setPosition(nextPosition); setSaving(true);
    try {
      await api.updatePreferences({ inline_actions_pref: nextPreference, inline_actions_position: nextPosition });
    } catch (error: any) {
      setPreference(previous.preference); setPosition(previous.position);
      toast(error?.message || "Failed to update preference", "error");
    } finally { setSaving(false); }
  }

  const enabled = preference === "on" || (preference === null && defaultEnabled);
  const effectivePosition = position ?? defaultPosition;
  const choice: Choice = preference === null ? "inherit" : preference === "off" ? "off" : (position ?? (defaultPosition === "header" ? "header" : "footer"));
  const defaultLabel = defaultEnabled ? defaultPosition : "disabled";

  return <div className="card stagger-1 card-spaced-bottom">
    <div className="card-header"><span className="card-title">Email Preferences</span></div>
    <div className="card-body">
      <div className="inline-actions-wrap inline-actions-nowrap">
        <div className="security-status-media">
          <Mail size={20} className="icon-muted" />
          <div>
            <div className="status-title">Inline action links</div>
            <div className="status-caption">
              Choose where the Block / Mute&nbsp;7d / Disable alias bar appears in your forwarded emails, or disable it entirely. Currently <strong>{enabled ? effectivePosition : "disabled"}</strong>{preference === null ? <> (inheriting site default: <em>{defaultLabel}</em>)</> : null}.
            </div>
          </div>
        </div>
        <div className="inline-actions inline-actions-select">
          <select aria-label="Inline action links" className="input" value={choice} disabled={saving} onChange={event => update(event.target.value as Choice)}>
            <option value="inherit">Inherit default ({defaultLabel})</option>
            <option value="off">Disabled</option><option value="header">Header</option><option value="footer">Footer</option>
          </select>
        </div>
      </div>
      {enabled && <details className="callout help-callout" style={{ marginTop: "var(--space-3)" }}>
        <summary>Deliverability note</summary>
        <div>The inline action bar adds three <code>mailto:</code> buttons to every forwarded message. Spam filters at Microsoft / Outlook treat that pattern as marketing-list footer, which — combined with a new sending domain — can push messages to Junk. If you see forwards landing in Spam, switch this to <em>Disabled</em> while your sending domain builds reputation; the same actions remain available via the email's standard Unsubscribe button.</div>
      </details>}
    </div>
  </div>;
}
