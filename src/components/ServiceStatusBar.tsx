// Shared service status bar used in both Dashboard and Meeting Overlay footers.
// Shows LLM, You STT, and Them STT with provider + model, lighting up when active.
// During recording: STT chips are interactive (click to swap provider), with mute toggles.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Brain, Mic, MicOff, Volume2, VolumeX, Zap, Cpu,
  ChevronUp, CheckCircle, Globe, Monitor, HardDrive, Cloud, ArrowUpCircle,
} from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { hasApiKey, listLocalSTTEngines, getApiKey } from "../lib/ipc";
import type { STTProviderType, LLMProviderType, LocalSTTEngineInfo } from "../lib/types";
import { showToast } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { useAgentStore } from "../stores/agentStore";
import { AgentStatusChip } from "./AgentStatusChip";
import { StreamLatency } from "./StreamLatency";
import { claudeTierLabel } from "../settings/ClaudeCliSettings";
import { restartToUpdate } from "../hooks/useUpdater";

// ── Human-friendly provider labels ──
const LLM_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  custom: "Custom",
  claude_cli: "Claude",
};

export const STT_LABELS: Record<string, string> = {
  web_speech: "Web Speech",
  whisper_cpp: "Whisper.cpp",
  deepgram: "Deepgram",
  whisper_api: "Whisper API",
  azure_speech: "Azure",
  groq_whisper: "Groq STT",
  cartesia: "Cartesia",
  sherpa_onnx: "Sherpa-ONNX",
  ort_streaming: "ORT Streaming",
  parakeet_tdt: "Parakeet TDT",
  windows_native: "Windows Speech",
};

// ── STT provider options for the quick-swap picker ──
// Mirrors MeetingAudioSettings.tsx STT_OPTIONS — same availability rules apply.
const STT_PROVIDER_OPTIONS: {
  value: STTProviderType;
  label: string;
  IconComponent: React.ComponentType<{ className?: string }>;
  requiresKey: boolean;
  isCloud: boolean;
  inputOnly?: boolean;
  requiresDownload?: string;
}[] = [
  { value: "web_speech", label: "Web Speech", IconComponent: Globe, requiresKey: false, isCloud: false, inputOnly: true },
  { value: "windows_native", label: "Windows Speech", IconComponent: Monitor, requiresKey: false, isCloud: false, inputOnly: true },
  { value: "sherpa_onnx", label: "Sherpa-ONNX", IconComponent: HardDrive, requiresKey: false, isCloud: false, requiresDownload: "sherpa_onnx" },
  { value: "ort_streaming", label: "ORT Streaming", IconComponent: Zap, requiresKey: false, isCloud: false, requiresDownload: "ort_streaming" },
  { value: "parakeet_tdt", label: "Parakeet TDT", IconComponent: Cpu, requiresKey: false, isCloud: false, requiresDownload: "parakeet_tdt" },
  { value: "deepgram", label: "Deepgram", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "whisper_api", label: "Whisper API", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "azure_speech", label: "Azure Speech", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "groq_whisper", label: "Groq Whisper", IconComponent: Zap, requiresKey: true, isCloud: true },
  { value: "cartesia", label: "Cartesia", IconComponent: Cloud, requiresKey: true, isCloud: true },
];

// ── Web Speech / Windows Speech mutual exclusion ──
// These providers capture from the OS default mic via a single SpeechRecognition instance.
// Only one can be active across both parties at any time.
const EXCLUSIVE_PROVIDERS: STTProviderType[] = ["web_speech", "windows_native"];

const EXCLUSIVE_FALLBACK_ORDER: STTProviderType[] = [
  "deepgram", "groq_whisper", "whisper_api", "azure_speech", "cartesia",
  "sherpa_onnx", "ort_streaming", "parakeet_tdt",
];

function isExclusiveProvider(provider: string): boolean {
  return EXCLUSIVE_PROVIDERS.includes(provider as STTProviderType);
}

