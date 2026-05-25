interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Switch({ checked, onChange, disabled = false, label }: Props) {
  return (
    <label
      className="switch"
      title={label ?? (checked ? "Active" : "Inactive")}
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="switch-track" />
    </label>
  );
}
