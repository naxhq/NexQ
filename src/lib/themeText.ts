/**
 * The default transcript and answer text colours are light greys picked for the dark theme.
 * A user who never changed them gets the theme's own text colour, so the light theme is readable;
 * a colour the user picked is used as chosen.
 */
const THEME_BOUND_DEFAULTS = new Set(["#e4e4e7", "#d4d4d8"]);

export function readingTextColor(color: string): string {
  return THEME_BOUND_DEFAULTS.has(color.trim().toLowerCase()) ? "hsl(var(--foreground))" : color;
}
