import { useEffect, useMemo, useState } from "react";
import { ScreenShareOff } from "lucide-react";
import { DEFAULT_ASSIST_SHORTCUT, DEFAULT_STEALTH_SHORTCUT, useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import { getStealthSupport } from "../lib/ipc";
import { ShortcutButton } from "./ShortcutButton";
import type { StealthSupport } from "../lib/types";

/**
 * Settings → General: stealth mode ("Hide from screen share"), its shortcut,
 * and the Assist shortcut that works without switching to NexQ.
 */
export function StealthSettings() {
  const stealthMode = useConfigStore((s) => s.stealthMode);
  const setStealthMode = useConfigStore((s) => s.setStealthMode);
  const shortcut = useConfigStore((s) => s.stealthShortcut);
  const setShortcut = useConfigStore((s) => s.setStealthShortcut);
  const assistShortcut = useConfigStore((s) => s.assistShortcut);
  const setAssistShortcut = useConfigStore((s) => s.setAssistShortcut);
  const stealthTaken = useMemo(() => ({ [assistShortcut]: "Assist" }), [assistShortcut]);
  const assistTaken = useMemo(() => ({ [shortcut]: "Hide from screen share" }), [shortcut]);

  const [support, setSupport] = useState<StealthSupport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getStealthSupport().then(setSupport).catch(() => setSupport(null));
  }, []);

  const unsupported = support?.supported === false;

  const toggle = async () => {
    setBusy(true);
    try {
      await setStealthMode(!stealthMode);
    } catch (e) {
      showToast(`Couldn't change screen-share visibility: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-2.5">
          <ScreenShareOff
            className={`mt-0.5 h-4 w-4 shrink-0 transition-colors duration-200 ${stealthMode ? "text-primary" : "text-muted-foreground"}`}
            aria-hidden="true"
          />
          <div>
            <label id="stealth-label" className="text-sm font-medium text-foreground">
              Hide from screen share
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              NexQ stays on your screen but won't appear in screen sharing, recordings or
              screenshots (Zoom, Teams, Meet, OBS and others).
            </p>
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy || unsupported}
          role="switch"
          aria-checked={stealthMode}
          aria-labelledby="stealth-label"
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
            stealthMode ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              stealthMode ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <div className="h-px bg-border/20" />

      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-medium text-foreground/80">Shortcut</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Works from any app. Also in the tray menu and the meeting overlay.
          </p>
        </div>
        <ShortcutButton value={shortcut} defaultValue={DEFAULT_STEALTH_SHORTCUT} onChange={setShortcut} others={stealthTaken} />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-medium text-foreground/80">Assist from any app</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            During a meeting, asks for an answer without switching to NexQ. Space works only in the overlay.
          </p>
        </div>
        <ShortcutButton value={assistShortcut} defaultValue={DEFAULT_ASSIST_SHORTCUT} onChange={setAssistShortcut} others={assistTaken} />
      </div>

      {support?.note && <p className="text-meta text-muted-foreground/70">{support.note}</p>}
    </div>
  );
}
