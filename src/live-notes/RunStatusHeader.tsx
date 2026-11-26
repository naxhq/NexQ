import { useEffect, useState, type ReactNode } from "react";
import { countdownText } from "./runState";

export { runWords, type RunKind, type RunStatusName } from "./runState";

/**
 * "next update in 12 s" from a deadline. Owns its clock: one text node, one tick
 * a second, and none while the window is hidden.
 */
export function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [deadline]);
  return <>{countdownText(deadline, now)}</>;
}

/**
 * Title, state in words, and the panel's controls. The state is spoken once
 * when it changes (a separate status region), never as the page updates.
 */
export function RunStatusHeader({ title, word, note, children }: { title: string; word: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <header className="rs-head">
      <div className="rs-status">
        <h2 className="rs-title">{title}</h2>
        <span className="rs-state" aria-hidden="true">
          {word}
          {note && <span className="rs-status-note">, {note}</span>}
        </span>
        <span role="status" className="rs-sr">{`${title}: ${word}`}</span>
      </div>
      {children}
    </header>
  );
}
