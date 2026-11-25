import { useMemo } from "react";
import { computeGeometry } from "./layoutGeometry";
import type { Layout } from "./layoutModel";

interface Props {
  layout: Layout;
  w?: number;
  h?: number;
  className?: string;
}

/** What each panel is for, as a tint (never decoration): the assistant, prepared material, the live record, tools. */
const ROLE: Record<string, { letter: string; tint: string }> = {
  assistant: { letter: "A", tint: "var(--primary)" },
  notes: { letter: "N", tint: "var(--info)" },
  brief: { letter: "B", tint: "var(--info)" },
  points: { letter: "P", tint: "var(--info)" },
  transcript: { letter: "T", tint: "var(--foreground)" },
  bookmarks: { letter: "K", tint: "var(--foreground)" },
  stats: { letter: "S", tint: "var(--foreground)" },
  calllog: { letter: "C", tint: "var(--foreground)" },
  devlog: { letter: "D", tint: "var(--foreground)" },
};
const roleOf = (p: string) => ROLE[p] ?? { letter: p.slice(0, 1).toUpperCase(), tint: "var(--foreground)" };

// The schematic is drawn from the real geometry of a typical wide meeting window.
const REF = { w: 1000, h: 640 };

/** A small schematic of a real layout tree: the same geometry code, scaled down, panels labelled by initial. */
export function LayoutPreview({ layout, w = 72, h = 46, className }: Props) {
  const geo = useMemo(() => computeGeometry(layout, REF), [layout]);
  const sx = w / REF.w;
  const sy = h / REF.h;
  return (
    <div
      role="img"
      aria-label={`${geo.stacks.length} panel group${geo.stacks.length === 1 ? "" : "s"}`}
      className={className}
      style={{ position: "relative", width: w, height: h, color: "hsl(var(--foreground))" }}
    >
      {geo.stacks.map((s) => {
        const role = roleOf(s.active);
        const tabbed = s.panels.length > 1;
        return (
          <div
            key={s.id}
            style={{
              position: "absolute",
              left: s.rect.x * sx,
              top: s.rect.y * sy,
              width: Math.max(2, s.rect.w * sx),
              height: Math.max(2, s.rect.h * sy),
              borderRadius: 3,
              background: `hsl(${role.tint} / ${s.strip ? 0.4 : 0.22})`,
              boxShadow: `inset 0 0 0 1px hsl(${role.tint} / 0.3)`,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              fontWeight: 600,
              lineHeight: 1,
              color: "hsl(var(--foreground))",
            }}
          >
            {!s.strip && s.rect.w * sx >= 9 && s.rect.h * sy >= 9 && (
              <span aria-hidden="true">{tabbed ? s.panels.map((p) => roleOf(p).letter).join("") : role.letter}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
