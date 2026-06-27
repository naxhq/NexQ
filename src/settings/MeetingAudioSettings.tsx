// Unified "Meeting Audio" settings tab — per-party device + STT configuration.
// Two-panel layout: YOU (left) | THEM (right), with monitor + sessions below.

import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useConfigStore } from "../stores/configStore";
import {
  listAudioDevices,
  setRecordingEnabled,
  getAudioSessions,
  hasApiKey,
  listLocalSTTEngines,
  startDeviceMonitor,
  stopDeviceMonitor,
  type DevicePeakLevel,
} from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import type {
  AudioDevice,
  AudioDeviceList,
  AudioSessionInfo,
  LocalSTTEngineInfo,
  MeetingAudioConfig,
  PartyAudioConfig,
  STTProviderType,
} from "../lib/types";
import {
  Mic,
  Volume2,
  RefreshCw,
  Monitor,
  Globe,
  HardDrive,
  Cloud,
  Zap,
  ChevronDown,
  CheckCircle,
  AlertTriangle,
  Cpu,
  Info,
} from "lucide-react";
import { BUILT_IN_PRESETS, type MeetingPreset, applyPreset } from "./presets";

// STT provider options — whisper_cpp excluded (batch-only, not for live STT)
const STT_OPTIONS: {
  value: STTProviderType;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  requiresKey: boolean;
  isCloud: boolean;
  inputOnly?: boolean;
  requiresDownload?: string;
}[] = [
  {
    value: "web_speech",
    label: "Web Speech",
    shortLabel: "Web Speech",
    icon: <Globe className="h-3.5 w-3.5" />,
    requiresKey: false,
    isCloud: false,
    inputOnly: true,
  },
  {
    value: "windows_native",
    label: "Windows Speech",
    shortLabel: "Windows Speech",
    icon: <Monitor className="h-3.5 w-3.5" />,
    requiresKey: false,
    isCloud: false,
    inputOnly: true,
  },
  {
    value: "sherpa_onnx",
    label: "Sherpa-ONNX",
    shortLabel: "Sherpa-ONNX",
    icon: <HardDrive className="h-3.5 w-3.5" />,
    requiresKey: false,
    isCloud: false,
    requiresDownload: "sherpa_onnx",
  },
  {
    value: "ort_streaming",
    label: "ORT Streaming",
    shortLabel: "ORT",
    icon: <Zap className="h-3.5 w-3.5" />,
    requiresKey: false,
    isCloud: false,
    requiresDownload: "ort_streaming",
  },
  {
    value: "parakeet_tdt",
    label: "Parakeet TDT (Best Local)",
    shortLabel: "Parakeet",
    icon: <Cpu className="h-3.5 w-3.5" />,
    requiresKey: false,
    isCloud: false,
    requiresDownload: "parakeet_tdt",
  },
  {
    value: "deepgram",
    label: "Deepgram",
    shortLabel: "Deepgram",
    icon: <Cloud className="h-3.5 w-3.5" />,
    requiresKey: true,
    isCloud: true,
  },
  {
    value: "whisper_api",
    label: "Whisper API",
    shortLabel: "Whisper API",
    icon: <Cloud className="h-3.5 w-3.5" />,
    requiresKey: true,
    isCloud: true,
  },
  {
    value: "azure_speech",
    label: "Azure Speech",
    shortLabel: "Azure",
    icon: <Cloud className="h-3.5 w-3.5" />,
    requiresKey: true,
    isCloud: true,
  },
  {
    value: "groq_whisper",
    label: "Groq Whisper",
    shortLabel: "Groq",
    icon: <Zap className="h-3.5 w-3.5" />,
    requiresKey: true,
    isCloud: true,
  },
];

// ── Web Speech / Windows Speech mutual exclusion ──
// These providers capture from the OS default mic via a single SpeechRecognition instance.
// Only one can be active across both parties at any time.
const EXCLUSIVE_PROVIDERS: STTProviderType[] = ["web_speech", "windows_native"];

