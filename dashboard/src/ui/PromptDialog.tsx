import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

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
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay">
        <Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <Dialog.Title className="dialog-title">{title}</Dialog.Title>
        <Dialog.Description asChild><div className="dialog-body">
          <p style={{ marginBottom: 16 }}>{body}</p>
          <input 
            type="text" 
            aria-label={title}
            className="input input-mono" 
            style={{ width: "100%" }}
            value={val} 
            onChange={e => setVal(e.target.value)}
            autoFocus 
            onKeyDown={e => { if (e.key === "Enter") onConfirm(val); }}
          />
        </div></Dialog.Description>
        <div className="dialog-actions">
          <Dialog.Close className="btn btn-ghost" type="button">Cancel</Dialog.Close>
          <button className="btn btn-primary" type="button" onClick={() => onConfirm(val)}>
            {confirmLabel}
          </button>
        </div>
        </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
