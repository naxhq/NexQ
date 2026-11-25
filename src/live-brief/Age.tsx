import { memo, useEffect, useState } from "react";

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/**
 * "12 s ago". Owns its own clock, so the second ticking re-renders only this
 * span, never the sheet around it. Once a minute old it ticks every 15 s.
 */
export const Age = memo(function Age({ at, now = Date.now }: { at: number; now?: () => number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const age = now() - at;
      timer = setTimeout(() => {
        tick((n) => n + 1);
        next();
      }, age < 60_000 ? 1000 : 15_000);
    };
    next();
    return () => clearTimeout(timer);
  }, [at, now]);
  return <span className="lb-age">{formatAge(now() - at)}</span>;
});
