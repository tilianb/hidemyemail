interface Props {
  title: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
  onCancel: () => void;
}

export function ChoiceDialog({ title, body, primaryLabel, secondaryLabel, onPrimary, onSecondary, onCancel }: Props) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{body}</div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn btn-secondary" type="button" onClick={onSecondary}>
            {secondaryLabel}
          </button>
          <button className="btn btn-primary" type="button" onClick={onPrimary}>
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
