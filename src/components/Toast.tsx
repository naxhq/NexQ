import { useState, useEffect, useCallback, useRef } from "react";
import { toastDurationMs, useToastStore } from "../stores/toastStore";
import type { Toast as ToastData } from "../stores/toastStore";
import { CheckCircle, XCircle, Info, AlertTriangle, X } from "lucide-react";

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

/** Left accent border color per type */
const accentMap = {
  success: "border-l-[hsl(var(--success))]",
  error: "border-l-[hsl(var(--destructive))]",
  info: "border-l-[hsl(var(--info))]",
  warning: "border-l-[hsl(var(--warning))]",
};

/** Icon circle background + icon color */
const iconBgMap = {
  success: "bg-success/20 text-success",
  error: "bg-destructive/20 text-destructive",
  info: "bg-info/20 text-info",
  warning: "bg-warning/20 text-warning",
};

/** Entrance animation for the icon */
const iconAnimMap = {
  success: "toast-icon-pop",
  error: "toast-icon-shake",
  info: "toast-icon-pop",
  warning: "toast-icon-pop",
};

/** Progress bar color */
const progressMap = {
  success: "bg-success/50",
  error: "bg-destructive/50",
  info: "bg-info/50",
  warning: "bg-warning/50",
};

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  const Icon = iconMap[toast.type];
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const duration = toastDurationMs(toast.message);
  // Hovering or focusing the toast stops the countdown (WCAG 2.2.1): it resumes with what was left.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remainingRef = useRef(duration);

  // A pointer or focus left behind when the window loses focus must not freeze the toast.
  useEffect(() => {
    const release = () => { setHovered(false); setFocused(false); };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);

  // Auto-dismiss with exit animation (component-driven)
  useEffect(() => {
    if (paused || toast.sticky) return;
    const startedAt = Date.now();
    timerRef.current = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 280);
    }, Math.max(0, remainingRef.current));
    return () => {
      clearTimeout(timerRef.current);
      remainingRef.current -= Date.now() - startedAt;
    };
  }, [onDismiss, paused, toast.sticky]);

  const handleDismiss = useCallback(() => {
    if (exiting) return;
    clearTimeout(timerRef.current);
    setExiting(true);
    setTimeout(onDismiss, 280);
  }, [exiting, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`
        group relative flex items-start gap-3 overflow-hidden
        rounded-xl border border-border/20 border-l-[3.5px]
        ${accentMap[toast.type]}
        bg-card/90 backdrop-blur-md
        px-4 py-3
        shadow-xl shadow-black/10
        ${exiting ? "toast-exit" : "toast-enter"}
      `}
      style={{ maxWidth: 400, minWidth: 280 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {/* Icon with colored circle background */}
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconBgMap[toast.type]} ${iconAnimMap[toast.type]}`}>
        <Icon className="h-4 w-4" />
      </div>

      {/* Message */}
      <p className="flex-1 min-w-0 pt-[3px] text-sm font-medium leading-snug text-foreground/90">
        {toast.message}
      </p>

      {/* Dismiss button — visible on hover or always on touch */}
      <button
        onClick={handleDismiss}
        className="shrink-0 rounded-lg p-1 text-muted-foreground/30 transition-all duration-150 hover:bg-accent hover:text-foreground/70 group-hover:text-muted-foreground/60"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {/* Progress bar — visual countdown to auto-dismiss (a sticky toast has none) */}
      {!toast.sticky && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden">
          <div
            className={`h-full ${progressMap[toast.type]} toast-progress-bar`}
            style={{ animationDuration: `${duration}ms`, animationPlayState: paused ? "paused" : "running" }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Toast container — renders in bottom-right of the viewport.
 * Mount once at the app root.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2.5"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}
