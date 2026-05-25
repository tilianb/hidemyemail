interface Props {
  rows?: number;
  height?: number | string;
  className?: string;
}

export function Skeleton({ rows = 1, height = 18, className = "" }: Props) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`skeleton ${className}`}
          style={{
            height: typeof height === "number" ? `${height}px` : height,
            marginBottom: rows > 1 && i < rows - 1 ? "8px" : undefined,
            opacity: 1 - i * 0.15,
          }}
        />
      ))}
    </>
  );
}

export function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, ri) => (
        <tr key={ri} style={{ borderBottom: "1px solid var(--border)" }}>
          {Array.from({ length: cols }).map((_, ci) => (
            <td key={ci} style={{ padding: "11px 14px" }}>
              <Skeleton height={14} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
