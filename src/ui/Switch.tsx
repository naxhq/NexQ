import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label. Without it pass `aria-label`. */
  label?: ReactNode;
  /** A quieter line under the label. */
  description?: ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * On/off. The knob's place says the state as well as the colour (and the label
 * stays the same, not "Enable X" / "Disable X").
 */
export function Switch({ checked, onChange, label, description, disabled, className, ...rest }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={rest["aria-label"]}
        aria-labelledby={label ? `${id}-l` : undefined}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "ui-focus-pill relative mt-0.5 h-[1.125rem] w-8 shrink-0 rounded-full outline-none ui-focus transition-colors duration-200 disabled:opacity-50",
          checked ? "bg-primary" : "ui-field-off",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full transition-[transform,background-color] duration-200 [transition-timing-function:var(--ui-ease)]",
            checked ? "translate-x-[0.875rem] bg-white" : "bg-[hsl(var(--control-edge))]",
          )}
        />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && (
            <span id={`${id}-l`} className="ui-body block">
              {label}
            </span>
          )}
          {description && (
            <span id={`${id}-d`} className="ui-meta block text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
