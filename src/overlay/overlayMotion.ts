/**
 * The meeting window is transparent. A CSS animation that never ends keeps that window
 * compositing on every display frame: one 8 px pulsing dot cost 15 to 20% of a core in the
 * real app (and the same in the previous release). Inside the meeting window a pulse or ping
 * draws attention a few times and then rests; the state it marks stays visible.
 */
export const OVERLAY_MOTION_CSS = `.overlay-bg .animate-pulse { animation-iteration-count: 3; }
.overlay-bg .animate-ping { animation-iteration-count: 3; }`;

/**
 * Text in the meeting window reads at 4.5:1 in both themes. The faint greys come from alpha
 * classes (text-muted-foreground/40 to /70) that cannot reach it on any theme, so inside the
 * window they all use the theme's muted colour at full strength (hover rules still win), and
 * the small coloured labels (info, primary, destructive) use a deeper or lighter shade per theme.
 */
/** The coloured label shades per theme (HSL triples); backing.ts checks these too. */
export const ACCENT_TEXT = {
  light: { info: "199 89% 28%", primary: "217 91% 36%", destructive: "0 72% 38%" },
  dark: { primary: "217 91% 74%", destructive: "0 91% 74%" },
} as const;

export const OVERLAY_CONTRAST_CSS = `.overlay-bg [class*="text-muted-foreground/"]:not(:hover) { color: hsl(var(--muted-foreground)); }
.light .overlay-bg .text-info { color: hsl(${ACCENT_TEXT.light.info}); }
.light .overlay-bg .text-primary { color: hsl(${ACCENT_TEXT.light.primary}); }
.light .overlay-bg .text-destructive { color: hsl(${ACCENT_TEXT.light.destructive}); }
.light .overlay-bg .text-speaker-user { color: hsl(217 91% 38%); }
.light .overlay-bg .text-speaker-interviewer { color: hsl(25 95% 30%); }
.dark .overlay-bg .text-primary { color: hsl(${ACCENT_TEXT.dark.primary}); }
.dark .overlay-bg .text-destructive { color: hsl(${ACCENT_TEXT.dark.destructive}); }`;
