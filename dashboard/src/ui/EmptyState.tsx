import { ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  title: string;
  body?: string;
}

export function EmptyState({ icon, title, body }: Props) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
    </div>
  );
}
