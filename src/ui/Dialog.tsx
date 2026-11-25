import { useId, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/utils";
import { Button, buttonBase } from "./Button";
import { Portal } from "./portal";
import { useFocusTrap } from "./useFocusTrap";

interface LayerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Focus this control first (default: the first control). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** false = Escape and the backdrop do nothing (a save in progress). */
  dismissible?: boolean;
  role?: "dialog" | "alertdialog";
}

/** Shared by Dialog and SlideOver: backdrop, focus trap, Escape, labelled by its title. */
export function ModalLayer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  dismissible = true,
  role = "dialog",
  placement,
  className,
}: LayerProps & { placement: "center" | "right" | "left"; className?: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(boxRef, open, initialFocusRef);
  if (!open) return null;

  const animation = placement === "center" ? "ui-pop-in" : placement === "right" ? "ui-sheet-in-right" : "ui-sheet-in-left";

  return (
    <Portal>
      <div
        className={cn(
          "ui-fade-in fixed inset-0 z-50 flex bg-background/70",
          placement === "center" && "items-center justify-center p-4",
          placement === "right" && "justify-end",
          placement === "left" && "justify-start",
        )}
        onMouseDown={(e) => {
          if (dismissible && e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={boxRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && dismissible) {
              e.stopPropagation();
              onClose();
            }
          }}
          className={cn(
            animation,
            "flex flex-col border border-border bg-popover text-popover-foreground shadow-[0_24px_64px_-24px_rgba(0,0,0,0.65)] outline-none ui-focus",
            placement === "center" ? "max-h-full w-full rounded-2xl" : "h-full w-[min(26rem,100%)]",
            placement === "right" && "rounded-l-2xl border-r-0",
            placement === "left" && "rounded-r-2xl border-l-0",
            className,
          )}
        >
          <div className="px-5 pb-1 pt-5">
            <h2 id={titleId} className="ui-dialog-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="ui-body ui-measure mt-1 text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <div className="ui-body min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

export interface DialogProps extends LayerProps {
  size?: "sm" | "md" | "lg";
}

const SIZES = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" } as const;

/** A modal dialog: focus moves in and is trapped, Escape closes, focus returns to what opened it. */
export function Dialog({ size = "md", ...rest }: DialogProps) {
  return <ModalLayer {...rest} placement="center" className={SIZES[size]} />;
}

/** The recipe as class strings, for code that has not moved to <Button> yet. Same look as Button, size md. */
export const buttonClass = {
  base: buttonBase("md"),
  quiet: "ui-field text-foreground",
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger: the red button, and focus starts on Cancel so Enter can't destroy by accident. */
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}

/** A question with two answers. Deleting needs its own verb on the button ("Delete 12 meetings"), not "OK". */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  return (
    <ModalLayer
      open={open}
      onClose={onCancel}
      title={title}
      description={body}
      role="alertdialog"
      placement="center"
      className="max-w-sm"
      initialFocusRef={tone === "danger" ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </ModalLayer>
  );
}