// ── LLM provider options for quick-swap ──
const LLM_PROVIDER_OPTIONS: {
  value: LLMProviderType;
  label: string;
  IconComponent: React.ComponentType<{ className?: string }>;
  requiresKey: boolean;
  isLocal: boolean;
}[] = [
  { value: "ollama", label: "Ollama", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "lm_studio", label: "LM Studio", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "openai", label: "OpenAI", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "anthropic", label: "Anthropic", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "groq", label: "Groq", IconComponent: Zap, requiresKey: true, isLocal: false },
  { value: "gemini", label: "Gemini", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "openrouter", label: "OpenRouter", IconComponent: Globe, requiresKey: true, isLocal: false },
  { value: "custom", label: "Custom", IconComponent: HardDrive, requiresKey: false, isLocal: false },
];

function formatModel(model: string): string {
  if (!model) return "—";
  const afterSlash = model.split("/").pop() || model;
  return afterSlash.split(":")[0] || afterSlash;
}

function formatSttModel(modelId: string): string {
  if (!modelId) return "";
  return modelId
    .replace(/^sherpa-onnx-nemo-/, "")
    .replace(/^sherpa-onnx-/, "")
    .replace(/^parakeet-/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")  // Strip date suffix
    .replace(/-int8$/, "")
    .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatSttLabel(provider: string, localModelId?: string): { provider: string; model: string } {
  const providerLabel = STT_LABELS[provider] || provider;
  const localProviders = ["whisper_cpp", "sherpa_onnx", "ort_streaming", "parakeet_tdt"];
  if (localProviders.includes(provider) && localModelId) {
    return { provider: providerLabel, model: formatSttModel(localModelId) };
  }
  return { provider: providerLabel, model: "" };
}

/**
 * Unified service status bar for both Dashboard footer and Meeting overlay footer.
 * Reads directly from Zustand stores so it reacts to settings changes immediately.
 *
 * `compact` — used in the meeting overlay (less padding, tighter spacing)
 *
 * During an active recording, STT chips become interactive:
 * - Click to open an upward dropdown to switch STT provider
 * - Mute toggle button to silence each audio source
 */
export function ServiceStatusBar({ compact = false }: { compact?: boolean }) {
  // Config (reactive)
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);
  const activeModelPerEngine = useConfigStore((s) => s.activeModelPerEngine);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  // Active state
  const isRecording = useMeetingStore((s) => s.isRecording);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const speakerOrder = useSpeakerStore((s) => s.speakerOrder);
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const streamProvider = useStreamStore((s) => s.currentProvider);
  const streamModel = useStreamStore((s) => s.currentModel);
  const { micLevel, systemLevel } = useAudioLevel();

  // Mute state (session-only, not persisted)
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);

  // Picker state (LLM or STT)
  const [pickerOpen, setPickerOpen] = useState<"llm" | "you" | "them" | null>(null);
  const activateLLMProvider = useConfigStore((s) => s.activateLLMProvider);

  // ── Derive display values ──
  // While an answer streams, name what serves it (it can be a fallback);
  // otherwise the active provider. The stream store keeps the last stream's
  // provider until the meeting ends, so it must not outlive the stream.
  const shownProvider = (isStreaming && streamProvider) || llmProvider;
  const shownModel = (isStreaming && streamModel) || llmModel;
  const llmProviderLabel = LLM_LABELS[shownProvider] || shownProvider;
  const llmModelLabel = formatModel(shownModel);

  const DEFAULT_MODEL_PER_ENGINE: Record<string, string> = {
    sherpa_onnx: "streaming-zipformer-en-20M",
    ort_streaming: "zipformer-en-20M",
    parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
  };

  const youSttProvider = meetingAudioConfig?.you.stt_provider ?? "web_speech";
  const youLocalModel = meetingAudioConfig?.you.local_model_id
    || activeModelPerEngine[youSttProvider]
    || DEFAULT_MODEL_PER_ENGINE[youSttProvider]
    || (youSttProvider === "whisper_cpp" ? activeWhisperModel : undefined);
  const youStt = formatSttLabel(youSttProvider, youLocalModel || undefined);
  const youActive = isRecording && !mutedYou && micLevel > 0.02;

  const themSttProvider = meetingAudioConfig?.them.stt_provider ?? "—";
  const themLocalModel = meetingAudioConfig?.them.local_model_id
    || activeModelPerEngine[themSttProvider]
    || DEFAULT_MODEL_PER_ENGINE[themSttProvider]
    || (themSttProvider === "whisper_cpp" ? activeWhisperModel : undefined);
  const themStt = formatSttLabel(themSttProvider, themLocalModel || undefined);
  const themActive = isRecording && !mutedThem && systemLevel > 0.02;

  // ── Provider change handler ──
  // Updates meetingAudioConfig; useAudioConfigSync automatically restarts capture.
  const handleProviderChange = useCallback((party: "you" | "them", provider: STTProviderType) => {
    if (!meetingAudioConfig) return;
    const updates: Partial<typeof meetingAudioConfig.you> = { stt_provider: provider };
    if (provider === "sherpa_onnx" || provider === "ort_streaming" || provider === "parakeet_tdt") {
      const activeModelPerEngine = useConfigStore.getState().activeModelPerEngine;
      const engineModel = activeModelPerEngine[provider]
        ?? DEFAULT_MODEL_PER_ENGINE[provider]
        ?? useConfigStore.getState().activeWhisperModel;
      if (engineModel) updates.local_model_id = engineModel;
    }
    setMeetingAudioConfig({
      ...meetingAudioConfig,
      [party]: { ...meetingAudioConfig[party], ...updates },
      preset_name: null,
    });
    setPickerOpen(null);
  }, [meetingAudioConfig, setMeetingAudioConfig]);

  return (
    <div className={`flex flex-wrap items-center gap-2.5 ${compact ? "px-3 py-2" : "px-5 py-2.5"}`}>
      {/* LLM — always interactive */}
      <div className="relative">
        {llmProvider === "claude_cli" ? (
          <AgentStatusChip
            compact={compact}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
          />
        ) : (
          <STTChip
            icon={<Brain className="h-3.5 w-3.5" />}
            provider={llmProviderLabel}
            model={llmModelLabel}
            active={isStreaming}
            color="blue"
            label=""
            muted={false}
            interactive={true}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
            tooltip={`LLM: ${llmProviderLabel} / ${llmModelLabel}`}
          />
        )}
        {pickerOpen === "llm" && (
          <LLMPickerDropdown
            currentProvider={llmProvider}
            currentModel={llmModel}
            onApply={async (provider, model) => {
              try {
                await activateLLMProvider(provider as LLMProviderType, { model });
              } catch (e) {
                console.warn("[ServiceStatusBar] Failed to switch LLM:", e);
                showToast(`Couldn't switch the AI provider: ${e instanceof Error ? e.message : String(e)}`, "error");
              }
              setPickerOpen(null);
            }}
            onClose={() => setPickerOpen(null)}
          />
        )}
      </div>

      <Divider />

      {audioMode === "in_person" ? (
        /* In-Person mode: single Room STT indicator + speaker count */
        <div className="flex items-center gap-2">
          <div className="relative">
            <STTChip
              icon={<Mic className="h-3.5 w-3.5" />}
              provider={themStt.provider}
              model={themStt.model}
              active={themActive || youActive}
              color="purple"
              label="ROOM"
              muted={mutedThem}
              interactive={isRecording}
              pickerOpen={pickerOpen === "them"}
              onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
              tooltip={`Room STT: ${themStt.provider}${themStt.model ? ` / ${themStt.model}` : ""}`}
            />
            {pickerOpen === "them" && (
              <STTPickerDropdown
                currentProvider={themSttProvider as STTProviderType}
                isInput={meetingAudioConfig?.them.is_input_device ?? false}
                onSelect={(p) => handleProviderChange("them", p)}
                onClose={() => setPickerOpen(null)}
                otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
                otherPartyLabel="You"
              />
            )}
          </div>
          <span className="text-xs text-muted-foreground/60">
            {speakerOrder.length > 0
              ? `${speakerOrder.length} speaker${speakerOrder.length !== 1 ? "s" : ""} detected`
              : ""}
          </span>
        </div>
      ) : (
        <>
          {/* Online mode: You STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Mic className="h-3.5 w-3.5" />}
                provider={youStt.provider}
                model={youStt.model}
                active={youActive}
                color="sky"
                label="You"
                muted={mutedYou}
                interactive={isRecording}
                pickerOpen={pickerOpen === "you"}
                onClick={() => setPickerOpen(pickerOpen === "you" ? null : "you")}
                tooltip={`Your STT: ${youStt.provider}${youStt.model ? ` / ${youStt.model}` : ""}`}
              />
              {pickerOpen === "you" && (
                <STTPickerDropdown
                  currentProvider={youSttProvider as STTProviderType}
                  isInput={meetingAudioConfig?.you.is_input_device ?? true}
                  onSelect={(p) => handleProviderChange("you", p)}
                  onClose={() => setPickerOpen(null)}
                  otherPartyProvider={meetingAudioConfig?.them.stt_provider ?? null}
                  otherPartyLabel="Them"
                />
              )}
            </div>
            {isRecording && (
              <MuteButton type="mic" muted={mutedYou} onToggle={toggleMuteYou} label="You" />
            )}
          </div>

          <Divider />

          {/* Online mode: Them STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Volume2 className="h-3.5 w-3.5" />}
                provider={themStt.provider}
                model={themStt.model}
                active={themActive}
                color="amber"
                label="Them"
                muted={mutedThem}
                interactive={isRecording}
                pickerOpen={pickerOpen === "them"}
                onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
                tooltip={`Their STT: ${themStt.provider}${themStt.model ? ` / ${themStt.model}` : ""}`}
          />
          {pickerOpen === "them" && (
            <STTPickerDropdown
              currentProvider={themSttProvider as STTProviderType}
              isInput={meetingAudioConfig?.them.is_input_device ?? false}
              onSelect={(p) => handleProviderChange("them", p)}
              onClose={() => setPickerOpen(null)}
              otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
              otherPartyLabel="You"
            />
          )}
            </div>
            {isRecording && (
              <MuteButton type="speaker" muted={mutedThem} onToggle={toggleMuteThem} label="Them" />
            )}
          </div>
        </>
      )}

      {/* Latency: live timer while an answer streams, then the last answer's time */}
      <StreamLatency divider={<Divider />} />

      {/* Update ready — launcher footer only (the updater runs in the launcher) */}
      {!compact && <UpdatePill />}
    </div>
  );
}

// ── Update Pill ────────────────────────────────────────────────────

function UpdatePill() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const [installing, setInstalling] = useState(false);

  if (phase !== "ready" || !version) return null;

  const handleClick = async () => {
    setInstalling(true);
    try {
      await restartToUpdate();
    } finally {
      // Only reached if the user cancelled or the install failed.
      setInstalling(false);
    }
  };

  return (
    <>
      <Divider />
      <button
        onClick={handleClick}
        disabled={installing}
        title={`Restart NexQ to install v${version}`}
        className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
      >
        <ArrowUpCircle className="h-3 w-3" />
        <span>Update ready · v{version}</span>
        <span className="text-primary/50">—</span>
        <span className="font-semibold">{installing ? "Restarting…" : "Restart"}</span>
      </button>
    </>
  );
}

// ── Color Map ──────────────────────────────────────────────────────

const COLOR_MAP = {
  blue: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  sky: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  amber: {
    active: "text-warning",
    dot: "bg-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
    glow: "shadow-warning/20",
  },
  purple: {
    active: "text-purple-400",
    dot: "bg-purple-400",
    bg: "bg-purple-400/10",
    border: "border-purple-400/20",
    glow: "shadow-purple-400/20",
  },
} as const;

// ── Service Chip (display-only, used for LLM) ──────────────────────

function ServiceChip({
  icon,
  provider,
  model,
  active,
  color,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        active
          ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
          : "bg-secondary/30 border border-transparent"
      }`}
      title={tooltip}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${active ? c.active : "text-muted-foreground/60"}`}>
        {icon}
      </span>

      {/* Text */}
      <div className="flex items-center gap-1 min-w-0">
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && (
          <span className={`text-meta truncate max-w-[70px] transition-colors duration-200 ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>
    </div>
  );
}

// ── STT Chip (interactive during recording) ─────────────────────────

function STTChip({
  icon,
  provider,
  model,
  active,
  color,
  label,
  muted,
  interactive,
  pickerOpen,
  onClick,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  label: string;
  muted: boolean;
  interactive: boolean;
  pickerOpen: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        muted
          ? "bg-destructive/5 border border-destructive/10"
          : active
            ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
            : "bg-secondary/30 border border-transparent"
      } ${interactive ? "cursor-pointer hover:brightness-110" : ""}`}
      title={tooltip}
      onClick={interactive ? onClick : undefined}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && !muted && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          muted ? "bg-destructive/50" : active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${
        muted ? "text-destructive/60" : active ? c.active : "text-muted-foreground/60"
      }`}>
        {icon}
      </span>

      {/* Text */}
      <div className="flex items-center gap-1 min-w-0">
        {label && (
          <span className={`shrink-0 text-meta font-semibold uppercase tracking-wide transition-colors duration-200 ${
            muted ? "text-destructive/50" : active ? c.active : "text-muted-foreground/60"
          }`}>
            {label}
          </span>
        )}
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          muted ? "text-destructive/50 line-through" : active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && !muted && (
          <span className={`text-meta truncate max-w-[70px] transition-colors duration-200 ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>

      {/* Chevron — visible only when interactive */}
      {interactive && (
        <ChevronUp className={`h-2.5 w-2.5 shrink-0 transition-all duration-200 ${
          pickerOpen ? "text-foreground/60 rotate-0" : "text-muted-foreground/50 rotate-180"
        }`} />
      )}
    </div>
  );
}