const EXCLUSIVE_FALLBACK_ORDER: STTProviderType[] = [
  "deepgram", "groq_whisper", "whisper_api", "azure_speech",
  "sherpa_onnx", "ort_streaming", "parakeet_tdt",
];

const STT_LANGUAGES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "ja-JP", label: "Japanese" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "ko-KR", label: "Korean" },
  { value: "nl-NL", label: "Dutch" },
  { value: "hi-IN", label: "Hindi" },
  { value: "ru-RU", label: "Russian" },
  { value: "ar-SA", label: "Arabic" },
  { value: "tr-TR", label: "Turkish" },
  { value: "pl-PL", label: "Polish" },
  { value: "sv-SE", label: "Swedish" },
];

function isExclusiveProvider(provider: string): boolean {
  return EXCLUSIVE_PROVIDERS.includes(provider as STTProviderType);
}

// ── Party color config — must use full Tailwind class strings (no interpolation) ──
const PARTY_CONFIG = {
  you: {
    iconColor: "text-sky-400",
    iconBg: "bg-sky-500/10",
    border: "border-sky-500/20",
    headerGrad: "from-sky-500/10",
    dot: "bg-sky-400",
    ping: "bg-sky-400",
  },
  them: {
    iconColor: "text-amber-400",
    iconBg: "bg-amber-500/10",
    border: "border-amber-500/20",
    headerGrad: "from-amber-500/10",
    dot: "bg-amber-400",
    ping: "bg-amber-400",
  },
} as const;

