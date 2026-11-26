// Workspace hues. Blue, green, amber and red carry meaning in NexQ (primary,
// live, interviewer, destructive), so a workspace never uses them. The values
// live in src/index.css (`--hue-<id>`, light and dark) and reach 4.5:1 on both
// backgrounds; hues.test.ts checks that.

export interface WorkspaceHue {
  id: string;
  name: string;
  /** HSL triplets, as in index.css, for tests and canvas drawing. */
  light: [number, number, number];
  dark: [number, number, number];
}

export const WORKSPACE_HUES: readonly WorkspaceHue[] = [
  { id: "violet", name: "Violet", light: [262, 52, 48], dark: [262, 80, 76] },
  { id: "orchid", name: "Orchid", light: [290, 48, 44], dark: [290, 70, 74] },
  { id: "magenta", name: "Magenta", light: [318, 56, 43], dark: [318, 72, 72] },
  { id: "rose", name: "Rose", light: [342, 60, 45], dark: [342, 78, 74] },
  { id: "clay", name: "Clay", light: [22, 45, 40], dark: [22, 55, 66] },
  { id: "teal", name: "Teal", light: [184, 80, 26], dark: [184, 60, 58] },
  { id: "moss", name: "Moss", light: [78, 60, 26], dark: [78, 48, 58] },
  { id: "stone", name: "Stone", light: [215, 16, 40], dark: [215, 18, 68] },
];

export type WorkspaceHueId = (typeof WORKSPACE_HUES)[number]["id"];

export function isWorkspaceHue(id: string | null | undefined): id is WorkspaceHueId {
  return !!id && WORKSPACE_HUES.some((h) => h.id === id);
}

/** CSS colour for a hue id; unknown or null falls back to the muted foreground. */
export function hueColor(id: string | null | undefined): string {
  return isWorkspaceHue(id) ? `hsl(var(--hue-${id}))` : "hsl(var(--muted-foreground))";
}

export function hueName(id: string | null | undefined): string {
  return WORKSPACE_HUES.find((h) => h.id === id)?.name ?? "No colour";
}