// ── Mute Button ─────────────────────────────────────────────────────

function MuteButton({
  type,
  muted,
  onToggle,
  label,
}: {
  type: "mic" | "speaker";
  muted: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onToggle}
      className={`shrink-0 rounded-full p-1 transition-all duration-150 cursor-pointer ${
        muted
          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "text-muted-foreground/60 hover:text-foreground/70 hover:bg-accent/40"
      }`}
      title={muted ? `Unmute ${label}` : `Mute ${label}`}
    >
      {type === "mic"
        ? (muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />)
        : (muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />)
      }
    </button>
  );
}

// ── STT Provider Picker Dropdown (opens upward from footer) ─────────

function STTPickerDropdown({
  currentProvider,
  isInput,
  onSelect,
  onClose,
  otherPartyProvider,
  otherPartyLabel,
}: {
  currentProvider: STTProviderType;
  isInput: boolean;
  onSelect: (provider: STTProviderType) => void;
  onClose: () => void;
  otherPartyProvider: STTProviderType | null;
  otherPartyLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [stealTarget, setStealTarget] = useState<STTProviderType | null>(null);

  // Load availability data on mount (lazy — only when dropdown opens)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloudProviders = ["deepgram", "whisper_api", "azure_speech", "groq_whisper", "cartesia"];
        const [engines, ...keyResults] = await Promise.all([
          listLocalSTTEngines(),
          ...cloudProviders.map(async (p) => {
            try { return { p, ok: await hasApiKey(p) }; }
            catch { return { p, ok: false }; }
          }),
        ]);
        if (cancelled) return;
        setLocalEngines(engines);
        const status: Record<string, boolean> = {};
        for (const k of keyResults) status[k.p] = k.ok;
        setApiKeyStatus(status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Click outside to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  function isLocalEngineReady(engineId: string): boolean {
    const eng = localEngines.find((e) => e.engine === engineId);
    if (!eng) return false;
    return eng.models.some((m) => !m.id.startsWith("binary-") && m.is_downloaded);
  }

  function isAvailable(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    if (opt.inputOnly && !isInput) return false;
    if (opt.requiresDownload) return isLocalEngineReady(opt.requiresDownload);
    // Assume available if key status hasn't loaded yet — prevents false fallbacks
    if (opt.requiresKey) return apiKeyStatus[opt.value] ?? true;
    return true;
  }

  function isExclusiveLocked(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    if (!isExclusiveProvider(opt.value)) return false;
    if (!otherPartyProvider) return false;
    return isExclusiveProvider(otherPartyProvider);
  }

  function findExclusiveFallback(): STTProviderType | null {
    for (const provider of EXCLUSIVE_FALLBACK_ORDER) {
      const opt = STT_PROVIDER_OPTIONS.find((o) => o.value === provider);
      if (opt && isAvailable(opt)) return provider;
    }
    return null;
  }

  function handleStealConfirm() {
    if (!stealTarget) return;
    const freshConfig = useConfigStore.getState().meetingAudioConfig;
    if (!freshConfig) return;

    const thisRole = freshConfig.you.stt_provider === otherPartyProvider ? "them" : "you";
    const otherRole = thisRole === "you" ? "them" : "you";
    const otherStillExclusive = isExclusiveProvider(freshConfig[otherRole].stt_provider);

    if (!otherStillExclusive) {
      onSelect(stealTarget);
      setStealTarget(null);
      onClose();
      return;
    }

    const fallback = findExclusiveFallback();
    if (!fallback) {
      showToast("No fallback STT engine available. Configure an API key or download a local model first.", "error");
      setStealTarget(null);
      return;
    }

    const updatedConfig = { ...freshConfig };
    updatedConfig[thisRole] = {
      ...updatedConfig[thisRole],
      stt_provider: stealTarget,
      local_model_id: undefined,
    };
    updatedConfig[otherRole] = {
      ...updatedConfig[otherRole],
      stt_provider: fallback,
      local_model_id: undefined,
    };
    useConfigStore.getState().setMeetingAudioConfig(updatedConfig);

    const stealLabel = STT_PROVIDER_OPTIONS.find((o) => o.value === stealTarget)?.label ?? stealTarget;
    const fallbackLabel = STT_PROVIDER_OPTIONS.find((o) => o.value === fallback)?.label ?? fallback;
    showToast(
      `${stealLabel} moved to ${thisRole === "you" ? "You" : "Them"}. ${otherRole === "you" ? "You" : "Them"} fell back to ${fallbackLabel}.`,
      "info"
    );

    setStealTarget(null);
    onClose();
  }

  const localOpts = STT_PROVIDER_OPTIONS.filter((o) => !o.isCloud && isAvailable(o));
  const cloudOpts = STT_PROVIDER_OPTIONS.filter((o) => o.isCloud && isAvailable(o));

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl border border-border/30 bg-popover/90 backdrop-blur-md shadow-2xl z-50 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {loading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Loading providers...</div>
      ) : (
        <>
          {localOpts.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <HardDrive className="h-2.5 w-2.5 text-emerald-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Local & Built-in
                </span>
              </div>
              {localOpts.map((opt) => {
                const Icon = opt.IconComponent;
                const selected = currentProvider === opt.value;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onSelect(opt.value);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-emerald-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">In use by {otherPartyLabel}</span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {cloudOpts.length > 0 && (
            <div className={localOpts.length > 0 ? "border-t border-border/20" : ""}>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <Cloud className="h-2.5 w-2.5 text-blue-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Cloud
                </span>
              </div>
              {cloudOpts.map((opt) => {
                const Icon = opt.IconComponent;
                const selected = currentProvider === opt.value;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onSelect(opt.value);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-blue-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">In use by {otherPartyLabel}</span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {localOpts.length === 0 && cloudOpts.length === 0 && (
            <p className="px-4 py-3 text-meta text-muted-foreground/60">
              No providers available — configure in Settings
            </p>
          )}

          {stealTarget && (
            <div className="border-t border-border/20 bg-amber-500/5 px-3 py-2.5">
              <p className="text-meta leading-relaxed text-amber-200/80 mb-2">
                <span className="font-semibold text-amber-400">
                  {STT_PROVIDER_OPTIONS.find((o) => o.value === stealTarget)?.label}
                </span>{" "}
                can only run on one source at a time. Switch to this party?
                The other party will fall back to{" "}
                <span className="font-medium">
                  {(() => {
                    const fb = findExclusiveFallback();
                    return fb ? (STT_PROVIDER_OPTIONS.find((o) => o.value === fb)?.label ?? fb) : "no available engine";
                  })()}
                </span>.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleStealConfirm}
                  className="rounded-lg bg-amber-500/20 border border-amber-500/30 px-3 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                >
                  Switch
                </button>
                <button
                  type="button"
                  onClick={() => setStealTarget(null)}
                  className="rounded-lg bg-muted/30 px-3 py-1 text-meta font-medium text-muted-foreground hover:bg-muted/50 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── LLM Provider + Model Picker (single interaction, opens upward) ───
// Shows verified providers, loads models inline when provider is picked.
// User selects provider → models load → user picks model → dropdown closes.

const EMBEDDING_PATTERNS = [
  "embed", "all-minilm", "nomic-embed", "bge-",
  "text-embedding", "snowflake-arctic", "jina-embedding",
];

function LLMPickerDropdown({
  currentProvider,
  currentModel,
  onApply,
  onClose,
}: {
  currentProvider: string;
  currentModel: string;
  onApply: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const verifiedProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const claudeCliConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const claudeStatus = useAgentStore((s) => s.status);
  const refreshClaudeStatus = useAgentStore((s) => s.refreshStatus);

  // Detect Claude once per window so a logged-in CLI shows up here.
  useEffect(() => {
    if (!useAgentStore.getState().status) refreshClaudeStatus();
  }, [refreshClaudeStatus]);
  const claudeAvailable = currentProvider === "claude_cli" || !!claudeStatus?.auth?.logged_in;

  // Internal state: pending provider (may differ from active while browsing)
  const [pendingProvider, setPendingProvider] = useState(currentProvider);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Load models when pending provider changes (Claude has none to pick:
  // Fast / Deep come from its settings)
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    if (pendingProvider === "claude_cli") {
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    (async () => {
      try {
        const { listModels } = await import("../lib/ipc");
        const key = await getApiKey(pendingProvider).catch(() => null);
        const config = JSON.stringify({
          provider_type: pendingProvider,
          ...(key && { api_key: key }),
        });
        const modelList = await listModels(config);
        if (cancelled) return;
        const chatModels = modelList.filter(
          (m: { id: string }) => !EMBEDDING_PATTERNS.some((p) => m.id.toLowerCase().includes(p))
        );
        setModels(chatModels.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id })));
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pendingProvider]);

  // Click outside / Escape to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Only show verified/ready providers
  const available = LLM_PROVIDER_OPTIONS.filter((o) => {
    if (o.value === "custom") return false;
    if (o.requiresKey) return verifiedProviders.includes(o.value);
    return verifiedProviders.includes(o.value); // Local also needs verification
  });
  // Fallback: always include the current active provider
  if (!available.some((o) => o.value === currentProvider)) {
    const opt = LLM_PROVIDER_OPTIONS.find((o) => o.value === currentProvider);
    if (opt) available.unshift(opt);
  }

  const localOpts = available.filter((o) => o.isLocal);
  const cloudOpts = available.filter((o) => !o.isLocal);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 min-w-[240px] rounded-xl border border-border/30 bg-popover/90 backdrop-blur-md shadow-2xl z-50 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {/* ── Provider section ── */}
      {localOpts.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <HardDrive className="h-2.5 w-2.5 text-emerald-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">Local</span>
          </div>
          {localOpts.map((opt) => {
            const Icon = opt.IconComponent;
            const isPending = pendingProvider === opt.value;
            const isActive = currentProvider === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setPendingProvider(opt.value)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                  isPending ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${isPending ? "text-primary" : "text-emerald-400"}`} />
                <span className="flex-1 text-left font-medium">{opt.label}</span>
                {isActive && <span className="text-meta text-primary/80">active</span>}
              </button>
            );
          })}
        </div>
      )}

      {cloudOpts.length > 0 && (
        <div className={localOpts.length > 0 ? "border-t border-border/20" : ""}>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Cloud className="h-2.5 w-2.5 text-blue-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">Cloud</span>
          </div>
          {cloudOpts.map((opt) => {
            const Icon = opt.IconComponent;
            const isPending = pendingProvider === opt.value;
            const isActive = currentProvider === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setPendingProvider(opt.value)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                  isPending ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${isPending ? "text-primary" : "text-blue-400"}`} />
                <span className="flex-1 text-left font-medium">{opt.label}</span>
                {isActive && <span className="text-meta text-primary/80">active</span>}
              </button>
            );
          })}
        </div>
      )}

      {claudeAvailable && (
        <div className={available.length > 0 ? "border-t border-border/20" : ""}>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Cpu className="h-2.5 w-2.5 text-muted-foreground" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">Subscription</span>
          </div>
          <button
            onClick={() => setPendingProvider("claude_cli")}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
              pendingProvider === "claude_cli" ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
            }`}
          >
            <Brain className={`h-3.5 w-3.5 shrink-0 ${pendingProvider === "claude_cli" ? "text-primary" : "text-muted-foreground"}`} />
            <span className="flex-1 text-left font-medium">Claude</span>
            {currentProvider === "claude_cli" && <span className="text-meta text-primary/80">active</span>}
          </button>
        </div>
      )}

      {available.length === 0 && !claudeAvailable && (
        <div className="px-4 py-3 text-meta text-muted-foreground/60">
          No verified providers — test connection in Settings first
        </div>
      )}

      {/* ── Claude: no model list, Fast / Deep come from its settings ── */}
      {pendingProvider === "claude_cli" ? (
        <div className="border-t border-border/20">
          <button
            onClick={() => onApply("claude_cli", claudeCliConfig.fast_model)}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
              currentProvider === "claude_cli" ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
            }`}
          >
            <span className="flex-1 text-left">
              <span className="block font-medium">
                {currentProvider === "claude_cli" ? "Using Claude" : "Use Claude"}
              </span>
              <span className="block text-meta text-muted-foreground">
                Fast {claudeTierLabel(claudeCliConfig.fast_model, claudeCliConfig.fast_effort, claudeModels)}, Deep{" "}
                {claudeTierLabel(claudeCliConfig.deep_model, claudeCliConfig.deep_effort, claudeModels)}
              </span>
            </span>
            {currentProvider === "claude_cli" && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
          </button>
        </div>
      ) : (
        /* ── Model section (for pending provider) ── */
        <div className="border-t border-border/20">
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Brain className="h-2.5 w-2.5 text-violet-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
              Model — {LLM_LABELS[pendingProvider] || pendingProvider}
            </span>
            {modelsLoading && (
              <span className="text-meta text-muted-foreground/60 animate-pulse ml-auto">loading...</span>
            )}
          </div>
          {models.length > 0 ? (
            <div className="max-h-[160px] overflow-y-auto">
              {models.map((m) => {
                const isCurrentModel = currentProvider === pendingProvider && currentModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => onApply(pendingProvider, m.id)}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                      isCurrentModel ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <span className="flex-1 text-left font-medium truncate">{formatModel(m.id)}</span>
                    {isCurrentModel && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          ) : !modelsLoading ? (
            <div className="px-3 py-2 text-meta text-muted-foreground/60">
              No models available
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Divider ─────────────────────────────────────────────────────────

function Divider() {
  return <div className="h-4 w-px shrink-0 bg-border/20" />;
}
