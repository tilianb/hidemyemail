import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface Props {
  text: string;
  label?: string;
  mono?: boolean;
  className?: string;
}

export function CopyButton({ text, label, mono = true, className = "" }: Props) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <button
      type="button"
      className={`copy-btn${copied ? " copied" : ""}${className ? " " + className : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : `Copy ${text}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
        ...(mono ? { fontFamily: "var(--font-mono)", fontSize: "0.8rem" } : {})
      }}
    >
      {label && <span>{label}</span>}
      {copied ? (
        <Check size={12} style={{ opacity: 0.9 }} />
      ) : (
        <Copy size={12} style={{ opacity: 0.7 }} />
      )}
    </button>
  );
}
