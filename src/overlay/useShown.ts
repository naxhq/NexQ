import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Is the dock panel that holds `ref` on screen? A hidden panel, a background tab, or a window that is
 * hidden or minimised stays mounted but must do no work (no frame loops, no polling).
 *
 * Event-driven, and robust to the element coming and going: it looks at `ref.current` after every render
 * of the caller, re-attaches its observer when the element (or the dock panel around it) is a different
 * one, and follows `data-visible` and the page's visibility. Outside a dock it is shown whenever the page is.
 */
export function useShown(ref: RefObject<Element | null>): boolean {
  const [panelShown, setPanelShown] = useState(true);
  const [pageShown, setPageShown] = useState(!pageHidden());
  const attached = useRef<{ el: Element | null; mo: MutationObserver | null }>({ el: null, mo: null });

  // After every render: is it still the same element? (The scroll area can appear later or be replaced.)
  useLayoutEffect(() => {
    const el = ref.current;
    if (attached.current.el === el) return;
    attached.current.mo?.disconnect();
    attached.current = { el, mo: null };
    const host = el?.closest<HTMLElement>("[data-dock-panel]") ?? null;
    if (!host) {
      setPanelShown(true);
      return;
    }
    const read = () => setPanelShown(host.getAttribute("data-visible") !== "false");
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { attributes: true, attributeFilter: ["data-visible"] });
    attached.current.mo = mo;
  });
  useEffect(
    () => () => {
      attached.current.mo?.disconnect();
      attached.current = { el: null, mo: null };
    },
    [],
  );

  useEffect(() => {
    const on = () => setPageShown(!pageHidden());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  return panelShown && pageShown;
}
