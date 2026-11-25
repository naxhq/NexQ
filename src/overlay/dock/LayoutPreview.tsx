import { useMemo } from "react";
import { computeGeometry, type PanelMeta } from "./layoutGeometry";
import { panelsOf, type Layout } from "./layoutModel";

interface Props {
  layout: Layout;
  w?: number;
  h?: number;
  className?: string;
}

/** A tiny schematic of a real layout tree: the same geometry code, drawn at thumbnail size. */
export function LayoutPreview({ layout, w = 48, h = 32, className }: Props) {
  const geo = useMemo(() => {
    const metas: Record<string, PanelMeta> = {};
    for (const p of panelsOf(layout.root)) metas[p] = { minW: 0, minH: 0, prefW: 0, prefH: 0 };
    return computeGeometry(layout, { w, h }, metas, { gap: 2, padX: 2, padY: 2, tabH: 3, strip: 3 });
  }, [layout, w, h]);
  return (
    <div
      role="img"
      aria-label={`${geo.stacks.length} panel group${geo.stacks.length === 1 ? "" : "s"}`}
      className={className}
      style={{ position: "relative", width: w, height: h, color: "hsl(var(--foreground))" }}
    >
      {geo.stacks.map((s) => (
        <div
          key={s.id}
          style={{
            position: "absolute",
            left: s.rect.x,
            top: s.rect.y,
            width: s.rect.w,
            height: s.rect.h,
            borderRadius: 2,
            background: "currentColor",
            opacity: s.strip ? 0.28 : 0.14,
          }}
        >
          {!s.strip && s.panels.length > 1 && (
            <div
              style={{
                position: "absolute",
                left: 1,
                top: 1,
                width: Math.max(2, s.rect.w - 2),
                height: 1,
                background: "currentColor",
                opacity: 1,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
