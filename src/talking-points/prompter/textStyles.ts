import type { TextStyleId } from "../../stores/talkingPointsStore";

/**
 * The style presets for the line states: what is left (ahead), what you scrolled past (past),
 * the line you are on (current) and what you said (said / autosaid). The CSS for each lives in
 * talkingPoints.css under `.tp-read[data-style="<id>"]`. Classic is the look from before presets.
 */
export interface TextStylePreset {
  id: TextStyleId;
  name: string;
  /** One plain line under the name. */
  blurb: string;
}

export const TEXT_STYLES: readonly TextStylePreset[] = [
  { id: "classic", name: "Classic", blurb: "Lines fade as you pass them" },
  { id: "checked", name: "Checked off", blurb: "What you said is struck through in green" },
  { id: "highlight", name: "Highlight", blurb: "A soft mark on the line you are on" },
  { id: "focus", name: "Focus", blurb: "The current line stands out, the rest recedes" },
  { id: "contrast", name: "High contrast", blurb: "Full strength everywhere, marked by lines" },
];

/** The line states a preview walks through, one frame after another. */
export type PreviewState = "current" | "ahead" | "past" | "said";
export const PREVIEW_LINES = ["Open with the news", "Revenue is up 12%", "Churn fell to 2%", "Ask for the budget"] as const;
/** Frames of the animated preview: a state for each line. The still frame (index 2) shows all four states. */
export const PREVIEW_FRAMES: readonly (readonly PreviewState[])[] = [
  ["current", "ahead", "ahead", "ahead"],
  ["said", "current", "ahead", "ahead"],
  ["said", "past", "current", "ahead"],
  ["said", "said", "past", "current"],
];
export const STILL_FRAME = 2;
export const FRAME_MS = 1100;
