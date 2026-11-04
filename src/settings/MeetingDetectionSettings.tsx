import { Radar } from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingScenarios, useScenarioStore } from "../stores/scenarioStore";
import { isMacPlatform } from "../lib/shortcutLabel";
import type { AIScenario, MeetingDetectionConfig } from "../lib/types";

type AppKey = "zoom" | "teams" | "google_meet" | "webex" | "slack" | "discord";

const APPS: Array<{ key: AppKey; label: string }> = [
  { key: "zoom", label: "Zoom" },
  { key: "teams", label: "Microsoft Teams" },
  { key: "google_meet", label: "Google Meet" },
  { key: "webex", label: "Webex" },
  { key: "slack", label: "Slack huddles" },
  { key: "discord", label: "Discord" },
];

const DISMISS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 0, label: "Until the call ends" },
];

const CHECK_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Every second" },
  { value: 2, label: "Every 2 seconds" },
  { value: 3, label: "Every 3 seconds" },
  { value: 5, label: "Every 5 seconds" },
  { value: 10, label: "Every 10 seconds" },
];

/** Settings → General: offer to start NexQ when a call app starts a meeting. */
export function MeetingDetectionSettings() {
  const config = useConfigStore((s) => s.meetingDetection);
  const setConfig = useConfigStore((s) => s.setMeetingDetection);
  const update = (patch: Partial<MeetingDetectionConfig>) => setConfig({ ...config, ...patch });
  const scenarios = useMeetingScenarios();
  const startAs = useScenarioStore((s) => s.resolveScenario(config.default_scenario));
  // Detection reads Windows audio sessions; macOS support comes later.
  const unsupported = isMacPlatform();

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-2.5">
          <Radar
            className={`mt-0.5 h-4 w-4 shrink-0 transition-colors duration-200 ${config.enabled && !unsupported ? "text-primary" : "text-muted-foreground"}`}
            aria-hidden="true"
          />
          <div>
            <label id="meeting-detection-label" className="text-sm font-medium text-foreground">
              Detect meetings
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When a call starts in one of these apps, a small prompt offers to start NexQ, named after the call.
              NexQ only checks which app is using your microphone; it never listens until you start.
            </p>
          </div>
        </div>
        <button
          onClick={() => update({ enabled: !config.enabled })}
          disabled={unsupported}
          role="switch"
          aria-checked={config.enabled && !unsupported}
          aria-labelledby="meeting-detection-label"
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
            config.enabled && !unsupported ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              config.enabled && !unsupported ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {unsupported ? (
        <p className="text-meta text-muted-foreground/70">Available on Windows for now; macOS support is coming.</p>
      ) : (
        config.enabled && (
          <>
            <div className="h-px bg-border/20" />
            <div>
              <span className="text-xs font-medium text-foreground/80">Apps</span>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Apps to detect">
                {APPS.map(({ key, label }) => {
                  const on = config[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => update({ [key]: !on } as Partial<MeetingDetectionConfig>)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors duration-150 cursor-pointer ${
                        on
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/40 bg-secondary/20 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-meta text-muted-foreground/60">
                Google Meet, and Teams or Zoom in a browser, are recognized from the active tab.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">Start as</span>
                <select
                  value={startAs}
                  onChange={(e) => update({ default_scenario: e.target.value as AIScenario })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">Hide the prompt after</span>
                <select
                  value={config.auto_dismiss_secs}
                  onChange={(e) => update({ auto_dismiss_secs: Number(e.target.value) })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {DISMISS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">Check for calls</span>
                <select
                  value={config.check_interval_secs}
                  onChange={(e) => update({ check_interval_secs: Math.max(1, Number(e.target.value)) })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {CHECK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-meta text-muted-foreground/60">
              Each check takes a few milliseconds. More often means the prompt appears sooner after a call starts.
            </p>
          </>
        )
      )}
    </div>
  );
}
