interface SourceSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** `highlight` for notes, `primary` for tools: the same colors as the overlay pills. */
  tone?: "primary" | "highlight";
  describedBy?: string;
}

/**
 * The track is 28 x 16 px, but the button around it is at least 24 px tall and
 * 36 px wide, so it is easy to hit.
 */
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
      className={`group flex h-6 min-w-9 shrink-0 items-center justify-center rounded-full focus-visible:outline-none ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <span
        className={`relative block h-4 w-7 rounded-full transition-colors duration-200 group-focus-visible:ring-2 group-focus-visible:ring-primary/40 ${
          checked ? on : "bg-muted"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}