export function MeetingAudioSettings() {
  const {
    meetingAudioConfig,
    setMeetingAudioConfig,
    micDeviceId,
    systemDeviceId,
    recordingEnabled,
  } = useConfigStore();
  const diarizationEnabled = useConfigStore((s) => s.diarizationEnabled);
  const setDiarizationEnabled = useConfigStore((s) => s.setDiarizationEnabled);
  const sttLanguage = useConfigStore((s) => s.sttLanguage);
  const setSTTLanguage = useConfigStore((s) => s.setSTTLanguage);

  const [devices, setDevices] = useState<AudioDeviceList>({
    inputs: [],
    outputs: [],
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [sessions, setSessions] = useState<AudioSessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);

  const [deviceLevels, setDeviceLevels] = useState<Record<string, number>>({});
  const [devicePeaks, setDevicePeaks] = useState<Record<string, number>>({});

  const config: MeetingAudioConfig = meetingAudioConfig ?? {
    you: {
      role: "You",
      device_id: micDeviceId ?? "default",
      is_input_device: true,
      stt_provider: "web_speech",
    },
    them: {
      role: "Them",
      device_id: systemDeviceId ?? "default",
      is_input_device: false,
      stt_provider: "deepgram",
    },
    recording_enabled: recordingEnabled,
    preset_name: null,
  };

  useEffect(() => {
    if (!meetingAudioConfig) {
      setMeetingAudioConfig(config);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadSessions();
    checkApiKeys();
    loadLocalEngines();
  }, []);

  // Device monitor: runs for the entire component lifetime, independent of recording state.
  // During recording, audio_level events supplement this with selected-source PCM levels.
  useEffect(() => {
    startDeviceMonitor().catch(() => {});

    const unlistenPromise = listen<DevicePeakLevel[]>("device_levels", (event) => {
      setDeviceLevels((prev) => {
        const next = { ...prev };
        for (const { device_id, level } of event.payload) {
          next[device_id] = level;
        }
        return next;
      });
      // Track peak per device with slow decay (used for peak markers on bars)
      setDevicePeaks((prev) => {
        const next = { ...prev };
        for (const { device_id, level } of event.payload) {
          const cur = next[device_id] ?? 0;
          next[device_id] = level > cur ? level : cur * 0.95;
        }
        return next;
      });
    });

    return () => {
      stopDeviceMonitor().catch(() => {});
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function loadDevices() {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);
    } catch (err) {
      console.error("Failed to load audio devices:", err);
    } finally {
      setLoadingDevices(false);
    }
  }

  async function loadSessions() {
    setLoadingSessions(true);
    try {
      const s = await getAudioSessions();
      setSessions(s);
    } catch (err) {
      console.error("Failed to load audio sessions:", err);
    } finally {
      setLoadingSessions(false);
    }
  }

  async function checkApiKeys() {
    const providers = ["deepgram", "whisper_api", "azure_speech", "groq_whisper"];
    const status: Record<string, boolean> = {};
    for (const p of providers) {
      try {
        status[p] = await hasApiKey(p);
      } catch {
        status[p] = false;
      }
    }
    setApiKeyStatus(status);
  }

  async function loadLocalEngines() {
    try {
      const data = await listLocalSTTEngines();
      setLocalEngines(data);
    } catch (err) {
      console.error("Failed to load local STT engines:", err);
    }
  }

  const updateParty = useCallback(
    (party: "you" | "them", updates: Partial<PartyAudioConfig>) => {
      const newConfig: MeetingAudioConfig = {
        ...config,
        [party]: { ...config[party], ...updates },
        preset_name: null,
      };
      setMeetingAudioConfig(newConfig);
    },
    [config, setMeetingAudioConfig]
  );

  async function handleRecordingToggle(enabled: boolean) {
    const newConfig = { ...config, recording_enabled: enabled };
    setMeetingAudioConfig(newConfig);
    try {
      await setRecordingEnabled(enabled);
      showToast(
        enabled ? "Audio recording enabled" : "Audio recording disabled",
        "success"
      );
    } catch (err) {
      console.error("Failed to set recording:", err);
      showToast("Failed to toggle recording", "error");
    }
  }

  function handlePresetSelect(preset: MeetingPreset) {
    const allDevices = [...devices.inputs, ...devices.outputs];
    const resolved = applyPreset(preset, allDevices);
    setMeetingAudioConfig(resolved);
    showToast(`Preset "${preset.name}" applied`, "success");
  }

  const allDevices: { device: AudioDevice; group: string }[] = [
    ...devices.inputs.map((d) => ({ device: d, group: "Microphones" })),
    ...devices.outputs.map((d) => ({ device: d, group: "Speakers / Output" })),
  ];

  return (
    <div className="flex flex-col gap-4">

      {/* ── Quick Presets ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/20 bg-card/40 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="mr-1 shrink-0 text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            Presets
          </span>
          {BUILT_IN_PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => handlePresetSelect(preset)}
              className={`cursor-pointer rounded-lg border px-3 py-1 text-xs font-medium transition-all duration-150 active:scale-95 ${
                config.preset_name === preset.name
                  ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/10"
                  : "border-border/30 text-muted-foreground/70 hover:border-border/60 hover:bg-accent/40 hover:text-foreground"
              }`}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
          STT Language
          <select
            value={sttLanguage}
            onChange={(e) => setSTTLanguage(e.target.value)}
            className="h-8 cursor-pointer rounded-lg border border-border/40 bg-background/60 px-2 text-xs font-medium normal-case tracking-normal text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            {STT_LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Main two-panel: YOU | THEM ── */}
      <div className="grid grid-cols-2 gap-4">
        <PartyPanel
          label="You"
          description="Your microphone — used in online meetings"
          badge="Online meetings only"
          role="you"
          icon={<Mic className="h-4 w-4" />}
          party={config.you}
          level={deviceLevels[config.you.device_id] ?? 0}
          peak={devicePeaks[config.you.device_id] ?? 0}
          allDevices={allDevices}
          loadingDevices={loadingDevices}
          apiKeyStatus={apiKeyStatus}
          activeWhisperModel={activeWhisperModel}
          localEngines={localEngines}
          otherPartyProvider={config.them.stt_provider}
          otherPartyLabel="Them"
          onChange={(updates) => updateParty("you", updates)}
        />
        <PartyPanel
          label="Them"
          labelSuffix={<span className="text-xs font-semibold uppercase tracking-wide text-purple-400">/&nbsp;Room</span>}
          description="Remote party (online) or room microphone (in-person)"
          role="them"
          icon={<Volume2 className="h-4 w-4" />}
          party={config.them}
          level={deviceLevels[config.them.device_id] ?? 0}
          peak={devicePeaks[config.them.device_id] ?? 0}
          allDevices={allDevices}
          loadingDevices={loadingDevices}
          apiKeyStatus={apiKeyStatus}
          activeWhisperModel={activeWhisperModel}
          localEngines={localEngines}
          otherPartyProvider={config.you.stt_provider}
          otherPartyLabel="You"
          onChange={(updates) => updateParty("them", updates)}
        />
      </div>

      {/* ── Diarization Toggle — only shown when Deepgram or Azure is active ── */}
      {(["deepgram", "azure_speech"] as STTProviderType[]).some(
        (p) => config.you.stt_provider === p || config.them.stt_provider === p
      ) && (
        <div className="flex items-center justify-between rounded-xl border border-border/20 bg-card/40 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-foreground">Speaker Diarization</p>
            <p className="mt-0.5 text-meta text-muted-foreground/70">
              Separate speakers in in-person mode (supported by{" "}
              {[
                config.you.stt_provider === "deepgram" || config.them.stt_provider === "deepgram" ? "Deepgram" : null,
                config.you.stt_provider === "azure_speech" || config.them.stt_provider === "azure_speech" ? "Azure" : null,
              ].filter(Boolean).join(" & ")}
              )
            </p>
          </div>
          <button
            onClick={() => setDiarizationEnabled(!diarizationEnabled)}
            role="switch"
            aria-checked={diarizationEnabled}
            aria-label="Toggle speaker diarization"
            className={`relative h-5 w-9 cursor-pointer rounded-full transition-all duration-200 ${
              diarizationEnabled ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
                diarizationEnabled ? "translate-x-4 scale-105" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      )}

      {/* ── Recording Toggle (full-width row) ── */}
      <div className="flex items-center justify-between rounded-xl border border-border/20 bg-card/40 px-4 py-3">
        <div>
          <p className="text-xs font-medium text-foreground">Record to file</p>
          <p className="mt-0.5 text-meta text-muted-foreground/70">Save meeting audio as WAV</p>
        </div>
        <button
          onClick={() => handleRecordingToggle(!config.recording_enabled)}
          role="switch"
          aria-checked={config.recording_enabled}
          aria-label="Toggle recording"
          className={`relative h-5 w-9 cursor-pointer rounded-full transition-all duration-200 ${
            config.recording_enabled ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
              config.recording_enabled ? "translate-x-4 scale-105" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* ── Bottom row: Live Monitor | Audio Sessions ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Live Audio Monitor */}
        <div className="flex flex-col rounded-xl border border-border/20 bg-card/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">Live Monitor</span>
              <div className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" title="Monitoring all devices" />
            </div>
            <button
              onClick={loadDevices}
              disabled={loadingDevices}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <RefreshCw className={`h-3 w-3 ${loadingDevices ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="space-y-1.5">
            {devices.inputs.map((d) => (
              <DeviceLevelRow
                key={d.id}
                name={d.name}
                icon={<Mic className="h-3 w-3" />}
                level={deviceLevels[d.id] ?? 0}
                peak={devicePeaks[d.id] ?? 0}
                isSelected={d.id === config.you.device_id || d.id === config.them.device_id}
              />
            ))}
            {devices.outputs.map((d) => (
              <DeviceLevelRow
                key={d.id}
                name={d.name}
                icon={<Volume2 className="h-3 w-3" />}
                level={deviceLevels[d.id] ?? 0}
                peak={devicePeaks[d.id] ?? 0}
                isSelected={d.id === config.you.device_id || d.id === config.them.device_id}
              />
            ))}
          </div>
          <p className="mt-2 shrink-0 text-meta text-muted-foreground/60">
            All devices streaming live (~60 fps)
          </p>
        </div>

        {/* Right column: Audio Sessions */}
        <div className="flex flex-col">

          {/* Audio Sessions */}
          <div className="flex flex-col rounded-xl border border-border/20 bg-card/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">Audio Sessions</span>
              <button
                onClick={loadSessions}
                disabled={loadingSessions}
                className="cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <RefreshCw className={`h-3 w-3 ${loadingSessions ? "animate-spin" : ""}`} />
              </button>
            </div>
            {sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                {loadingSessions ? "Scanning audio sessions..." : "No active audio sessions detected"}
              </p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s, idx) => {
                  const matchingDevice = devices.outputs.find((d) => d.name === s.device_name);
                  const isSelectedDevice = matchingDevice
                    ? matchingDevice.id === config.them.device_id
                    : false;
                  return (
                    <div
                      key={`${s.pid}-${s.device_name}-${idx}`}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                        isSelectedDevice ? "bg-primary/5 border border-primary/20" : "hover:bg-accent/30"
                      }`}
                    >
                      <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.is_active ? "bg-success" : "bg-muted-foreground/30"}`} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {s.display_name}
                      </span>
                      <button
                        onClick={() => {
                          if (matchingDevice) {
                            updateParty("them", {
                              device_id: matchingDevice.id,
                              is_input_device: false,
                            });
                            showToast(`"Them" source set to ${matchingDevice.name}`, "success");
                          } else {
                            showToast("Could not find matching output device", "error");
                          }
                        }}
                        disabled={isSelectedDevice}
                        className={`shrink-0 cursor-pointer rounded px-2 py-0.5 text-meta font-medium transition-all ${
                          isSelectedDevice
                            ? "bg-primary/10 text-primary cursor-default"
                            : "bg-accent text-foreground hover:bg-primary/10 hover:text-primary"
                        }`}
                      >
                        {isSelectedDevice ? "Active" : "Use"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Info Callout ── */}
      <div className="flex items-start gap-3 rounded-xl border border-border/20 bg-card/40 px-4 py-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <p className="text-xs text-muted-foreground/70">
          <span className="font-medium text-foreground">Dual-purpose audio:</span>{" "}
          In <span className="text-sky-400 font-medium">online meetings</span>, "You" captures your mic and "Them" captures remote audio via system loopback.
          In <span className="text-purple-400 font-medium">in-person meetings</span>, both sources share the room microphone and speaker diarization separates voices.
        </p>
      </div>
    </div>
  );
}

// ── Party Panel Component ──

function PartyPanel({
  label,
  labelSuffix,
  description,
  badge,
  role,
  icon,
  party,
  level,
  peak,
  allDevices,
  loadingDevices,
  apiKeyStatus,
  activeWhisperModel,
  localEngines,
  otherPartyProvider,
  otherPartyLabel,
  onChange,
}: {
  label: string;
  labelSuffix?: React.ReactNode;
  description?: string;
  badge?: string;
  role: "you" | "them";
  icon: React.ReactNode;
  party: PartyAudioConfig;
  level: number;
  peak: number;
  allDevices: { device: AudioDevice; group: string }[];
  loadingDevices: boolean;
  apiKeyStatus: Record<string, boolean>;
  activeWhisperModel: string | null;
  localEngines: LocalSTTEngineInfo[];
  otherPartyProvider: STTProviderType | null;
  otherPartyLabel: string;
  onChange: (updates: Partial<PartyAudioConfig>) => void;
}) {
  const c = PARTY_CONFIG[role];
  const inputDevices = allDevices.filter((d) => d.group === "Microphones");
  const outputDevices = allDevices.filter((d) => d.group === "Speakers / Output");

  // Amplify then sqrt for perceptual sensitivity — 2.5× gain makes typical peaks fill the bar
  const amplified = Math.min(level * 2.5, 1);
  const scaledLv = Math.sqrt(amplified);
  const isActive = level > 0.005;
  const barWidth = isActive ? Math.min(100, Math.round(scaledLv * 100)) : 0;

  function handleDeviceChange(deviceId: string) {
    const isInput = inputDevices.some((d) => d.device.id === deviceId);
    onChange({ device_id: deviceId, is_input_device: isInput });
  }

  function handleProviderChange(newProvider: STTProviderType) {
    const updates: Partial<PartyAudioConfig> = { stt_provider: newProvider };
    if (newProvider === "sherpa_onnx" || newProvider === "ort_streaming" || newProvider === "parakeet_tdt") {
      // Use per-engine active model, falling back to legacy activeWhisperModel
      const activeModelPerEngine = useConfigStore.getState().activeModelPerEngine;
      const DEFAULT_MODEL_PER_ENGINE: Record<string, string> = {
        sherpa_onnx: "streaming-zipformer-en-20M",
        ort_streaming: "zipformer-en-20M",
        parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
      };
      const engineModel = activeModelPerEngine[newProvider]
        ?? DEFAULT_MODEL_PER_ENGINE[newProvider]
        ?? activeWhisperModel;
      if (engineModel) updates.local_model_id = engineModel;
    } else {
      // Clear local_model_id for non-local providers to prevent cross-engine contamination
      updates.local_model_id = undefined;
    }
    // Dev log: provider change
    import("../stores/devLogStore").then(({ useDevLogStore }) => {
      useDevLogStore.getState().addEntry(
        "info", "config",
        `[${party.role === "You" ? "You" : "Them"}] Provider → ${newProvider}` +
        (updates.local_model_id ? ` (model: ${updates.local_model_id})` : "")
      );
    });
    onChange(updates);
  }

  return (
    <div className={`flex flex-col rounded-xl border bg-card/40 ${c.border}`}>

      {/* ── Header ── */}
      <div className={`flex items-center gap-3 rounded-t-xl bg-gradient-to-r ${c.headerGrad} to-transparent border-b border-border/20 px-4 py-3`}>
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${c.iconBg}`}>
          <span className={c.iconColor}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className={`text-xs font-semibold uppercase tracking-wide ${c.iconColor}`}>{label}</p>
            {labelSuffix}
          </div>
          {description ? (
            <p className="mt-0.5 text-meta text-muted-foreground/60">{description}</p>
          ) : (
            <p className="mt-0.5 text-meta text-muted-foreground/60">Audio source & recognition</p>
          )}
          {badge && (
            <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {badge}
            </span>
          )}
        </div>
        {/* Live activity indicator */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            {isActive && (
              <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.ping} opacity-40`} />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-150 ${isActive ? c.dot : "bg-muted-foreground/20"}`} />
          </span>
          <span className="w-7 text-right text-meta tabular-nums font-medium text-muted-foreground/60">
            {barWidth}%
          </span>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-col gap-4 p-4">

        {/* Source device */}
        <div>
          <label className="mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            Source
          </label>
          <select
            value={party.device_id}
            onChange={(e) => handleDeviceChange(e.target.value)}
            disabled={loadingDevices}
            className="w-full cursor-pointer rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            <option value="default">
              {loadingDevices ? "Loading..." : "Default"}
            </option>
            {inputDevices.length > 0 && (
              <optgroup label="Microphones">
                {inputDevices.map((d) => (
                  <option key={d.device.id} value={d.device.id}>
                    {d.device.name}{d.device.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {outputDevices.length > 0 && (
              <optgroup label="Speakers / Output">
                {outputDevices.map((d) => (
                  <option key={d.device.id} value={d.device.id}>
                    {d.device.name}{d.device.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Level bar — gradient zones */}
        <div className="relative h-3 overflow-hidden rounded-full bg-muted/20">
          <div
            className="absolute inset-y-0 left-0 rounded-full audio-level-gradient audio-bar-spring"
            style={{ width: `${scaledLv * 100}%` }}
          />
          {peak > 0.005 && (
            <div
              className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/50 transition-all duration-150"
              style={{ left: `${Math.sqrt(Math.min(peak * 2.5, 1)) * 100}%` }}
            />
          )}
        </div>

        {/* STT Provider */}
        <div>
          <label className="mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            Speech to Text
          </label>
          <ProviderSelect
            value={party.stt_provider}
            isInput={party.is_input_device}
            apiKeyStatus={apiKeyStatus}
            localEngines={localEngines}
            otherPartyProvider={otherPartyProvider}
            otherPartyLabel={otherPartyLabel}
            onChange={handleProviderChange}
          />
        </div>

        {/* Device + Provider mismatch warning */}
        {(party.stt_provider === "web_speech" || party.stt_provider === "windows_native") &&
          party.is_input_device &&
          party.device_id !== "default" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="text-meta leading-relaxed text-amber-200/80">
              <span className="font-semibold text-amber-400">Device override active.</span>{" "}
              {party.stt_provider === "web_speech" ? "Web Speech" : "Windows Speech"} always
              uses the system default mic. During meetings, your system default will be
              temporarily switched to the selected device and restored when the meeting ends.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Custom STT Provider Dropdown ──

function ProviderSelect({
  value,
  isInput,
  apiKeyStatus,
  localEngines,
  otherPartyProvider,
  otherPartyLabel,
  onChange,
}: {
  value: STTProviderType;
  isInput: boolean;
  apiKeyStatus: Record<string, boolean>;
  localEngines: LocalSTTEngineInfo[];
  otherPartyProvider: STTProviderType | null;
  otherPartyLabel: string;
  onChange: (val: STTProviderType) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stealTarget, setStealTarget] = useState<STTProviderType | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setStealTarget(null);
      }
    }
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function isLocalEngineReady(engineId: string): boolean {
    if (localEngines.length === 0) return true; // Still loading — don't trigger fallback
    const eng = localEngines.find((e) => e.engine === engineId);
    if (!eng) return false;
    return eng.models.some((m) => !m.id.startsWith("binary-") && m.is_downloaded);
  }

  function isAvailable(opt: typeof STT_OPTIONS[0]): boolean {
    // Don't show providers that require downloads/keys even if currently selected
    if (opt.inputOnly && !isInput) return false;
    if (opt.requiresDownload) return isLocalEngineReady(opt.requiresDownload);
    // If API key status hasn't loaded yet, assume available to prevent false fallbacks
    if (opt.requiresKey) return apiKeyStatus[opt.value] ?? true;
    return true;
  }

  function isExclusiveLocked(opt: typeof STT_OPTIONS[0]): boolean {
    if (!isExclusiveProvider(opt.value)) return false;
    if (!otherPartyProvider) return false;
    return isExclusiveProvider(otherPartyProvider);
  }

  function findExclusiveFallback(): STTProviderType | null {
    for (const provider of EXCLUSIVE_FALLBACK_ORDER) {
      const opt = STT_OPTIONS.find(o => o.value === provider);
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
      onChange(stealTarget);
      setStealTarget(null);
      setOpen(false);
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

    const stealLabel = STT_OPTIONS.find(o => o.value === stealTarget)?.label ?? stealTarget;
    const fallbackLabel = STT_OPTIONS.find(o => o.value === fallback)?.label ?? fallback;
    showToast(
      `${stealLabel} moved to ${thisRole === "you" ? "You" : "Them"}. ${otherRole === "you" ? "You" : "Them"} fell back to ${fallbackLabel}.`,
      "info"
    );

    setStealTarget(null);
    setOpen(false);
  }

  // Auto-reset to a working provider if the current one is no longer available.
  // Skip fallback on initial engine load to prevent model changes from resetting providers.
  const enginesLoadedRef = useRef(false);

  useEffect(() => {
    if (!enginesLoadedRef.current) {
      if (localEngines.length > 0) enginesLoadedRef.current = true;
      return; // Skip fallback on initial load
    }
    const currentOpt = STT_OPTIONS.find((o) => o.value === value);
    if (currentOpt && !isAvailable(currentOpt)) {
      const fallback = STT_OPTIONS.find(
        (o) => o.value !== value && isAvailable(o)
      );
      if (fallback) {
        onChange(fallback.value);
      }
    }
  }, [localEngines, apiKeyStatus]);

  const localOptions = STT_OPTIONS.filter((o) => !o.isCloud && isAvailable(o));
  const cloudOptions = STT_OPTIONS.filter((o) => o.isCloud && isAvailable(o));
  const hasAny = localOptions.length > 0 || cloudOptions.length > 0;

  const current = STT_OPTIONS.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
          open
            ? "border-primary bg-background ring-1 ring-primary/20"
            : "border-border/50 bg-background hover:border-border"
        }`}
      >
        <span className="shrink-0 text-muted-foreground">{current?.icon}</span>
        <span className="flex-1 truncate text-left font-medium">
          {current?.label ?? value}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border/50 bg-popover shadow-xl">
          {localOptions.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/30 px-3 py-1.5">
                <HardDrive className="h-2.5 w-2.5 text-emerald-500" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
                  Local & Built-in
                </span>
              </div>
              {localOptions.map((opt) => {
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onChange(opt.value);
                        setOpen(false);
                      }
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-accent ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      value === opt.value ? "bg-primary/5 text-primary" : "text-foreground"
                    }`}
                  >
                    <span className={`shrink-0 ${value === opt.value ? "text-primary" : "text-emerald-500"}`}>
                      {opt.icon}
                    </span>
                    <span className="flex-1 text-left">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">In use by {otherPartyLabel}</span>
                      )}
                    </span>
                    {value === opt.value && !locked && (
                      <CheckCircle className="h-3 w-3 shrink-0 text-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {cloudOptions.length > 0 && (
            <div className={localOptions.length > 0 ? "border-t border-border/20" : ""}>
              <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/30 px-3 py-1.5">
                <Cloud className="h-2.5 w-2.5 text-blue-500" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
                  Cloud
                </span>
              </div>
              {cloudOptions.map((opt) => {
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onChange(opt.value);
                        setOpen(false);
                      }
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-accent ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      value === opt.value ? "bg-primary/5 text-primary" : "text-foreground"
                    }`}
                  >
                    <span className={`shrink-0 ${value === opt.value ? "text-primary" : "text-blue-500"}`}>
                      {opt.icon}
                    </span>
                    <span className="flex-1 text-left">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">In use by {otherPartyLabel}</span>
                      )}
                    </span>
                    {value === opt.value && !locked && (
                      <CheckCircle className="h-3 w-3 shrink-0 text-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {!hasAny && (
            <p className="px-3 py-3 text-meta text-muted-foreground">
              No providers ready — configure in STT Keys tab
            </p>
          )}

          {stealTarget && (
            <div className="border-t border-border/20 bg-amber-500/5 px-3 py-2.5">
              <p className="text-meta leading-relaxed text-amber-200/80 mb-2">
                <span className="font-semibold text-amber-400">
                  {STT_OPTIONS.find(o => o.value === stealTarget)?.label}
                </span>{" "}
                can only run on one source at a time. Switch to this party?
                The other party will fall back to{" "}
                <span className="font-medium">
                  {(() => {
                    const fb = findExclusiveFallback();
                    return fb ? (STT_OPTIONS.find(o => o.value === fb)?.label ?? fb) : "no available engine";
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
        </div>
      )}
    </div>
  );
}

// ── Device Level Row ──

function DeviceLevelRow({
  name,
  icon,
  level,
  peak,
  isSelected,
}: {
  name: string;
  icon: React.ReactNode;
  level: number;
  peak: number;
  isSelected?: boolean;
}) {
  const amplified = Math.min(Math.max(level, 0) * 2.5, 1);
  const scaled = Math.sqrt(amplified);

  return (
    <div className="flex items-center gap-2">
      <span className={isSelected ? "text-primary" : "text-muted-foreground/60"}>{icon}</span>
      <span className={`w-28 truncate text-meta ${isSelected ? "font-medium text-foreground" : "text-muted-foreground/60"}`}>
        {name}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/20">
        <div
          className="absolute inset-y-0 left-0 rounded-full audio-level-gradient audio-bar-spring"
          style={{ width: `${scaled * 100}%` }}
        />
        {peak > 0.005 && (
          <div
            className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/30 transition-all duration-150"
            style={{ left: `${Math.sqrt(Math.min(peak * 2.5, 1)) * 100}%` }}
          />
        )}
      </div>
      <span className="w-7 text-right text-meta tabular-nums text-muted-foreground/70">
        {level > 0.005 ? `${Math.round(scaled * 100)}%` : "\u2014"}
      </span>
    </div>
  );
}
