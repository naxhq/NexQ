import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export type ButtonVariant = "primary" | "quiet" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/*
 * One recipe for every button in the new screens.
 *  - Focus: `ui-focus` (2 px ring, 2 px offset); its corner radius comes from the size class (`ui-r-*`),
 *    so the ring always follows the button's own corners.
 *  - Radius: sm = h-7 rounded-md, md = h-8 rounded-lg, lg = h-10 rounded-xl (the big primary action).
 *  - Targets: never under 28 px tall (the 24 px minimum with room to spare).
 *  - Contrast: the label is text (4.5:1 or more); the filled primary and danger buttons and the focus ring
 *    reach 3:1 on the page in both themes. `quiet` has a quiet edge because its label already says what it is.
 */
const BASE =
  "ui-body ui-focus inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50";

const SIZE: Record<ButtonSize, string> = {
  sm: "ui-r-md h-7 rounded-md px-2.5",
  md: "ui-r-lg h-8 rounded-lg px-3.5",
  lg: "ui-r-xl h-10 rounded-xl px-5",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  /** A secondary action: field surface with a quiet edge. */
  quiet: "ui-field text-foreground",
  /** Text only, for actions inside a list or a footer. */
  ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const ICON_SIZE: Record<Exclude<ButtonSize, "lg">, string> = {
  sm: "ui-r-md h-7 w-7 rounded-md",
  md: "ui-r-lg h-8 w-8 rounded-lg",
};

/** The same classes as strings, for the few places that cannot render the component (a link, a menu trigger prop bag). */
export function buttonClasses(variant: ButtonVariant = "quiet", size: ButtonSize = "md"): string {
  return cn(BASE, SIZE[size], VARIANT[variant]);
}

/** Size and shape without a colour, for code that picks the variant separately. */
export function buttonBase(size: ButtonSize = "md"): string {
  return cn(BASE, SIZE[size]);
}

/** Icon-only button classes. */
export function iconButtonClasses(variant: Exclude<ButtonVariant, "danger"> = "ghost", size: "sm" | "md" = "sm"): string {
  return cn(BASE, "gap-0 px-0", ICON_SIZE[size], VARIANT[variant]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A text button. `type` defaults to "button" so it never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "quiet", size = "md", type = "button", className, ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cn(BASE, SIZE[size], VARIANT[variant], className)} {...rest} />;
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required: an icon has no text, so the name is the label. */
  "aria-label": string;
  variant?: Exclude<ButtonVariant, "danger">;
  size?: Exclude<ButtonSize, "lg">;
}

/** A square icon-only button (28 or 32 px). Always give it an accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "ghost", size = "sm", type = "button", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonClasses(variant, size), className)}
      {...rest}
    />
  );
});
