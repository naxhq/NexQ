import { buttonClasses, iconButtonClasses } from "../ui";
// Shared class strings for the workspace screens: tokens only, no colour of their own.
export const fieldClass =
  "ui-body w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 ui-focus ui-r-lg disabled:opacity-60";
export const labelClass = "ui-section mb-1.5 block text-foreground";
export const hintClass = "ui-meta text-muted-foreground";
// One button recipe lives in src/ui/Button.tsx; these keep the old names for the rare place that needs a class string.
export const iconButtonClass = iconButtonClasses("ghost", "sm");
export const quietButton = buttonClasses("ghost", "md");
