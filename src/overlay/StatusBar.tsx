import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { showToast } from "../stores/toastStore";
import { useCallLogStore } from "../stores/callLogStore";
import { formatDuration } from "../lib/agentUsage";
import {
  Settings,
  Square,
  Activity,
  Brain,
  Mic,
  Volume2,
} from "lucide-react";
import { useCallback } from "react";

// STT provider short labels for compact display
const STT_SHORT_LABELS: Record<string, string> = {
  web_speech: "WebSpeech",
  whisper_cpp: "Whisper.cpp",
  windows_native: "WinSTT",
  deepgram: "Deepgram",
  whisper_api: "Whisper",
  azure_speech: "Azure",
  groq_whisper: "GroqSTT",
  cartesia: "Cartesia",
};

export function StatusBar() {
  const currentProvider = useStreamStore((s) => s.currentProvider);
  const currentModel = useStreamStore((s) => s.currentModel);
  const latencyMs = useStreamStore((s) => s.latencyMs);
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);

  // Audio levels for activity detection
  const { micLevel, systemLevel } = useAudioLevel();

  // Thresholds for "active" state — mic/system are picking up sound
  const micActive = micLevel > 0.02;
  const systemActive = systemLevel > 0.02;

  // LLM display info
  const displayProvider = currentProvider || llmProvider || "---";
  const displayModel = currentModel || llmModel || "---";

  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);

  // STT display info from meeting audio config — include model name for local engines
  const formatSTTLabel = (provider: string) => {
    const base = STT_SHORT_LABELS[provider] || provider;
    if (provider === "whisper_cpp" && activeWhisperModel) {
      return `${base}/${activeWhisperModel}`;
    }
    return base;
  };
  const youSTT = meetingAudioConfig
    ? formatSTTLabel(meetingAudioConfig.you.stt_provider)
    : "---";
  const themSTT = meetingAudioConfig
    ? formatSTTLabel(meetingAudioConfig.them.stt_provider)
    : "---";

  const handleEndMeeting = useCallback(async () => {
    try {
      await endMeetingFlow();
      showToast("Meeting ended", "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to end meeting";
      showToast(msg, "error");
    }
  }, [endMeetingFlow]);

  return (
    <div className="flex flex-col gap-1">
      {/* Row 1: Service indicators */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 text-meta text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          {/* LLM indicator */}
          <ServiceIndicator
            icon={<Brain className="h-2.5 w-2.5" />}
            label={`${displayProvider}/${displayModel.split("/").pop()?.split(":")[0] || displayModel}`}
            active={isStreaming}
            activeColor="text-info"
            title={`LLM: ${displayProvider} / ${displayModel}`}
          />

          <span className="text-border/30">|</span>

          {/* You STT indicator */}
          <ServiceIndicator
            icon={<Mic className="h-2.5 w-2.5" />}
            label={`You: ${youSTT}`}
            active={micActive}
            activeColor="text-speaker-user"
            title={`Your STT: ${youSTT} ${micActive ? "(receiving audio)" : "(silent)"}`}
          />

          <span className="text-border/30">|</span>

          {/* Them STT indicator */}
          <ServiceIndicator
            icon={<Volume2 className="h-2.5 w-2.5" />}
            label={`Them: ${themSTT}`}
            active={systemActive}
            activeColor="text-speaker-interviewer"
            title={`Their STT: ${themSTT} ${systemActive ? "(receiving audio)" : "(silent)"}`}
          />

          {/* Latency */}
          {(isStreaming || latencyMs != null) && (
            <>
              <span className="text-border/30">|</span>
              <span className="tabular-nums">
                {isStreaming ? (
                  <span className="animate-pulse text-primary/80">streaming</span>
                ) : (
                  formatDuration(latencyMs ?? 0)
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => useCallLogStore.getState().toggleOpen()}
            className="rounded-lg p-1.5 transition-colors duration-150 hover:bg-accent hover:text-foreground"
            title="AI Call Log"
            aria-label="Toggle AI call log"
          >
            <Activity className="h-3 w-3" />
          </button>
          <button
            onClick={() => setCurrentView("settings")}
            className="rounded-lg p-1.5 transition-colors duration-150 hover:bg-accent hover:text-foreground"
            title="Settings"
            aria-label="Open settings"
          >
            <Settings className="h-3 w-3" />
          </button>
          <button
            onClick={handleEndMeeting}
            className="flex items-center gap-1 rounded-lg bg-destructive/10 px-2.5 py-1 font-medium text-destructive/70 transition-all duration-150 hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label="End meeting"
          >
            <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
            End
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Service activity indicator component ------------------------------------

function ServiceIndicator({
  icon,
  label,
  active,
  activeColor,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  activeColor: string;
  title: string;
}) {
  return (
    <div
      className={`flex items-center gap-1 transition-colors duration-200 ${
        active ? activeColor : "text-muted-foreground/60"
      }`}
      title={title}
      role="status"
      aria-label={`${label}: ${active ? "active" : "inactive"}`}
    >
      {/* Activity dot */}
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
        {active && (
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-current opacity-40" />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${active ? "bg-current" : "bg-muted-foreground/30"}`} />
      </span>
      {icon}
      <span className="truncate max-w-[80px]">{label}</span>
    </div>
  );
}
