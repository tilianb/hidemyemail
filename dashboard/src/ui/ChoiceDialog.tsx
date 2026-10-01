import * as Dialog from "@radix-ui/react-dialog";
import { useRef } from "react";

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
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay">
        <Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <Dialog.Title className="dialog-title">{title}</Dialog.Title>
        <Dialog.Description className="dialog-body">{body}</Dialog.Description>
        <div className="dialog-actions">
          <Dialog.Close className="btn btn-ghost" type="button">Cancel</Dialog.Close>
          <button className="btn btn-secondary" type="button" onClick={onSecondary}>
            {secondaryLabel}
          </button>
          <button className="btn btn-primary" type="button" onClick={onPrimary}>
            {primaryLabel}
          </button>
        </div>
        </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
