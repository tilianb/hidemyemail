import { useEffect, useState } from "react";
import { api } from "../api";

export function Stats() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.stats().then(setS); }, []);
  if (!s) return <div>Loading...</div>;
  return (
    <div>
      <p>Aliases: {s.totals.aliases} ({s.totals.active} active)</p>
      <h3>Last 24h</h3>
      <ul>{Object.entries(s.last24h).map(([k, v]) => <li key={k}>{k}: {v as number}</li>)}</ul>
      <h3>Top aliases (by forwards)</h3>
      <ol>{s.topAliases.map((a: any) => <li key={a.full_address}>{a.full_address} — {a.fwd_count} fwd / {a.reply_count} reply</li>)}</ol>
    </div>
  );
}
