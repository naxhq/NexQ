interface SourceSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** `highlight` for notes, `primary` for tools: the same colors as the overlay pills. */
  tone?: "primary" | "highlight";
  describedBy?: string;
}

export function SourceSwitch({ checked, onChange, label, disabled, tone = "primary", describedBy }: SourceSwitchProps) {
  const on = tone === "highlight" ? "bg-highlight" : "bg-primary";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        checked ? on : "bg-muted"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-3" : "translate-x-0"
        }`}
      />
    </button>
  );
}
