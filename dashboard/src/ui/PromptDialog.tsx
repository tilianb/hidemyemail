import { useState } from "react";

interface Props {
  title: string;
  body: string;
  defaultValue?: string;
  confirmLabel?: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}

export function PromptDialog({ title, body, defaultValue = "", confirmLabel = "Save", onConfirm, onCancel }: Props) {
  const [val, setVal] = useState(defaultValue);

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          <p style={{ marginBottom: 16 }}>{body}</p>
          <input 
            type="text" 
            className="input input-mono" 
            style={{ width: "100%" }}
            value={val} 
            onChange={e => setVal(e.target.value)}
            autoFocus 
            onKeyDown={e => {
              if (e.key === "Enter") onConfirm(val);
              if (e.key === "Escape") onCancel();
            }}
          />
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={() => onConfirm(val)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
