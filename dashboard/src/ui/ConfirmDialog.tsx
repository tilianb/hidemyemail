import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef } from "react";

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <AlertDialog.Root open onOpenChange={open => { if (!open) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay">
        <AlertDialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
        <AlertDialog.Description className="dialog-body">{body}</AlertDialog.Description>
        <div className="dialog-actions">
          <AlertDialog.Cancel className="btn btn-ghost" type="button">Cancel</AlertDialog.Cancel>
          <AlertDialog.Action
            className="btn"
            type="button"
            onClick={onConfirm}
            style={{ background: "var(--red-dim)", borderColor: "rgba(255,80,80,0.25)", color: "var(--red)" }}
          >
            {confirmLabel}
          </AlertDialog.Action>
        </div>
        </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
