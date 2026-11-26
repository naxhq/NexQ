/**
 * The footer chips of the AI assistant panel (Last N min, Notes, Tools).
 * An off chip is a plain outline: no fill, no background on the label, text in the opaque muted token.
 * Notes and Tools are `role="switch"`, and index.css dresses every off switch as a track with a knob
 * (including its first child span, the label), so a chip opts out with `data-chip`.
 */
export const CHIP_BASE =
  "flex items-center gap-1 min-h-6 rounded-lg px-2 py-1 text-meta font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export const CHIP_OFF =
  "bg-transparent text-muted-foreground ring-1 ring-inset ring-border hover:bg-accent/50 hover:text-foreground";

export const CHIP_OPEN = "bg-accent/50 text-foreground ring-1 ring-inset ring-border";
