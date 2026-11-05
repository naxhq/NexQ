import { ScreenShare, ScreenShareOff } from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { toggleStealthMode } from "../hooks/useGlobalShortcut";
import { formatShortcut } from "../lib/shortcutLabel";

/**
 * Stealth ("Hide from screen share") toggle for the launcher header.
 *
 * Mirrors the overlay header's stealth button so the setting can be turned
 * off from the dashboard after a meeting ends — the overlay's button is gone
 * by then, and stealth also strips both windows from the taskbar, so a
 * visible off-switch here is the reliable way back.
 */
export function LauncherStealthButton() {
  const stealthMode = useConfigStore((s) => s.stealthMode);
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);

  return (
    <button
      onClick={() => { toggleStealthMode().catch(() => {}); }}
      className={`rounded-lg p-2 transition-all duration-150 active:scale-90 cursor-pointer ${
        stealthMode
          ? "bg-primary/10 text-primary hover:bg-primary/20"
          : "text-muted-foreground/50 hover:bg-secondary hover:text-foreground"
      }`}
      aria-label={`${stealthMode ? "Hidden from screen share — click to show" : "Visible in screen share — click to hide"} (${formatShortcut(stealthShortcut)})`}
      aria-pressed={stealthMode}
    >
      {stealthMode
        ? <ScreenShareOff className="h-4 w-4" aria-hidden="true" />
        : <ScreenShare className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}
