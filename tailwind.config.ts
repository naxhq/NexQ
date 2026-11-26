import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/*
 * Text colours. Two rules, both for readability (src/lib/contrast.test.ts checks the tokens):
 *  1. A semantic colour has a fill token (bg-success, dots, rings) and a text token (--success-text): text-success
 *     resolves to the text token, so one class name works for both and a green label is never a pale green.
 *  2. Text is never faded with an opacity modifier. text-foreground/NN and text-muted-foreground/NN are not
 *     translucent: anything under 80% foreground is the muted colour, which is the quietest text allowed (4.5:1
 *     on every surface). Placeholders and hover/disabled variants resolve the same way.
 */
const alphaOf = (v?: string): number => {
  const n = v === undefined ? 1 : parseFloat(v);
  return Number.isFinite(n) ? n : 1;
};
/** A text token with no fading: an opacity modifier of 0 (a fade-in or a hover reveal) stays transparent, anything else is the solid colour. */
const solid =
  (token: string) =>
  ({ opacityValue }: { opacityValue?: string }) =>
    alphaOf(opacityValue) < 0.05 ? `hsl(var(--${token}) / 0)` : `hsl(var(--${token}))`;
const foregroundText = ({ opacityValue }: { opacityValue?: string }) =>
  alphaOf(opacityValue) < 0.05
    ? "hsl(var(--foreground) / 0)"
    : alphaOf(opacityValue) >= 0.8
      ? "hsl(var(--foreground))"
      : "hsl(var(--muted-foreground))";
const mutedText = solid("muted-foreground");
/*
 * Palette text classes (text-amber-400, text-red-500 ...) are not part of the design: whatever shade a component
 * asked for, the text is the theme token of that colour family, so it reads in both themes.
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const family = (token: string) => Object.fromEntries(SHADES.map((n) => [n, solid(token)]));
const paletteText = {
  red: family("destructive-text"),
  rose: family("rose-text"),
  pink: family("rose-text"),
  amber: family("warning-text"),
  yellow: family("warning-text"),
  orange: family("warning-text"),
  green: family("success-text"),
  emerald: family("success-text"),
  lime: family("success-text"),
  teal: family("success-text"),
  blue: family("primary-text"),
  indigo: family("primary-text"),
  sky: family("info-text"),
  cyan: family("info-text"),
  purple: family("violet-text"),
  violet: family("violet-text"),
  fuchsia: family("violet-text"),
};
const semantic = (name: string) => ({
  DEFAULT: solid(`${name}-text`),
  foreground: `hsl(var(--${name}-foreground))`,
});

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      textColor: {
        ...paletteText,
        foreground: foregroundText,
        muted: { DEFAULT: mutedText, foreground: mutedText },
        primary: semantic("primary"),
        success: semantic("success"),
        warning: semantic("warning"),
        info: semantic("info"),
        destructive: semantic("destructive"),
        highlight: semantic("highlight"),
        speaker: { user: solid("speaker-user-text"), interviewer: solid("speaker-interviewer-text") },
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        highlight: {
          DEFAULT: "hsl(var(--highlight))",
          foreground: "hsl(var(--highlight-foreground))",
        },
        speaker: {
          user: "hsl(var(--speaker-user))",
          interviewer: "hsl(var(--speaker-interviewer))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
