import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  blockOpacity,
  extrasOpacity,
  modeFor,
  progressFromScroll,
  snappedProgress,
  stepProgress,
  type HeaderMode,
} from "./headerCollapse";

/** The chat's scroller says so (Transcript), so the header never guesses which scroll area is the chat. */
export const CHAT_SCROLL_ATTR = "data-chat-scroll";
/** The chat-switcher row, which rides along under the header while it condenses. */
export const CHAT_SWITCHER_ATTR = "data-chat-switcher";

export interface HeaderParts {
  /** The overlay: clipped from the bottom as it condenses. */
  overlay: RefObject<HTMLElement>;
  /** The full block: slides up under the bar and fades. */
  block: RefObject<HTMLDivElement>;
  /** The bar's extras: fade in. */
  extras: RefObject<HTMLDivElement>;
}

const calm = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Scroll-linked header progress, written straight to the DOM: transforms, opacity and a clip, nothing
 * that lays out the chat. The overlay never changes the chat's size; the Transcript keeps `range` px of
 * room above its first message, which scrolls away at exactly the pace the header condenses.
 */
export function useHeaderCollapse({
  box,
  parts,
  active,
  locked,
  range,
  resetKey,
}: {
  box: RefObject<HTMLElement | null>;
  parts: HeaderParts;
  /** The header is the collapsing kind (a chat has messages, or the pane is short). */
  active: boolean;
  /** No scroller to follow (a short pane on the start screen): compact, unless opened on demand. */
  locked: boolean;
  /** Pixels of scroll over which it condenses. */
  range: number;
  /** Another chat: read where its scroller stands afresh. */
  resetKey: string;
}) {
  const [mode, setMode] = useState<HeaderMode>("compact");
  const [pinned, setPinnedState] = useState(false);
  const p = useRef(1);
  const target = useRef(1);
  const lastY = useRef<number | null>(null);
  const raf = useRef(0);
  const lastT = useRef(0);
  const modeRef = useRef<HeaderMode>("compact");
  const pinnedRef = useRef(false);
  const rangeRef = useRef(range);
  const switcher = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  const mounted = useRef(false);
  rangeRef.current = range;
  // Latest values for callbacks that must keep one identity (a re-subscribed listener would drop a gliding frame).
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const setModeBoth = (m: HeaderMode) => {
    if (modeRef.current === m) return;
    modeRef.current = m;
    setMode(m);
  };

  const apply = useCallback(
    (progress: number) => {
      const e = rangeRef.current;
      const root = box.current;
      if (!root) return;
      root.dataset.progress = progress.toFixed(3);
      const parts = partsRef.current;
      const overlay = parts.overlay.current;
      if (overlay) overlay.style.clipPath = progress <= 0 ? "none" : `inset(0px 0px ${(progress * e).toFixed(2)}px 0px)`;
      const block = parts.block.current;
      if (block) {
        block.style.transform = `translate3d(0, ${(-progress * e).toFixed(2)}px, 0)`;
        block.style.opacity = String(blockOpacity(progress));
      }
      const extras = parts.extras.current;
      if (extras) {
        const q = extrasOpacity(progress);
        extras.style.opacity = String(q);
        extras.style.transform = q >= 1 ? "" : `translate3d(0, ${((1 - q) * 6).toFixed(2)}px, 0)`;
      }
      if (!switcher.current || !switcher.current.isConnected) switcher.current = root.querySelector<HTMLElement>(`[${CHAT_SWITCHER_ATTR}]`);
      const sw = switcher.current;
      if (sw) {
        sw.style.transform = progress >= 1 ? "" : `translate3d(0, ${((1 - progress) * e).toFixed(2)}px, 0)`;
        sw.style.boxShadow = "0 -1px 0 hsl(var(--border))";
      }
    },
    [box],
  );

  const wanted = useCallback((): number => {
    if (pinnedRef.current) return 0;
    if (lastY.current === null) return lockedRef.current ? 1 : p.current;
    return lockedRef.current ? 1 : progressFromScroll(lastY.current, rangeRef.current);
  }, []);

  const settle = useCallback(
    (next: number) => {
      p.current = next;
      apply(next);
      setModeBoth(modeFor(modeRef.current, next));
    },
    [apply],
  );

  const run = useCallback(
    (now: number) => {
      raf.current = 0;
      const goal = wanted();
      target.current = goal;
      if (calm()) {
        const s = snappedProgress(modeRef.current, goal);
        settle(s.progress);
        return;
      }
      const dt = lastT.current ? now - lastT.current : 16;
      lastT.current = now;
      const next = stepProgress(p.current, goal, dt);
      settle(next);
      if (next !== goal && typeof requestAnimationFrame !== "undefined") raf.current = requestAnimationFrame(run);
      else lastT.current = 0;
    },
    [wanted, settle],
  );

  const kick = useCallback(() => {
    const goal = wanted();
    target.current = goal;
    // A small move lands this very frame (the scroll event itself); only a jump needs the next ones.
    if (calm() || Math.abs(goal - p.current) <= 0.35 || typeof requestAnimationFrame === "undefined") {
      if (raf.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf.current);
      raf.current = 0;
      run(performance.now());
      return;
    }
    if (!raf.current) raf.current = requestAnimationFrame(run);
  }, [wanted, run]);

  const readScroller = useCallback(() => {
    const el = box.current?.querySelector<HTMLElement>(`[${CHAT_SCROLL_ATTR}]`);
    lastY.current = el ? el.scrollTop : null;
  }, [box]);

  const setPinned = useCallback(
    (v: boolean) => {
      pinnedRef.current = v;
      setPinnedState(v);
      kick();
    },
    [kick],
  );

  useEffect(() => {
    mounted.current = true;
  }, []);

  // Becoming the collapsing kind: from the start screen it condenses in front of you, otherwise it opens compact.
  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false;
      lastY.current = null;
      pinnedRef.current = false;
      setPinnedState(false);
      const sw = box.current?.querySelector<HTMLElement>(`[${CHAT_SWITCHER_ATTR}]`);
      if (sw) {
        sw.style.transform = "";
        sw.style.boxShadow = "";
      }
      switcher.current = null;
      // The in-flow header has no overlay, clip or offsets: clear what the collapsing one wrote.
      const parts = partsRef.current;
      for (const el of [parts.overlay.current, parts.block.current, parts.extras.current]) {
        if (el) {
          el.style.clipPath = "";
          el.style.transform = "";
          el.style.opacity = "";
        }
      }
      if (box.current) delete box.current.dataset.progress;
      return;
    }
    if (!wasActive.current) {
      // Opened with the chat already there: compact. Turned into one in front of you (the first answer): it condenses.
      p.current = mounted.current && !locked ? 0 : 1;
      modeRef.current = p.current === 0 ? "full" : "compact";
      setMode(modeRef.current);
      wasActive.current = true;
    }
    readScroller();
    apply(p.current);
    kick();
  }, [active, locked, resetKey, readScroller, apply, kick, box]);

  // New measurements (the block changed height): redraw at the same progress.
  useLayoutEffect(() => {
    if (active) apply(p.current);
  }, [active, range, apply]);

  useEffect(() => {
    const root = box.current;
    if (!active || !root) return;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.hasAttribute?.(CHAT_SCROLL_ATTR)) return;
      lastY.current = t.scrollTop;
      kick();
    };
    // A person scrolling closes the on-demand header; the chat writing an answer does not.
    const release = () => {
      if (pinnedRef.current) setPinned(false);
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    root.addEventListener("wheel", release, { capture: true, passive: true });
    root.addEventListener("touchmove", release, { capture: true, passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      root.removeEventListener("wheel", release, { capture: true });
      root.removeEventListener("touchmove", release, { capture: true });
      if (raf.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [active, box, kick, setPinned]);

  /** The chevron: open it on demand from the bar, close it again, or (at the very top) scroll it away. */
  const toggle = useCallback(() => {
    if (pinnedRef.current) return setPinned(false);
    if (modeRef.current === "compact") return setPinned(true);
    const el = box.current?.querySelector<HTMLElement>(`[${CHAT_SCROLL_ATTR}]`);
    if (el) el.scrollTo?.({ top: rangeRef.current, behavior: calm() ? "auto" : "smooth" });
  }, [box, setPinned]);

  return { mode, pinned, toggle, closePinned: () => setPinned(false) };
}
