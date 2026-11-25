import { useMemo } from "react";
import { hueColor } from "../ui/hues";
import { voiceprint, VOICEPRINT_BARS } from "./voiceprint";

export interface VoiceprintMarkProps {
  /** Workspace id: the shape comes from it. */
  id: string;
  /** A hue id from WORKSPACE_HUES; none = the muted text colour. */
  hue?: string | null;
  /** Height in px; the width follows. */
  size?: number;
  /** Name it for screen readers, or leave it out and it is hidden (always put it beside the name). */
  label?: string;
  className?: string;
}

const BAR = 2.4;
const GAP = 1.6;
const WIDTH = VOICEPRINT_BARS * BAR + (VOICEPRINT_BARS - 1) * GAP;

/** The workspace mark. Crisp at any size: bars are SVG rects on a fixed grid. */
export function VoiceprintMark({ id, hue = null, size = 20, label, className }: VoiceprintMarkProps) {
  const heights = useMemo(() => voiceprint(id), [id]);
  const H = 20;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${H}`}
      width={(size * WIDTH) / H}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={className}
      style={{ color: hueColor(hue), flexShrink: 0 }}
    >
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * (BAR + GAP)}
          y={(H - h * H) / 2}
          width={BAR}
          height={h * H}
          rx={BAR / 2}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
