import { useEffect, useState, type RefObject } from "react";

/**
 * Is the dock panel that holds `ref` on screen? A hidden panel or a background tab
 * stays mounted but must do no work (no frame loops, no polling). Event-driven: the dock
 * flips `data-visible`, a MutationObserver reports it. Outside a dock: always true.
 */
export function useShown(ref: RefObject<Element | null>): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-dock-panel]");
    if (!host) {
      setShown(true);
      return;
    }
    const read = () => setShown(host.getAttribute("data-visible") !== "false");
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { attributes: true, attributeFilter: ["data-visible"] });
    return () => mo.disconnect();
  }, [ref]);
  return shown;
}
