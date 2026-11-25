import type { ReactNode, RefObject } from "react";
import { ModalLayer } from "./Dialog";

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  side?: "right" | "left";
  children?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** A side sheet (the Library at 820-1099 px): a dialog that slides in from an edge. */
export function SlideOver({ side = "right", ...rest }: SlideOverProps) {
  return <ModalLayer {...rest} placement={side} />;
}
