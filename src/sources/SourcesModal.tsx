import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface SourcesModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider body for the add-server dialog. */
  wide?: boolean;
  /** Hide the close button (a notice that has its own button). */
  hideClose?: boolean;
}

/** The plain dialog shell the Personal sources guides and the add-server dialog share. */
export function SourcesModal({ title, onClose, children, wide, hideClose }: SourcesModalProps) {
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`scope-pop-enter flex max-h-[85vh] w-full flex-col rounded-xl border border-border/50 bg-card shadow-2xl ${
          wide ? "max-w-[560px]" : "max-w-[460px]"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border/30 px-5 py-3.5">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
