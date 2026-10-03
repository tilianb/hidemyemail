import { useState } from "react";
import { Server } from "lucide-react";

interface EnvironmentData {
  vars: Record<string, { value: string; secret: false }>;
  secrets: Record<string, { configured: boolean; preview?: string }>;
}

export function EnvironmentSection({ data }: { data: EnvironmentData }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`card admin-panel-card admin-env-card stagger-6 ${open ? "is-open" : ""}`}>
      <div className="card-header admin-section-header admin-collapsible-header" onClick={() => setOpen(!open)}>
        <div>
          <span className="card-title admin-section-title"><Server size={18} /> Environment</span>
          <p className="admin-section-subtitle">Read-only Worker variables and secret configuration status.</p>
        </div>
        <button className="admin-panel-toggle" type="button" aria-expanded={open} aria-controls="admin-environment-body" onClick={event => { event.stopPropagation(); setOpen(!open); }}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && <div className="card-body" id="admin-environment-body">
        <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 16 }}>
          Read-only view of Cloudflare Worker environment variables and secrets. Note that secrets cannot be modified here.
        </p>
        <div className="table-wrap"><table className="dossier">
          <thead><tr><th>Variable</th><th>Value / Status</th></tr></thead>
          <tbody>
            {Object.entries(data.vars).map(([key, value]) => <tr key={key}>
              <td className="font-mono" style={{ fontSize: "0.85rem" }}>{key}</td>
              <td className="font-mono" style={{ fontSize: "0.85rem" }}>{value.value}</td>
            </tr>)}
            {Object.entries(data.secrets).map(([key, value]) => <tr key={key}>
              <td className="font-mono" style={{ fontSize: "0.85rem" }}>{key}</td>
              <td>{value.configured ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="badge badge-green">Configured</span>
                {value.preview && <span className="font-mono text-muted" style={{ fontSize: "0.85rem" }}>{value.preview}</span>}
              </div> : <span className="badge badge-amber">Not Set</span>}</td>
            </tr>)}
          </tbody>
        </table></div>
      </div>}
    </div>
  );
}
