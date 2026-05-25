interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{body}</div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button
            className="btn"
            type="button"
            onClick={onConfirm}
            style={{ background: "var(--red-dim)", borderColor: "rgba(255,80,80,0.25)", color: "var(--red)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
