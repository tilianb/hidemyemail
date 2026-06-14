import { useEffect, useState } from "react";
import { api } from "../api";
import { Skeleton, EmptyState, CopyButton } from "../ui";
import { Activity } from "lucide-react";

interface StatsData {
  totals: { aliases: number; active: number };
  last24h: { forward: number; reply: number; block: number; reject: number; error: number };
  topAliases: {
    full_address: string;
    fwd_count: number;
    reply_count: number;
    blocked_count: number;
  }[];
}

type LoadState = "loading" | "error" | "ok";

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function Stats() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    api
      .stats()
      .then((raw: StatsData) => {
        setData(raw);
        setLoadState("ok");
      })
      .catch(() => {
        setLoadState("error");
      });
  }, []);

  /* ── Error ── */
  if (loadState === "error") {
    return (
      <div>
        <div className="page-header">
          <div className="page-title-row">
            <h1 className="page-title">Stats</h1>
          </div>
          <p className="page-subtitle">Activity telemetry — last sync on page load.</p>
        </div>
        <EmptyState
          icon={<Activity size={40} />}
          title="Stats unavailable"
          body="Could not load telemetry. Check your connection and try reloading."
        />
      </div>
    );
  }

  /* ── Loading ── */
  if (loadState === "loading" || !data) {
    return (
      <div>
        <div className="page-header">
          <div className="page-title-row">
            <h1 className="page-title">Stats</h1>
          </div>
          <p className="page-subtitle">Activity telemetry — last sync on page load.</p>
        </div>
        <div className="stat-grid-2">
          <div className="stat-card">
            <div className="skeleton-label"><Skeleton height={14} /></div>
            <div className="skeleton-value"><Skeleton height={36} /></div>
          </div>
          <div className="stat-card">
            <div className="skeleton-label"><Skeleton height={14} /></div>
            <div className="skeleton-value"><Skeleton height={36} /></div>
          </div>
        </div>
        <div className="card card-spaced-bottom">
          <Skeleton height={80} />
        </div>
        <div className="card">
          <Skeleton height={120} />
        </div>
      </div>
    );
  }

  /* ── Bar chart calculations ── */
  const { last24h } = data;
  const barValues = [
    { key: "fwd",   label: "fwd",   value: last24h.forward, color: "var(--accent)" },
    { key: "reply", label: "reply", value: last24h.reply,   color: "var(--blue)" },
    { key: "block", label: "block", value: last24h.block,   color: "var(--red)" },
    { key: "rjct",  label: "rjct",  value: last24h.reject,  color: "rgba(255,80,80,0.5)" },
    { key: "err",   label: "err",   value: last24h.error,   color: "var(--red)" },
  ];
  const maxVal = Math.max(...barValues.map(b => b.value), 1);
  const totalVolume =
    last24h.forward + last24h.reply + last24h.block + last24h.reject + last24h.error;

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">Stats</h1>
        </div>
        <p className="page-subtitle">Activity telemetry — last sync on page load.</p>
      </div>

      {/* ── Reply hint callout ── */}
      <div className="callout stagger-1 card-form-gap">
        <strong>How reverse-reply works —</strong>{" "}
        Reverse-reply addresses are generated per alias+sender pair. Your outbound reply appears
        to originate from the alias — your real inbox address is never exposed to the original
        sender.
      </div>

      {/* ── Totals row ── */}
      <div className="stagger-2 stat-grid-2">
        <div className="stat-card">
          <div className="stat-label">Total Aliases</div>
          <div className="stat-value">{data.totals.aliases}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Aliases</div>
          <div className="stat-value text-accent">
            {data.totals.active}
          </div>
        </div>
      </div>

      {/* ── Last 24h activity ── */}
      <div className="card stagger-3 card-spaced-bottom">
        <div className="card-header">
          <span className="card-title">Last 24 Hours</span>
          <span className="badge badge-muted type-data">
            {totalVolume} total
          </span>
        </div>
        <div className="bar-chart">
          {barValues.map(bar => {
            const pct = Math.max((bar.value / maxVal) * 100, 4);
            return (
              <div key={bar.key} className="bar-col">
                <span
                  className="font-mono bar-value"
                >
                  {bar.value}
                </span>
                <div
                  className="bar-fill"
                  style={{
                    height: `${pct}%`,
                    background: bar.color,
                    opacity: bar.value === 0 ? 0.2 : 1,
                  }}
                />
                <span className="bar-label">{bar.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Top Aliases ── */}
      <div className="card stagger-4 card-spaced-bottom">
        <div className="card-header">
          <span className="card-title">Top Aliases</span>
          <span className="badge badge-muted">by forwards</span>
        </div>
        {data.topAliases.length === 0 ? (
          <p className="center-muted muted-italic">
            No activity yet.
          </p>
        ) : (
          <div className="list-stack">
            {data.topAliases.map((alias, i) => (
              <div
                key={alias.full_address}
                className="rank-row"
              >
                <span className="rank-index">
                  {pad2(i + 1)}
                </span>
                <div className="addr-cell addr-cell-fluid">
                  <span className="addr-mono">{alias.full_address}</span>
                  <CopyButton text={alias.full_address} />
                </div>
                <div className="metric-pills">
                  <span
                    className="badge-count metric-forward"
                    title="Forwards"
                  >
                    {alias.fwd_count}
                  </span>
                  <span
                    className="badge-count metric-reply"
                    title="Replies"
                  >
                    {alias.reply_count}
                  </span>
                  {alias.blocked_count > 0 && (
                    <span
                      className="badge-count metric-block"
                      title="Blocked"
                    >
                      {alias.blocked_count}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>


    </div>
  );
}
