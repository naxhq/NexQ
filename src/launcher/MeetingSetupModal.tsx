import { useState, useCallback, useEffect, useRef } from "react";
import { useConfigStore } from "../stores/configStore";
import { setRecordingEnabled } from "../lib/ipc";
import { useMeetingScenarios, useScenarioStore } from "../stores/scenarioStore";
import { MODE_COLORS } from "../lib/speakerColors";
import type { AudioMode, AIScenario } from "../lib/types";
import {
  Monitor,
  Mic,
  X,
  Play,
  ChevronDown,
  RotateCcw,
  CheckSquare,
  Square,
} from "lucide-react";

interface MeetingSetupModalProps {
  open: boolean;
  onStart: (audioMode: AudioMode, scenario: AIScenario) => void;
  onCancel: () => void;
}

export function MeetingSetupModal({ open, onStart, onCancel }: MeetingSetupModalProps) {
  const rememberedSetup = useConfigStore((s) => s.rememberedMeetingSetup);
  const setRememberedMeetingSetup = useConfigStore((s) => s.setRememberedMeetingSetup);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const setRecordingEnabledStore = useConfigStore((s) => s.setRecordingEnabled);

  // Local state — initialise from remembered or defaults
  const [audioMode, setAudioMode] = useState<AudioMode>(
    rememberedSetup?.audioMode ?? "online"
  );
  const [pickedScenario, setScenario] = useState<AIScenario>(
    rememberedSetup?.scenario ?? "team_meeting"
  );
  const scenarios = useMeetingScenarios();
  const scenario = useScenarioStore((s) => s.resolveScenario(pickedScenario));
  const scenarioName = scenarios.find((s) => s.id === scenario)?.name ?? scenario;
  const [remember, setRemember] = useState(rememberedSetup !== null);
  const [showScenarioPicker, setShowScenarioPicker] = useState(false);
  // When remembered setup exists, start in compact view; user can expand
  const [isExpanded, setIsExpanded] = useState(rememberedSetup === null);

  const backdropRef = useRef<HTMLDivElement>(null);

  // Reset state whenever the modal opens or remembered setup changes
  useEffect(() => {
    if (!open) return;
    const hasRemembered = rememberedSetup !== null;
    setAudioMode(rememberedSetup?.audioMode ?? "online");
    setScenario(rememberedSetup?.scenario ?? "team_meeting");
    setRemember(hasRemembered);
    setIsExpanded(!hasRemembered);
    setShowScenarioPicker(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, onCancel]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onCancel();
    },
    [onCancel]
  );

  const handleStart = useCallback(() => {
    if (remember) {
      setRememberedMeetingSetup({ audioMode, scenario });
    } else {
      // If unchecked, clear any existing remembered setup
      setRememberedMeetingSetup(null);
    }
    onStart(audioMode, scenario);
  }, [audioMode, scenario, remember, setRememberedMeetingSetup, onStart]);

  const handleForget = useCallback(() => {
    setRememberedMeetingSetup(null);
    setRemember(false);
    setIsExpanded(true);
  }, [setRememberedMeetingSetup]);

  if (!open) return null;

  const onlineColors = MODE_COLORS.online;
  const inPersonColors = MODE_COLORS.in_person;
  const activeMode = audioMode === "online" ? onlineColors : inPersonColors;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Meeting setup"
    >
      <div className="w-[420px] rounded-2xl border border-border/40 bg-card shadow-2xl overflow-hidden">

        {/* ── HEADER ── */}
        <div className="flex items-center justify-between border-b border-border/20 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: activeMode.bg }}
            >
              {audioMode === "online"
                ? <Monitor className="h-4 w-4" style={{ color: activeMode.text }} />
                : <Mic className="h-4 w-4" style={{ color: activeMode.text }} />
              }
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Start Meeting</h2>
              <p className="text-[11px] text-muted-foreground/60 leading-tight">
                Configure audio mode and scenario
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── COMPACT VIEW (remembered, not expanded) ── */}
        {!isExpanded && rememberedSetup !== null ? (
          <div className="px-5 py-4 space-y-4">
            {/* Saved preferences summary */}
            <div className="rounded-xl border border-border/30 bg-secondary/20 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Saved Preferences
                </span>
                <button
                  onClick={handleForget}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground/50 transition-colors hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                  title="Clear saved preferences"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  Forget
                </button>
              </div>
              <div className="flex items-center gap-3">
                {/* Audio mode badge */}
                <span
                  className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                  style={{ background: activeMode.bg, color: activeMode.text }}
                >
                  {audioMode === "online"
                    ? <Monitor className="h-3 w-3" />
                    : <Mic className="h-3 w-3" />
                  }
                  {audioMode === "online" ? "Online" : "In-Person"}
                </span>
                {/* Scenario badge */}
                <span className="rounded-full border border-border/30 bg-accent/20 px-2.5 py-1 text-xs font-medium text-foreground/80">
                  {scenarioName}
                </span>
                {/* REC badge */}
                {recordingEnabled && (
                  <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive ring-1 ring-destructive/20">
                    <span className="h-1 w-1 rounded-full bg-destructive animate-pulse" />
                    REC
                  </span>
                )}
              </div>
            </div>

            {/* Big start button */}
            <button
              onClick={handleStart}
              className="group w-full flex items-center justify-center gap-2.5 rounded-xl bg-primary py-3.5 font-semibold text-white shadow-md shadow-primary/20 transition-all duration-150 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-px active:translate-y-px active:scale-[0.98] cursor-pointer"
            >
              <Play className="h-4 w-4 ml-0.5" fill="white" />
              <span className="text-sm">Start Meeting</span>
            </button>

            {/* Change settings link */}
            <button
              onClick={() => setIsExpanded(true)}
              className="w-full text-center text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
            >
              Change settings
            </button>
          </div>
        ) : (
          /* ── FULL SELECTION VIEW ── */
          <div className="px-5 py-4 space-y-5">

            {/* ── Audio Mode Cards ── */}
            <div>
              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Audio Mode
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {/* Online card */}
                <button
                  onClick={() => setAudioMode("online")}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-all duration-150 cursor-pointer ${
                    audioMode === "online"
                      ? "border-[#4a6cf7]/40 bg-[rgba(74,108,247,0.08)] shadow-sm"
                      : "border-border/30 bg-secondary/10 hover:border-border/50 hover:bg-secondary/20"
                  }`}
                  aria-pressed={audioMode === "online"}
                >
                  {audioMode === "online" && (
                    <div
                      className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full"
                      style={{ background: onlineColors.text }}
                    />
                  )}
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{
                      background: audioMode === "online" ? onlineColors.bg : "rgba(255,255,255,0.04)",
                    }}
                  >
                    <Monitor
                      className="h-4 w-4"
                      style={{ color: audioMode === "online" ? onlineColors.text : "currentColor" }}
                    />
                  </div>
                  <div>
                    <div className={`text-xs font-semibold ${audioMode === "online" ? "" : "text-foreground/80"}`}
                      style={audioMode === "online" ? { color: onlineColors.text } : undefined}
                    >
                      Online
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 leading-tight mt-0.5">
                      Mic + system audio
                    </div>
                  </div>
                </button>

                {/* In-Person card */}
                <button
                  onClick={() => setAudioMode("in_person")}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-all duration-150 cursor-pointer ${
                    audioMode === "in_person"
                      ? "border-[#a855f7]/40 bg-[rgba(168,85,247,0.08)] shadow-sm"
                      : "border-border/30 bg-secondary/10 hover:border-border/50 hover:bg-secondary/20"
                  }`}
                  aria-pressed={audioMode === "in_person"}
                >
                  {audioMode === "in_person" && (
                    <div
                      className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full"
                      style={{ background: inPersonColors.text }}
                    />
                  )}
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{
                      background: audioMode === "in_person" ? inPersonColors.bg : "rgba(255,255,255,0.04)",
                    }}
                  >
                    <Mic
                      className="h-4 w-4"
                      style={{ color: audioMode === "in_person" ? inPersonColors.text : "currentColor" }}
                    />
                  </div>
                  <div>
                    <div
                      className={`text-xs font-semibold ${audioMode === "in_person" ? "" : "text-foreground/80"}`}
                      style={audioMode === "in_person" ? { color: inPersonColors.text } : undefined}
                    >
                      In-Person
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 leading-tight mt-0.5">
                      Mic only, shared room
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* ── Scenario Picker ── */}
            <div>
              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Scenario
              </p>
              <div className="relative">
                <button
                  onClick={() => setShowScenarioPicker((v) => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-border/30 bg-secondary/10 px-3.5 py-2.5 text-sm font-medium text-foreground transition-all duration-150 hover:bg-secondary/20 hover:border-border/50 cursor-pointer"
                >
                  <span>{scenarioName}</span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground/60 transition-transform duration-150 ${showScenarioPicker ? "rotate-180" : ""}`}
                  />
                </button>

                {showScenarioPicker && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[224px] overflow-y-auto rounded-xl border border-border/40 bg-card shadow-xl">
                    {scenarios.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setScenario(s.id as AIScenario);
                          setShowScenarioPicker(false);
                        }}
                        className={`flex w-full flex-col items-start px-4 py-2.5 text-left transition-colors duration-100 cursor-pointer ${
                          scenario === s.id
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-accent/50 text-foreground"
                        }`}
                      >
                        <span className="text-xs font-semibold">{s.name}</span>
                        <span className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                          {s.description}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Recording Toggle ── */}
            <div className={`flex items-center justify-between rounded-xl border p-3 transition-all duration-150 ${
              recordingEnabled
                ? "border-destructive/20 bg-destructive/[0.04]"
                : "border-border/30 bg-secondary/10"
            }`}>
              <div className="flex items-center gap-2.5">
                <div className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${
                  recordingEnabled
                    ? "bg-destructive shadow-[0_0_6px_rgba(239,68,68,0.5)]"
                    : "bg-muted-foreground/30"
                }`} />
                <div>
                  <p className="text-xs font-semibold text-foreground/80">Record Audio</p>
                  <p className="text-[10px] text-muted-foreground/60 leading-tight mt-0.5">
                    Save as file for playback
                  </p>
                </div>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={recordingEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    setRecordingEnabledStore(enabled);
                    try {
                      await setRecordingEnabled(enabled);
                    } catch (err) {
                      console.error("Failed to toggle recording:", err);
                    }
                  }}
                  className="peer sr-only"
                />
                <div className={`h-5 w-9 rounded-full transition-colors duration-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:duration-200 peer-checked:after:translate-x-full ${
                  recordingEnabled ? "bg-destructive" : "bg-muted-foreground/20"
                }`} />
              </label>
            </div>

            {/* ── Remember checkbox ── */}
            <button
              onClick={() => setRemember((v) => !v)}
              className="flex items-center gap-2.5 w-full cursor-pointer group"
              role="checkbox"
              aria-checked={remember}
            >
              {remember
                ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                : <Square className="h-4 w-4 text-muted-foreground/50 shrink-0 group-hover:text-muted-foreground transition-colors" />
              }
              <span className="text-xs text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
                Remember these settings for next time
              </span>
            </button>

            {/* ── Action buttons ── */}
            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={handleStart}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary py-3 font-semibold text-white shadow-md shadow-primary/20 transition-all duration-150 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-px active:translate-y-px active:scale-[0.98] cursor-pointer"
              >
                <Play className="h-4 w-4 ml-0.5" fill="white" />
                <span className="text-sm">Start Meeting</span>
              </button>
              <button
                onClick={onCancel}
                className="w-full rounded-xl border border-border/30 bg-secondary/20 py-2 text-xs font-medium text-muted-foreground transition-all duration-150 hover:bg-secondary/40 hover:text-foreground active:scale-[0.98] cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
