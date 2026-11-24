// STT Settings — provider selector with inline model management per provider.
// Badges: always-ready=green, no model/key=red, downloaded-not-active=amber,
//         cloud-key-stored=amber, cloud-tested=green.

import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { skipYouStt } from "../lib/audioMode";
import {
  AUTO_STT_LANGUAGE,
  STT_LANGUAGES,
  autoDetectProblem,
  cartesiaSupportsLanguage,
  isDeepgramNova3,
  sideLanguage,
  sideLanguageHint,
} from "../lib/sttLanguages";
import {
  setSTTProvider,
  testSTTConnection,
  testAzureMaiConnection,
  listLocalSTTEngines,
  deleteApiKey,
} from "../lib/ipc";
import { storeApiKey, getApiKey, hasApiKey } from "../lib/ipc";
import {
  WHISPER_API_KEY,
  WHISPER_API_CUSTOM_KEY,
  WHISPER_API_BASE_URL_KEY,
  WHISPER_API_MODEL_KEY,
  WHISPER_ENDPOINT_ERROR,
  isCustomWhisperEndpoint,
  isInsecureRemoteHttp,
  isValidWhisperBaseUrl,
} from "../lib/whisperApi";
import type { STTProviderType, LocalSTTEngineInfo, DeepgramConfig, GroqConfig } from "../lib/types";
import { STT_GROUPS, sttGroup, type SttGroupId } from "../lib/sttGroups";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Cloud,
  Server,
  Globe,
  Wifi,
  HardDrive,
  Monitor,
  Zap,
  Trash2,
  ChevronDown,
  ChevronUp,
  Settings2,
  Cpu,
  ExternalLink,
} from "lucide-react";
import { LocalModelManager } from "./LocalModelManager";
import { open } from "@tauri-apps/plugin-shell";

const GROUP_ICONS: Record<SttGroupId, typeof HardDrive> = { device: HardDrive, builtin: Globe, cloud: Cloud };

// ── Provider definitions ──

interface ProviderOption {
  value: STTProviderType;
  label: string;
  description: string;
  requiresApiKey: boolean;
  credentialKey: string;
  needsRegion?: boolean;
  regionCredentialKey?: string;
  defaultRegion?: string;
  regionOptions?: readonly { value: string; label: string }[];
  /** Engine ID whose models must be downloaded + activated for readiness */
  requiresModels?: string;
  /** Always ready (no download / key needed) */
  alwaysReady?: boolean;
  /** Batch-only: cannot be used for live streaming; shown with badge */
  batchOnly?: boolean;
}

const AZURE_MAI_REGIONS = [
  { value: "swedencentral", label: "Sweden Central" },
  { value: "centralus", label: "Central US" },
  { value: "eastus2", label: "East US 2" },
  { value: "southeastasia", label: "Southeast Asia" },
] as const;

const AZURE_MAI_GUIDE_URL =
  "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming-speech-sdk";

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: "web_speech",
    label: "Web Speech",
    description: "Browser speech, your mic only",
    requiresApiKey: false,
    credentialKey: "",
    alwaysReady: true,
  },
  {
    value: "windows_native",
    label: "Windows Speech",
    description: "Microsoft online speech, your mic only",
    requiresApiKey: false,
    credentialKey: "",
    alwaysReady: true,
  },
  {
    value: "sherpa_onnx",
    label: "Sherpa-ONNX",
    description: "Local streaming, offline, free",
    requiresApiKey: false,
    credentialKey: "",
    requiresModels: "sherpa_onnx",
  },
  {
    value: "ort_streaming",
    label: "ORT Streaming",
    description: "Local streaming, offline, free",
    requiresApiKey: false,
    credentialKey: "",
    requiresModels: "ort_streaming",
  },
  {
    value: "whisper_cpp",
    label: "Whisper.cpp",
    description: "Batch transcription of recorded meetings",
    requiresApiKey: false,
    credentialKey: "",
    requiresModels: "whisper_cpp",
    batchOnly: true,
  },
  {
    value: "parakeet_tdt",
    label: "Parakeet TDT",
    description: "Best accuracy, offline, multilingual",
    requiresApiKey: false,
    credentialKey: "",
    requiresModels: "parakeet_tdt",
  },
  {
    value: "deepgram",
    label: "Deepgram",
    description: "Real-time streaming, best quality",
    requiresApiKey: true,
    credentialKey: "deepgram",
  },
  {
    value: "whisper_api",
    label: "Whisper API",
    description: "OpenAI or your own compatible server",
    requiresApiKey: true,
    credentialKey: "whisper_api",
  },
  {
    value: "azure_speech",
    label: "Azure Speech",
    description: "Azure Cognitive Services",
    requiresApiKey: true,
    credentialKey: "azure_speech",
    needsRegion: true,
    regionCredentialKey: "azure_speech_region",
  },
  {
    value: "azure_mai_streaming",
    label: "Azure MAI Streaming",
    description: "MAI-Transcribe-2-Streaming · Public Preview",
    requiresApiKey: true,
    credentialKey: "azure_mai_streaming",
    needsRegion: true,
    regionCredentialKey: "azure_mai_streaming_region",
    defaultRegion: "swedencentral",
    regionOptions: AZURE_MAI_REGIONS,
  },
  {
    value: "groq_whisper",
    label: "Groq Whisper",
    description: "Ultra-fast Whisper inference",
    requiresApiKey: true,
    credentialKey: "groq_whisper",
  },
  {
    value: "cartesia",
    label: "Cartesia",
    description: "Ink-2 streaming with turn detection",
    requiresApiKey: true,
    credentialKey: "cartesia",
  },
];


// ── Deepgram Models ──

interface DeepgramModelInfo {
  id: string;
  label: string;
  tier: "latest" | "flux" | "standard" | "economy" | "whisper";
  description: string;
  costPerMin: number;
}

const DEEPGRAM_MODELS: DeepgramModelInfo[] = [
  { id: "nova-3", label: "Nova 3", tier: "latest", description: "Best accuracy, latest model", costPerMin: 0.0059 },
  { id: "flux-general-en", label: "Flux", tier: "flux", description: "Knows when a speaker is done, so Auto-Answer replies at once (English)", costPerMin: 0.0077 },
  { id: "flux-general-multi", label: "Flux Multilingual", tier: "flux", description: "Turn detection in 10 languages", costPerMin: 0.0078 },
  { id: "nova-2", label: "Nova 2", tier: "standard", description: "Great accuracy, widely used", costPerMin: 0.0043 },
  { id: "nova", label: "Nova", tier: "standard", description: "Previous generation", costPerMin: 0.0043 },
  { id: "enhanced", label: "Enhanced", tier: "standard", description: "High accuracy, conservative", costPerMin: 0.0043 },
  { id: "base", label: "Base", tier: "economy", description: "Fastest, most economical", costPerMin: 0.0043 },
  { id: "whisper-large", label: "Whisper Large", tier: "whisper", description: "OpenAI Whisper large", costPerMin: 0.0048 },
  { id: "whisper-medium", label: "Whisper Medium", tier: "whisper", description: "OpenAI Whisper medium", costPerMin: 0.0048 },
  { id: "whisper-small", label: "Whisper Small", tier: "whisper", description: "OpenAI Whisper small", costPerMin: 0.0048 },
  { id: "whisper-tiny", label: "Whisper Tiny", tier: "whisper", description: "Smallest, fastest Whisper", costPerMin: 0.0048 },
  { id: "whisper-base", label: "Whisper Base", tier: "whisper", description: "OpenAI Whisper base", costPerMin: 0.0048 },
];

// ── Deepgram Presets ──

interface DeepgramPreset {
  id: string;
  label: string;
  description: string;
  config: DeepgramConfig;
}

const DEEPGRAM_PRESETS: DeepgramPreset[] = [
  {
    id: "default",
    label: "Default",
    description: "Balanced settings for most meetings",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: true,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "low_latency",
    label: "Low Latency",
    description: "Fastest response, minimal post-processing",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 150, punctuate: false, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "high_accuracy",
    label: "High Accuracy",
    description: "Best transcript quality, smart formatting",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 500, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "meeting_mode",
    label: "Meeting",
    description: "Speaker detection, formatted output",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 400, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "economy",
    label: "Economy",
    description: "Nova 2 model, lower cost",
    config: {
      model: "nova-2", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: false, keyterms: [],
    },
  },
];

function configMatchesPreset(config: DeepgramConfig, preset: DeepgramConfig): boolean {
  return (
    config.model === preset.model &&
    config.smart_format === preset.smart_format &&
    config.interim_results === preset.interim_results &&
    config.endpointing === preset.endpointing &&
    config.punctuate === preset.punctuate &&
    config.diarize === preset.diarize &&
    config.profanity_filter === preset.profanity_filter &&
    config.numerals === preset.numerals &&
    config.dictation === preset.dictation &&
    config.vad_events === preset.vad_events
    // keyterms excluded from preset matching — user-specific
  );
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";
type BadgeVariant = "ready" | "warning" | "error";
interface BadgeState { text: string; variant: BadgeVariant }

export function STTSettings() {
  const sttProvider = useConfigStore((s) => s.sttProvider);
  const setConfigSTTProvider = useConfigStore((s) => s.setSTTProvider);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);
  const sttLanguage = useConfigStore((s) => s.sttLanguage);
  const setSTTLanguage = useConfigStore((s) => s.setSTTLanguage);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);
  const deepgramModel = useConfigStore((s) => s.deepgramConfig.model);
  // Persisted: providers whose key has been saved + tested successfully
  const verifiedCloudProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const setVerifiedCloudProviders = useConfigStore((s) => s.setVerifiedCloudProviders);

  // Starts on the provider "You" actually uses (Audio & Devices can change it).
  const youProvider = meetingAudioConfig?.you.stt_provider;
  const [selectedProvider, setSelectedProvider] =
    useState<STTProviderType>(youProvider ?? sttProvider);
  const selectedProviderRef = useRef(selectedProvider);
  useEffect(() => {
    if (youProvider && youProvider !== selectedProviderRef.current) {
      selectedProviderRef.current = youProvider;
      setSelectedProvider(youProvider);
    }
  }, [youProvider]);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [credentialStateProvider, setCredentialStateProvider] =
    useState<STTProviderType | null>(null);
  const [credentialStateLoading, setCredentialStateLoading] = useState(false);
  // keyDirty: user has typed a new key that differs from stored — show Save & Test
  const [keyDirty, setKeyDirty] = useState(false);
  const keyDirtyRef = useRef(false);
  keyDirtyRef.current = keyDirty;
  const prevProviderRef = useRef<STTProviderType | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const [azureRegion, setAzureRegion] = useState("eastus");
  const [azureMaiRegion, setAzureMaiRegion] = useState("swedencentral");

  // Whisper API: optional custom OpenAI-compatible endpoint + model (non-secret).
  const [whisperBaseUrl, setWhisperBaseUrl] = useState("");
  const [whisperModel, setWhisperModel] = useState("");
  const [whisperDirty, setWhisperDirty] = useState(false);
  const [whisperLoaded, setWhisperLoaded] = useState(false);
  const [whisperEndpointError, setWhisperEndpointError] = useState("");
  // Stored endpoint / OpenAI key presence, for the provider badge (any selected provider).
  const [whisperSavedBaseUrl, setWhisperSavedBaseUrl] = useState("");
  const [whisperStoredKey, setWhisperStoredKey] = useState(false);
  // Last values written to the credential store, to skip no-op blur saves.
  const savedWhisperRef = useRef({ baseUrl: "", model: "" });
  // The blur save in flight (Save & Test waits for it before reading the saved state).
  const whisperSaveRef = useRef<Promise<void>>(Promise.resolve());
  // Bumped on every config edit; a Save & Test that finishes under an older value is ignored.
  const whisperRevisionRef = useRef(0);

  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const activeParakeetModel = useConfigStore((s) =>
    s.activeModelPerEngine.parakeet_tdt ?? "parakeet-tdt-0.6b-v3-int8"
  );

  // The "You" side as meetings will run it; before the audio setup exists, the picker's choice.
  const youSide = meetingAudioConfig
    ? { provider: meetingAudioConfig.you.stt_provider, localModel: meetingAudioConfig.you.local_model_id }
    : { provider: selectedProvider, localModel: undefined };
  const autoModels = { deepgram: deepgramModel, whisperCpp: activeWhisperModel, parakeet: activeParakeetModel };
  const autoDetectionSelected = sttLanguage === AUTO_STT_LANGUAGE;
  const inPerson = useMeetingStore((s) => skipYouStt(s.audioMode));
  // This page picks the "You" provider; the "Them" side is set in Audio & Devices.
  // A side with a language of its own is judged by that one, not the shared one.
  const youAuto = sideLanguage(meetingAudioConfig?.you, sttLanguage) === AUTO_STT_LANGUAGE;
  const themAuto = sideLanguage(meetingAudioConfig?.them, sttLanguage) === AUTO_STT_LANGUAGE;
  // Whatever sets a side to Auto-detect (the shared language or its own) can run into it.
  const autoProblems = [
    inPerson || !youAuto ? null : autoDetectProblem(youSide, autoModels, "You"),
    meetingAudioConfig && themAuto
      ? autoDetectProblem(
          { provider: meetingAudioConfig.them.stt_provider, localModel: meetingAudioConfig.them.local_model_id },
          autoModels,
          `${inPerson ? "Room" : "Them"} (set in Audio & Devices)`,
        )
      : null,
  ].filter((p): p is string => p !== null);
  const showAutoDetectionWarning = autoProblems.length > 0;

  // The hints below follow the language "You" is transcribed in: its own, else the shared one.
  const youLanguage = sideLanguage(meetingAudioConfig?.you, sttLanguage);
  const languageHint = sideLanguageHint(
    {
      provider: selectedProvider,
      localModel: meetingAudioConfig?.you.stt_provider === selectedProvider ? meetingAudioConfig.you.local_model_id : undefined,
    },
    youLanguage,
    autoModels,
  );
  // Sides with a language of their own, which this shared setting doesn't decide.
  const ownLanguageNotes = (
    [
      meetingAudioConfig?.you.language && !inPerson ? { name: "You", language: meetingAudioConfig.you.language } : null,
      meetingAudioConfig?.them.language
        ? { name: inPerson ? "Room" : "Them", language: meetingAudioConfig.them.language }
        : null,
    ].filter((note) => note !== null)
  ).map(
    (note) =>
      `${note.name}: ${STT_LANGUAGES.find((l) => l.value === note.language)?.label ?? note.language}, set in Audio & Devices.`,
  );

  const currentProviderOption = PROVIDER_OPTIONS.find(
    (p) => p.value === selectedProvider
  );
  const credentialStateReady = credentialStateProvider === selectedProvider;
  const isWhisperApi = selectedProvider === "whisper_api";
  // A custom endpoint makes the API key optional (local servers usually need none).
  const whisperEndpointSet = isWhisperApi && isCustomWhisperEndpoint(whisperBaseUrl);
  // While a Whisper test runs its inputs are locked, so the result matches what is saved.
  const whisperTesting = isWhisperApi && connectionStatus === "testing";
  // The OpenAI key and a custom server's key live in separate slots; the OpenAI
  // key is never used for a custom endpoint.
  const activeCredentialKey = whisperEndpointSet
    ? WHISPER_API_CUSTOM_KEY
    : currentProviderOption?.credentialKey;
  const shownApiKey = credentialStateReady ? apiKey : "";
  const shownHasStoredKey = credentialStateReady && hasStoredKey;
  const shownKeyDirty = credentialStateReady && keyDirty;
  const shownConnectionStatus = credentialStateReady ? connectionStatus : "idle";
  const credentialsAreLoading =
    currentProviderOption?.requiresApiKey === true &&
    (!credentialStateReady || credentialStateLoading);
  const showMaiKeyReentryHint =
    selectedProvider === "azure_mai_streaming" &&
    shownHasStoredKey &&
    shownKeyDirty &&
    !shownApiKey.trim();

  // ── Load readiness state ──

  const loadLocalEngines = useCallback(async () => {
    try {
      const data = await listLocalSTTEngines();
      setLocalEngines(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadLocalEngines();
  }, [loadLocalEngines]);

  // Refresh engine readiness whenever any model download completes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ status: string }>("model_download_progress", (event) => {
      if (event.payload.status === "complete") {
        loadLocalEngines();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [loadLocalEngines]);

  // ── Badge & readiness logic ──

  function getEngineDownloadedModels(engineId: string) {
    const engine = localEngines.find((e) => e.engine === engineId);
    if (!engine) return [];
    return engine.models.filter(
      (m) => !m.id.startsWith("binary-") && m.is_downloaded
    );
  }

  function getBadgeState(p: ProviderOption): BadgeState {
    if (p.alwaysReady) return { text: "Ready", variant: "ready" };

    // Batch-only: green "Batch" if model downloaded, amber "Batch" if not
    if (p.batchOnly) {
      const downloaded = p.requiresModels
        ? getEngineDownloadedModels(p.requiresModels)
        : [];
      return { text: "Batch", variant: downloaded.length > 0 ? "ready" : "warning" };
    }

    if (p.requiresApiKey) {
      // Verified = key was saved+tested successfully (persisted across page navigations)
      if (verifiedCloudProviders.includes(p.value)) return { text: "Ready", variant: "ready" };
      if (p.value === "whisper_api" && (whisperSavedBaseUrl !== "" || whisperStoredKey)) {
        return { text: "Not tested", variant: "warning" };
      }
      return { text: "No Key", variant: "error" };
    }

    if (p.requiresModels) {
      const downloaded = getEngineDownloadedModels(p.requiresModels);
      if (downloaded.length === 0) return { text: "No Model", variant: "error" };
      return { text: "Ready", variant: "ready" };
    }

    return { text: "Ready", variant: "ready" };
  }

  function isProviderReady(p: ProviderOption): boolean {
    return getBadgeState(p).variant === "ready";
  }

  // ── Key loading (load stored key display when switching providers) ──

  useEffect(() => {
    let cancelled = false;
    const loadKeyForProvider = async () => {
      whisperRevisionRef.current += 1;
      // Switching a Whisper endpoint on or off swaps the key slot but keeps a key being typed.
      const providerChanged = prevProviderRef.current !== selectedProvider;
      prevProviderRef.current = selectedProvider;
      const keepTyped = !providerChanged && keyDirtyRef.current;
      setCredentialStateProvider(selectedProvider);
      setCredentialStateLoading(currentProviderOption?.requiresApiKey === true);
      if (!keepTyped) {
        setApiKey("");
        setKeyDirty(false);
      }
      setShowApiKey(false);
      setHasStoredKey(false);
      setConnectionStatus("idle");
      setStatusMessage("");

      if (!currentProviderOption?.requiresApiKey) {
        setCredentialStateLoading(false);
        return;
      }

      const credKey = activeCredentialKey;
      if (!credKey) {
        setCredentialStateLoading(false);
        return;
      }

      if (selectedProvider === "azure_mai_streaming") {
        setAzureMaiRegion(currentProviderOption.defaultRegion ?? "swedencentral");
      }

      try {
        const keyExists = await hasApiKey(credKey);
        if (cancelled) return;
        setHasStoredKey(keyExists);
        // MAI keys are write-only in the UI: discover presence, but never
        // read the long-lived secret back into JavaScript or the input field.
        if (keyExists && selectedProvider !== "azure_mai_streaming" && !keepTyped) {
          const stored = await getApiKey(credKey);
          if (cancelled) return;
          if (stored) setApiKey(stored);
        }
      } catch (e) {
        if (!cancelled) console.warn("Failed to load STT API key:", e);
      }

      if (cancelled) return;
      if (currentProviderOption.needsRegion && currentProviderOption.regionCredentialKey) {
        try {
          const regionExists = await hasApiKey(currentProviderOption.regionCredentialKey);
          if (cancelled) return;
          if (regionExists) {
            const stored = await getApiKey(currentProviderOption.regionCredentialKey);
            if (cancelled) return;
            if (stored) {
              if (selectedProvider === "azure_mai_streaming") setAzureMaiRegion(stored);
              else setAzureRegion(stored);
            }
          }
        } catch (e) {
          if (!cancelled) console.warn("Failed to load speech region:", e);
        }
      }
      if (!cancelled) setCredentialStateLoading(false);
    };
    void loadKeyForProvider();
    return () => {
      cancelled = true;
    };
  }, [
    selectedProvider,
    activeCredentialKey,
    currentProviderOption?.requiresApiKey,
    currentProviderOption?.needsRegion,
    currentProviderOption?.regionCredentialKey,
    currentProviderOption?.defaultRegion,
  ]);

  // ── Whisper API endpoint + model (loaded once; the Whisper card shows them whichever provider is selected) ──

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const load = async (credKey: string) =>
          (await hasApiKey(credKey)) ? (await getApiKey(credKey)) ?? "" : "";
        const [baseUrl, model, hasOpenAiKey] = await Promise.all([
          load(WHISPER_API_BASE_URL_KEY),
          load(WHISPER_API_MODEL_KEY),
          hasApiKey(WHISPER_API_KEY),
        ]);
        if (cancelled) return;
        setWhisperBaseUrl(baseUrl);
        setWhisperModel(model);
        setWhisperSavedBaseUrl(baseUrl);
        setWhisperStoredKey(hasOpenAiKey);
        savedWhisperRef.current = { baseUrl, model };
      } catch (e) {
        if (!cancelled) console.warn("Failed to load Whisper endpoint:", e);
      } finally {
        if (!cancelled) setWhisperLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Handlers ──

  const handleProviderChange = useCallback(
    async (provider: STTProviderType) => {
      if (provider === selectedProviderRef.current) return;
      selectedProviderRef.current = provider;
      setSelectedProvider(provider);
      setCredentialStateProvider(provider);
      setCredentialStateLoading(
        PROVIDER_OPTIONS.find((option) => option.value === provider)?.requiresApiKey === true,
      );
      setApiKey("");
      setShowApiKey(false);
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");
      try {
        await setSTTProvider(provider);
        setConfigSTTProvider(provider);
        // Sync meetingAudioConfig so useAudioConfigSync hot-swaps the live capture.
        if (meetingAudioConfig && meetingAudioConfig.you.stt_provider !== provider) {
          const { activeModelPerEngine, activeWhisperModel } = useConfigStore.getState();
          const model = activeModelPerEngine[provider]
            ?? (provider === "whisper_cpp" ? activeWhisperModel ?? undefined : undefined);
          setMeetingAudioConfig({
            ...meetingAudioConfig,
            you: { ...meetingAudioConfig.you, stt_provider: provider, local_model_id: model },
          });
        }
      } catch (e) {
        console.error("Failed to set STT provider:", e);
      }
    },
    [setConfigSTTProvider, meetingAudioConfig, setMeetingAudioConfig]
  );

  const updateVerifiedProvider = useCallback((provider: STTProviderType, verified: boolean) => {
    const current = useConfigStore.getState().verifiedCloudProviders;
    const updated = verified
      ? Array.from(new Set([...current, provider]))
      : current.filter((value) => value !== provider);
    setVerifiedCloudProviders(updated);
  }, [setVerifiedCloudProviders]);

  /**
   * Write (or, when empty, delete) the Whisper API endpoint and model.
   * The OpenAI URL is the default, so it is stored as empty.
   */
  const persistWhisperEndpoint = useCallback(async (baseUrl: string, model: string) => {
    const base = isCustomWhisperEndpoint(baseUrl) ? baseUrl.trim() : "";
    const entries: [string, string][] = [
      [WHISPER_API_BASE_URL_KEY, base],
      [WHISPER_API_MODEL_KEY, model.trim()],
    ];
    for (const [credKey, value] of entries) {
      if (value) await storeApiKey(credKey, value);
      else await deleteApiKey(credKey).catch(() => {});
    }
    savedWhisperRef.current = { baseUrl: base, model: model.trim() };
    setWhisperSavedBaseUrl(base);
  }, []);

  /**
   * Save the endpoint/model on blur; a changed endpoint or model must be tested again.
   * Saves are chained so overlapping blurs write in order, and a write that would
   * not change what is stored is skipped. Save & Test awaits the chain's tail.
   */
  const handleSaveWhisperEndpoint = useCallback(() => {
    if (!isValidWhisperBaseUrl(whisperBaseUrl)) {
      setWhisperEndpointError(WHISPER_ENDPOINT_ERROR);
      return Promise.resolve();
    }
    setWhisperEndpointError("");
    const baseUrl = whisperBaseUrl;
    const model = whisperModel;
    const base = isCustomWhisperEndpoint(baseUrl) ? baseUrl.trim() : "";
    const run = whisperSaveRef.current.then(async () => {
      const saved = savedWhisperRef.current;
      if (saved.baseUrl === base && saved.model === model.trim()) return;
      try {
        await persistWhisperEndpoint(baseUrl, model);
        updateVerifiedProvider("whisper_api", false);
      } catch (e) {
        console.warn("Failed to save Whisper endpoint:", e);
      }
    });
    whisperSaveRef.current = run;
    return run;
  }, [whisperBaseUrl, whisperModel, persistWhisperEndpoint, updateVerifiedProvider]);

  /**
   * Whisper API Save & Test. The key is written only when the user typed or
   * cleared it, into the slot for the current endpoint (OpenAI key or the custom
   * server's key). A failed test restores the key slot and the verified flag.
   * The endpoint and model stay saved: the blur save already wrote them.
   */
  const handleWhisperSaveAndTest = useCallback(async () => {
    const provider: STTProviderType = "whisper_api";
    const isStillSelected = () => selectedProviderRef.current === provider;
    const fail = (message: string) => {
      if (!isStillSelected()) return;
      setConnectionStatus("error");
      setStatusMessage(message);
    };

    if (!isValidWhisperBaseUrl(whisperBaseUrl)) {
      setWhisperEndpointError(WHISPER_ENDPOINT_ERROR);
      fail(WHISPER_ENDPOINT_ERROR);
      return;
    }
    setWhisperEndpointError("");

    const custom = isCustomWhisperEndpoint(whisperBaseUrl);
    const slot = custom ? WHISPER_API_CUSTOM_KEY : WHISPER_API_KEY;
    const typed = apiKey.trim();
    if (!custom && !typed) {
      fail("Enter your OpenAI API key, or set an endpoint for your own server.");
      return;
    }

    setConnectionStatus("testing");
    setStatusMessage("Testing connection...");
    const revision = whisperRevisionRef.current;
    const isStale = () => whisperRevisionRef.current !== revision;

    // Blur saves may still be writing the endpoint/model: let all of them finish first.
    await whisperSaveRef.current;
    const wasVerified = useConfigStore.getState().verifiedCloudProviders.includes(provider);
    let previousKey: string | null = null;
    let keyWritten = false;
    try {
      if (keyDirty) {
        if (hasStoredKey) previousKey = await getApiKey(slot).catch(() => null);
        keyWritten = true;
        if (typed) await storeApiKey(slot, typed);
        else await deleteApiKey(slot).catch(() => {});
      }
      await persistWhisperEndpoint(whisperBaseUrl, whisperModel);

      const success = await testSTTConnection(provider);
      if (!success) throw new Error("Connection failed");

      // The config changed while testing: this result is not about what is saved now.
      if (isStale()) return;
      updateVerifiedProvider(provider, true);
      const keyPresent = keyDirty ? typed !== "" : hasStoredKey;
      if (slot === WHISPER_API_KEY) setWhisperStoredKey(keyPresent);
      if (isStillSelected()) {
        setHasStoredKey(keyPresent);
        setKeyDirty(false);
        setWhisperDirty(false);
        setConnectionStatus("success");
        setStatusMessage("Connection successful. Provider is ready.");
      }
    } catch (e) {
      // Put back the key slot and the verified flag; the endpoint stays saved.
      if (keyWritten) {
        if (previousKey) await storeApiKey(slot, previousKey).catch(() => {});
        else await deleteApiKey(slot).catch(() => {});
      }
      if (isStale()) return;
      updateVerifiedProvider(provider, wasVerified);
      if (isStillSelected() && keyWritten) setHasStoredKey(previousKey !== null);
      fail(e instanceof Error ? e.message : String(e));
    }
  }, [
    apiKey,
    keyDirty,
    hasStoredKey,
    whisperBaseUrl,
    whisperModel,
    persistWhisperEndpoint,
    updateVerifiedProvider,
  ]);

  /** Save & Test: test key first, only persist on success. */
  const handleSaveAndTest = useCallback(async () => {
    if (!apiKey.trim() || !currentProviderOption?.credentialKey) return;

    const provider = selectedProvider;
    const option = currentProviderOption;
    const isStillSelected = () => selectedProviderRef.current === provider;
    setConnectionStatus("testing");
    setStatusMessage("Testing connection...");

    // Unlike the legacy Azure Speech path below, MAI credentials are passed
    // directly to its probe and only persisted after a successful response.
    if (provider === "azure_mai_streaming") {
      const key = apiKey.trim();
      const region = azureMaiRegion.trim();
      if (!region || !option.regionCredentialKey) {
        setConnectionStatus("error");
        setStatusMessage("Choose a Speech Resource region before testing.");
        return;
      }
      try {
        const success = await testAzureMaiConnection(key, region);
        if (!success) {
          if (isStillSelected()) {
            setConnectionStatus("error");
            setStatusMessage(
              hasStoredKey
                ? "Connection failed — existing credentials were kept"
                : "Connection failed — credentials not saved",
            );
          }
          return;
        }

        await storeApiKey(option.credentialKey, key);
        await storeApiKey(option.regionCredentialKey, region);
        updateVerifiedProvider(provider, true);
        if (!isStillSelected()) return;
        setHasStoredKey(true);
        setKeyDirty(false);
        setConnectionStatus("success");
        setStatusMessage("Connection successful — provider is ready");
      } catch (e) {
        if (isStillSelected()) {
          setConnectionStatus("error");
          setStatusMessage(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }

    // Legacy cloud-provider flow remains unchanged.
    try {
      // Temporarily store so the backend can read it during test
      await storeApiKey(option.credentialKey, apiKey.trim());
      if (option.needsRegion && azureRegion.trim()) {
        await storeApiKey("azure_speech_region", azureRegion.trim());
      }

      const success = await testSTTConnection(provider);
      if (success) {
        updateVerifiedProvider(provider, true);
        if (isStillSelected()) {
          setHasStoredKey(true);
          setKeyDirty(false);
          setConnectionStatus("success");
          setStatusMessage("Connection successful — provider is ready");
        }
      } else {
        // Remove the key we temporarily stored — test failed
        await deleteApiKey(option.credentialKey).catch(() => {});
        updateVerifiedProvider(provider, false);
        if (isStillSelected()) {
          setHasStoredKey(false);
          setConnectionStatus("error");
          setStatusMessage("Connection failed — key not saved");
        }
      }
    } catch (e) {
      await deleteApiKey(option.credentialKey).catch(() => {});
      updateVerifiedProvider(provider, false);
      if (isStillSelected()) {
        setHasStoredKey(false);
        setConnectionStatus("error");
        setStatusMessage(`Test failed: ${e}`);
      }
    }
  }, [
    apiKey,
    azureRegion,
    azureMaiRegion,
    selectedProvider,
    currentProviderOption,
    hasStoredKey,
    updateVerifiedProvider,
  ]);

  const handleClearApiKey = useCallback(async () => {
    const provider = selectedProvider;
    const option = currentProviderOption;
    if (!option?.credentialKey) return;
    const slot = activeCredentialKey ?? option.credentialKey;
    whisperRevisionRef.current += 1;
    try { await deleteApiKey(slot); } catch { /* ok */ }
    if (slot === WHISPER_API_KEY) setWhisperStoredKey(false);
    if (provider === "azure_mai_streaming" && option.regionCredentialKey) {
      try { await deleteApiKey(option.regionCredentialKey); } catch { /* ok */ }
    }
    updateVerifiedProvider(provider, false);
    if (selectedProviderRef.current === provider) {
      setApiKey("");
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");
    }
  }, [
    currentProviderOption,
    activeCredentialKey,
    selectedProvider,
    updateVerifiedProvider,
  ]);

  const handleSaveRegion = useCallback(async () => {
    if (!azureRegion.trim()) return;
    try {
      await storeApiKey("azure_speech_region", azureRegion.trim());
    } catch (e) {
      console.warn("Failed to save Azure region:", e);
    }
  }, [azureRegion]);

  /** Test Connection — only for local/always-ready providers; cloud uses handleSaveAndTest. */
  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setStatusMessage("Testing...");

    try {
      if (currentProviderOption?.requiresModels) {
        const engines = await listLocalSTTEngines();
        setLocalEngines(engines);
        const eng = engines.find((e) => e.engine === currentProviderOption.requiresModels);
        const downloaded = eng?.models.filter((m) => m.is_downloaded && !m.id.startsWith("binary-")) ?? [];
        if (downloaded.length === 0) {
          setConnectionStatus("error");
          setStatusMessage("No model downloaded. Download a model below first.");
          return;
        }
        setConnectionStatus("success");
        setStatusMessage(`Ready — ${downloaded.length} model${downloaded.length > 1 ? "s" : ""} available`);
        return;
      }

      const success = await testSTTConnection(selectedProvider);
      setConnectionStatus(success ? "success" : "error");
      setStatusMessage(success ? "Ready" : "Connection failed");
    } catch (e) {
      setConnectionStatus("error");
      setStatusMessage(`Test failed: ${e}`);
    }
  }, [selectedProvider, currentProviderOption]);

  // Does the selected provider need an inline model panel?
  const showModelPanel = !!currentProviderOption?.requiresModels;
  const modelEngineId = currentProviderOption?.requiresModels;

  return (
    <div className="space-y-6">
      {/* Provider selection, grouped by where the audio goes */}
      <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden divide-y divide-border/20">
        {STT_GROUPS.map((group) => {
          const GroupIcon = GROUP_ICONS[group.id];
          const onDevice = group.id === "device";
          return (
            <section key={group.id} aria-labelledby={`stt-group-${group.id}`} className="px-5 py-4">
              <div className="mb-3 flex items-center gap-2">
                <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${onDevice ? "bg-success/10" : "bg-info/10"}`}>
                  <GroupIcon className={`h-3 w-3 ${onDevice ? "text-success" : "text-info"}`} />
                </div>
                <h3 id={`stt-group-${group.id}`} className="text-xs font-semibold text-foreground">{group.label}</h3>
                <span className="ml-auto text-right text-meta font-medium text-muted-foreground/70">{group.note}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDER_OPTIONS.filter((p) => sttGroup(p.value) === group.id).map((p) => (
                  <ProviderCard
                    key={p.value}
                    provider={p}
                    isSelected={selectedProvider === p.value}
                    isActive={sttProvider === p.value}
                    badge={getBadgeState(p)}
                    onClick={() => handleProviderChange(p.value)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Inline Model Panel — shown when the selected provider needs models */}
      {showModelPanel && modelEngineId && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-1 text-sm font-semibold text-primary/80 flex items-center gap-1.5">
            <HardDrive className="h-4 w-4" />
            {currentProviderOption?.label} Models
            {currentProviderOption?.batchOnly && (
              <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
                Batch
              </span>
            )}
          </h3>
          {currentProviderOption?.batchOnly && (
            <p className="mb-3 text-xs text-muted-foreground/70">
              Whisper.cpp is for post-meeting batch transcription only — not live streaming.
              It will be available in the "Past Meetings" tab.
            </p>
          )}
          {!currentProviderOption?.batchOnly && (
            <p className="mb-3 text-xs text-muted-foreground">
              Download a model, then click <strong>Activate</strong> to enable this provider.
            </p>
          )}
          <LocalModelManager engineFilter={modelEngineId} />
        </div>
      )}

      {/* Whisper API: optional custom OpenAI-compatible endpoint + model (above the key card) */}
      {isWhisperApi && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <label htmlFor="stt-whisper-endpoint" className="mb-3 block text-sm font-semibold text-primary/80">
            Endpoint
          </label>
          <input
            id="stt-whisper-endpoint"
            type="text"
            value={whisperBaseUrl}
            disabled={!whisperLoaded || whisperTesting}
            onChange={(e) => {
              whisperRevisionRef.current += 1;
              setWhisperBaseUrl(e.target.value);
              setWhisperDirty(true);
              setWhisperEndpointError("");
              setConnectionStatus("idle");
              setStatusMessage("");
            }}
            onBlur={handleSaveWhisperEndpoint}
            placeholder="https://api.openai.com/v1"
            aria-invalid={whisperEndpointError ? true : undefined}
            aria-describedby={
              whisperEndpointError
                ? "stt-whisper-endpoint-error stt-whisper-endpoint-hint"
                : "stt-whisper-endpoint-hint"
            }
            className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 aria-[invalid=true]:border-destructive"
          />
          {whisperEndpointError && (
            <p id="stt-whisper-endpoint-error" role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
              <XCircle className="h-3 w-3" />
              {whisperEndpointError}
            </p>
          )}
          <label htmlFor="stt-whisper-model" className="mb-3 mt-4 block text-sm font-semibold text-primary/80">
            Model
          </label>
          <input
            id="stt-whisper-model"
            type="text"
            value={whisperModel}
            disabled={!whisperLoaded || whisperTesting}
            onChange={(e) => {
              whisperRevisionRef.current += 1;
              setWhisperModel(e.target.value);
              setWhisperDirty(true);
              setConnectionStatus("idle");
              setStatusMessage("");
            }}
            onBlur={handleSaveWhisperEndpoint}
            placeholder="whisper-1"
            aria-describedby="stt-whisper-endpoint-hint"
            className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <p id="stt-whisper-endpoint-hint" className="mt-1.5 text-xs text-muted-foreground">
            Any OpenAI-compatible transcription server, for example a local faster-whisper server. Leave empty for OpenAI.
          </p>
        </div>
      )}

      {/* API Key — cloud providers only. Save & Test flow: test first, persist only on success. */}
      {currentProviderOption?.requiresApiKey && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <label htmlFor="stt-provider-api-key" className="mb-3 block text-sm font-semibold text-primary/80">
            {whisperEndpointSet ? "API key for this server (optional)" : "API Key"}
          </label>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                id="stt-provider-api-key"
                type={showApiKey ? "text" : "password"}
                disabled={credentialsAreLoading || whisperTesting || (selectedProvider === "azure_mai_streaming" && shownConnectionStatus === "testing")}
                value={shownApiKey}
                onChange={(e) => {
                  whisperRevisionRef.current += 1;
                  setApiKey(e.target.value);
                  setKeyDirty(true);
                  setConnectionStatus("idle");
                  setStatusMessage("");
                }}
                placeholder={
                  credentialsAreLoading
                    ? "Checking saved credentials…"
                    : shownHasStoredKey && showMaiKeyReentryHint
                    ? "Re-enter API key to test the updated region"
                    : shownHasStoredKey && !shownKeyDirty
                    ? "Key stored — type to replace"
                    : whisperEndpointSet
                    ? "Optional for local servers"
                    : `Enter ${currentProviderOption.label} API key`
                }
                aria-describedby={showMaiKeyReentryHint ? "stt-mai-key-reentry-hint" : undefined}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                type="button"
                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Save & Test — shown whenever user has typed a key */}
            {(shownKeyDirty ||
              (!shownHasStoredKey && shownApiKey.trim()) ||
              (credentialStateReady && isWhisperApi &&
                (whisperDirty ||
                  (whisperEndpointSet && !verifiedCloudProviders.includes("whisper_api"))))) && (
              <button
                onClick={isWhisperApi ? handleWhisperSaveAndTest : handleSaveAndTest}
                disabled={(!shownApiKey.trim() && !whisperEndpointSet) || shownConnectionStatus === "testing" || credentialsAreLoading}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {shownConnectionStatus === "testing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wifi className="h-3.5 w-3.5" />
                )}
                Save & Test
              </button>
            )}

            {/* Clear — only if key is stored and verified, and user hasn't started typing a new one */}
            {shownHasStoredKey &&
              (selectedProvider === "azure_mai_streaming" ? !shownApiKey.trim() : !shownKeyDirty) && (
              <button
                onClick={handleClearApiKey}
                disabled={whisperTesting}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          {/* Status feedback */}
          <div className="mt-2 min-h-[18px]" role="status" aria-live="polite">
            {credentialsAreLoading && (
              <p className="text-xs text-muted-foreground">Checking saved credentials...</p>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "success" && (
              <div className="flex items-center gap-1.5 text-xs text-success">
                <CheckCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "testing" && (
              <p className="text-xs text-muted-foreground">Testing connection...</p>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "error" && (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "idle" && shownHasStoredKey && !shownKeyDirty && (
              <p className="text-xs text-success/70">
                {selectedProvider === "azure_mai_streaming"
                  ? "API key configured and stored securely"
                  : isWhisperApi && !verifiedCloudProviders.includes("whisper_api")
                  ? "API key stored securely"
                  : "API key verified and stored securely"}
              </p>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "idle" && shownHasStoredKey && showMaiKeyReentryHint && (
              <p id="stt-mai-key-reentry-hint" className="text-xs text-muted-foreground">
                Re-enter the saved API key to test the updated region. Existing credentials remain in use until the test succeeds.
              </p>
            )}
            {!credentialsAreLoading && shownConnectionStatus === "idle" && !shownHasStoredKey && (
              <p className="text-xs text-muted-foreground">
                {whisperEndpointSet
                  ? "Click Save & Test to check the endpoint"
                  : "Enter your key and click Save & Test"}
              </p>
            )}
            {!credentialsAreLoading &&
              whisperEndpointSet &&
              isInsecureRemoteHttp(whisperBaseUrl) &&
              (shownApiKey.trim() || shownHasStoredKey) && (
                <p className="text-xs text-warning">
                  This endpoint uses http:// on another machine, so the key is sent unencrypted.
                </p>
              )}
          </div>
        </div>
      )}

      {/* Azure Region Input */}
      {currentProviderOption?.needsRegion && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <label htmlFor="stt-provider-region" className="mb-3 block text-sm font-semibold text-primary/80">
            {selectedProvider === "azure_mai_streaming" ? "Speech Resource region" : "Azure Region"}
          </label>
          {currentProviderOption.regionOptions ? (
            <select
              id="stt-provider-region"
              value={azureMaiRegion}
              disabled={shownConnectionStatus === "testing"}
              onChange={(e) => {
                setAzureMaiRegion(e.target.value);
                if (selectedProvider === "azure_mai_streaming") setKeyDirty(true);
                setConnectionStatus("idle");
                setStatusMessage("");
              }}
              aria-describedby={`stt-provider-region-description${showMaiKeyReentryHint ? " stt-mai-key-reentry-hint" : ""}`}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            >
              {currentProviderOption.regionOptions.map((region) => (
                <option key={region.value} value={region.value}>
                  {region.label} ({region.value})
                </option>
              ))}
            </select>
          ) : (
            <input
              id="stt-provider-region"
              type="text"
              value={azureRegion}
              onChange={(e) => setAzureRegion(e.target.value)}
              onBlur={handleSaveRegion}
              aria-describedby="stt-provider-region-description"
              placeholder="eastus"
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          )}
          <p id="stt-provider-region-description" className="mt-1.5 text-xs text-muted-foreground">
            {selectedProvider === "azure_mai_streaming"
              ? "Choose the region where your Speech Resource was created. The API key and region are saved only after the connection test succeeds."
              : "Azure region for your Speech Services resource (e.g., eastus, westeurope, southeastasia)"}
          </p>
        </div>
      )}

      {selectedProvider === "azure_mai_streaming" && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-primary/80">Azure MAI Streaming</h3>
            <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-meta font-semibold text-warning">
              Public Preview
            </span>
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-medium text-foreground">MAI-Transcribe-2-Streaming</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Required resource</dt>
              <dd className="font-medium text-foreground">Speech Resource</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Auto-detect uses Microsoft&apos;s default multilingual mode. Choose a specific language below to send it explicitly. Speaker diarization is not supported.
          </p>
          <button
            type="button"
            onClick={() => void open(AZURE_MAI_GUIDE_URL).catch((error) => console.warn("Failed to open Azure MAI guide:", error))}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            Official Microsoft guide
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Universal Pause Detection */}
      <PauseThresholdSetting />

      {/* Deepgram Advanced Settings — shown when Deepgram is selected */}
      {selectedProvider === "deepgram" && <DeepgramAdvancedSettings />}

      {/* Groq Whisper Settings — shown when Groq is selected */}
      {selectedProvider === "groq_whisper" && <GroqAdvancedSettings />}

      {/* Whisper.cpp Dual-Pass Settings */}
      {selectedProvider === "whisper_cpp" && <DualPassSettings />}

      {/* Language Selection */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <h3 className="mb-3 text-sm font-semibold text-primary/80">
          Transcription language
        </h3>
        <select
          value={sttLanguage}
          onChange={(e) => setSTTLanguage(e.target.value)}
          aria-label="Transcription language"
          aria-describedby={autoDetectionSelected || showAutoDetectionWarning ? "provider-stt-auto-description" : undefined}
          className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
        >
          {STT_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
        {(autoDetectionSelected || showAutoDetectionWarning) && (
          <div id="provider-stt-auto-description" className={`mt-2 space-y-1 text-xs ${showAutoDetectionWarning ? "text-warning" : "text-muted-foreground"}`}>
            {showAutoDetectionWarning
              ? autoProblems.map((problem) => <p key={problem}>{problem}</p>)
              : <p>
                  {selectedProvider === "azure_mai_streaming"
                    ? "MAI-Transcribe-2-Streaming uses multilingual mode with automatic language detection by default."
                    : selectedProvider === "deepgram" && isDeepgramNova3(deepgramModel)
                    ? "Nova-3 can transcribe multiple languages within the same sentence."
                    : "For speech that switches languages mid-sentence, use Deepgram Nova-3."}
                </p>}
          </div>
        )}
        {ownLanguageNotes.map((note) => (
          <p key={note} className="mt-2 text-xs text-muted-foreground">{note}</p>
        ))}
        {languageHint && (
          <p className={`mt-2 text-xs ${languageHint.tone === "warning" ? "text-warning" : "text-muted-foreground"}`}>
            {languageHint.text}
          </p>
        )}
        {selectedProvider === "cartesia" && (youLanguage === AUTO_STT_LANGUAGE || cartesiaSupportsLanguage(youLanguage)) && (
          <p className="mt-2 text-xs text-muted-foreground">
            Cartesia detects English, French, Hindi, Japanese and Spanish on its own.
          </p>
        )}
      </div>

      {/* Test Connection — only for local/always-ready providers; cloud uses Save & Test in the key section */}
      {!currentProviderOption?.requiresApiKey && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">Connection</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === "testing"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connectionStatus === "testing" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              Test Connection
            </button>

            {connectionStatus === "success" && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                <span className="text-xs">{statusMessage}</span>
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                <span className="text-xs truncate max-w-[200px]">{statusMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Provider Card ──

function ProviderCard({
  provider,
  isSelected,
  isActive,
  badge,
  onClick,
}: {
  provider: ProviderOption;
  isSelected: boolean;
  isActive: boolean;
  badge: BadgeState;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 bg-card/30 hover:border-border/70 hover:bg-accent/60"
      }`}
    >
      <div className="flex w-full items-start justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <ProviderIcon value={provider.value} isSelected={isSelected} />
          <span className={`text-xs font-medium leading-tight ${isSelected ? "text-primary" : "text-foreground"}`}>
            {provider.label}
          </span>
        </div>
        <ProviderBadge
          text={badge.text}
          variant={badge.variant}
        />
      </div>
      <span className="text-meta text-muted-foreground/70 leading-snug">
        {provider.batchOnly ? "Batch mode only" : provider.description}
      </span>
    </button>
  );
}

// ── Provider Badge ──

function ProviderBadge({ text, variant }: { text: string; variant: BadgeVariant }) {
  const styles: Record<BadgeVariant, string> = {
    ready: "bg-success/20 text-success border-success/20",
    warning: "bg-warning/20 text-warning border-warning/20",
    error: "bg-destructive/20 text-destructive border-destructive/20",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[8px] font-semibold tracking-wide ${styles[variant]}`}
    >
      {text}
    </span>
  );
}

// ── Provider icon helper ──

function ProviderIcon({ value, isSelected }: { value: STTProviderType; isSelected?: boolean }) {
  const cls = `h-3.5 w-3.5 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`;
  switch (value) {
    case "web_speech":
      return <Globe className={cls} />;
    case "windows_native":
      return <Monitor className={cls} />;
    case "whisper_cpp":
    case "sherpa_onnx":
      return <HardDrive className={cls} />;
    case "ort_streaming":
      return <Zap className={cls} />;
    case "parakeet_tdt":
      return <Cpu className={cls} />;
    case "deepgram":
    case "whisper_api":
    case "azure_speech":
    case "azure_mai_streaming":
    case "cartesia":
      return <Cloud className={cls} />;
    case "groq_whisper":
      return <Zap className={cls} />;
    default:
      return <Server className={cls} />;
  }
}

// ── Universal Pause Threshold Setting ──

function PauseThresholdSetting() {
  const pauseThresholdMs = useConfigStore((s) => s.pauseThresholdMs);
  const setPauseThresholdMs = useConfigStore((s) => s.setPauseThresholdMs);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        New Line Pause Duration
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Start a new transcript line after no words detected for this duration.
        Lower values create more lines; higher values create longer paragraphs.
        Applies to all STT providers.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={500}
          max={5000}
          step={100}
          value={pauseThresholdMs}
          onChange={(e) => setPauseThresholdMs(parseInt(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <span className="min-w-[4rem] text-right text-xs font-mono text-primary tabular-nums">
          {(pauseThresholdMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="mt-1.5 flex justify-between text-meta text-muted-foreground/70">
        <span>0.5s (more lines)</span>
        <span>5.0s (longer paragraphs)</span>
      </div>
    </div>
  );
}

// ── Deepgram Advanced Settings ──

function DeepgramAdvancedSettings() {
  const deepgramConfig = useConfigStore((s) => s.deepgramConfig);
  const setDeepgramConfig = useConfigStore((s) => s.setDeepgramConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keytermInput, setKeytermInput] = useState("");

  const activePresetId = DEEPGRAM_PRESETS.find((p) =>
    configMatchesPreset(deepgramConfig, p.config)
  )?.id ?? "custom";

  const applyPreset = (preset: DeepgramPreset) => {
    setDeepgramConfig({ ...preset.config, keyterms: deepgramConfig.keyterms });
  };

  const updateField = <K extends keyof DeepgramConfig>(key: K, value: DeepgramConfig[K]) => {
    setDeepgramConfig({ ...deepgramConfig, [key]: value });
  };

  const addKeyterm = () => {
    const term = keytermInput.trim();
    if (!term || deepgramConfig.keyterms.includes(term) || deepgramConfig.keyterms.length >= 100) return;
    updateField("keyterms", [...deepgramConfig.keyterms, term]);
    setKeytermInput("");
  };

  const removeKeyterm = (term: string) => {
    updateField("keyterms", deepgramConfig.keyterms.filter((k) => k !== term));
  };

  const activeModel = DEEPGRAM_MODELS.find((m) => m.id === deepgramConfig.model);
  // Flux (/v2/listen) detects turns itself and has none of Nova's formatting,
  // endpointing, diarization or dictation options.
  const isFlux = deepgramConfig.model.startsWith("flux-");

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">Deepgram Settings</span>
          {activePresetId !== "custom" && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {DEEPGRAM_PRESETS.find((p) => p.id === activePresetId)?.label}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              Custom
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              ${activeModel.costPerMin.toFixed(4)}/min · {activeModel.label}
            </span>
          )}
        </div>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">Presets</p>
        <div className="flex flex-wrap gap-1.5">
          {DEEPGRAM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={preset.description}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Model</label>
        <div className="grid grid-cols-2 gap-1.5">
          {DEEPGRAM_MODELS.map((model) => {
            const tierColors: Record<string, string> = {
              latest: "text-success",
              flux: "text-info",
              standard: "text-info",
              economy: "text-warning",
              whisper: "text-purple-400",
            };
            return (
              <button
                key={model.id}
                onClick={() => updateField("model", model.id)}
                className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                  deepgramConfig.model === model.id
                    ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                    : "border-border/30 hover:border-border/60 hover:bg-accent/40"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-semibold ${deepgramConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                      {model.label}
                    </span>
                    {model.tier === "latest" && (
                      <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">NEW</span>
                    )}
                  </div>
                  <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{model.description}</p>
                  <p className={`text-meta font-mono mt-0.5 ${tierColors[model.tier]}`}>${model.costPerMin.toFixed(4)}/min</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {isFlux && (
        <div className="px-5 py-3 border-b border-border/20 bg-info/5">
          <p className="text-xs text-foreground/90">
            Flux tells NexQ when each speaker has finished, so Auto-Answer replies right away instead of
            waiting 1.5 s, and can start on a likely finish.
          </p>
          <p className="mt-1 text-meta text-muted-foreground/80">
            It doesn&apos;t tell speakers apart. NexQ streams silence to it, so quiet time counts toward
            Deepgram usage. Muted time doesn&apos;t: muting closes the stream.
          </p>
        </div>
      )}

      {/* Core Feature Toggles (Nova only) */}
      {!isFlux && (<>
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-2 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Features</label>
        <div className="space-y-2">
          <DeepgramToggle
            label="Smart Format"
            param="smart_format"
            description="Formats dates, times, numbers and adds paragraph breaks"
            checked={deepgramConfig.smart_format}
            onChange={(v) => updateField("smart_format", v)}
          />
          <DeepgramToggle
            label="Interim Results"
            param="interim_results"
            description="Show partial transcripts as you speak (lower latency feel)"
            checked={deepgramConfig.interim_results}
            onChange={(v) => updateField("interim_results", v)}
          />
          <DeepgramToggle
            label="Punctuation"
            param="punctuate"
            description="Add punctuation and capitalization to the transcript"
            checked={deepgramConfig.punctuate}
            onChange={(v) => updateField("punctuate", v)}
          />
          <DeepgramToggle
            label="VAD Events"
            param="vad_events"
            description="Emit events when speech starts/ends (improves endpointing)"
            checked={deepgramConfig.vad_events}
            onChange={(v) => updateField("vad_events", v)}
          />
        </div>
      </div>

      {/* Endpointing */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">Endpointing</span>
            <code className="ml-2 text-meta text-muted-foreground/60">endpointing=NUMBER</code>
          </div>
          <button
            onClick={() => updateField("endpointing", deepgramConfig.endpointing === null ? 300 : null)}
            className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
              deepgramConfig.endpointing !== null ? "bg-primary" : "bg-muted"
            }`}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              deepgramConfig.endpointing !== null ? "translate-x-4" : "translate-x-0.5"
            }`} />
          </button>
        </div>
        {deepgramConfig.endpointing !== null && (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta text-muted-foreground">Silence threshold</span>
              <span className="text-meta font-mono text-primary tabular-nums">{deepgramConfig.endpointing}ms</span>
            </div>
            <input
              type="range"
              min={10}
              max={2000}
              step={10}
              value={deepgramConfig.endpointing}
              onChange={(e) => updateField("endpointing", parseInt(e.target.value))}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">10ms (fast)</span>
              <span className="text-meta text-muted-foreground/70">2000ms (slow)</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              Returns transcript when this much silence is detected. 10–999ms gives best results.
            </p>
          </>
        )}
        {deepgramConfig.endpointing === null && (
          <p className="text-meta text-muted-foreground/60">Disabled — server default endpointing used</p>
        )}
      </div>
      </>)}

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">Advanced Settings</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Advanced Feature Toggles */}
          <div className="px-5 py-3 border-b border-border/20 space-y-2">
            {!isFlux && (
              <DeepgramToggle
                label="Tell remote speakers apart"
                param="diarize"
                description="Labels each person on the other side of the call (Speaker 1, 2…). Never applied to your mic."
                checked={deepgramConfig.diarize}
                onChange={(v) => updateField("diarize", v)}
              />
            )}
            <DeepgramToggle
              label="Numerals"
              param="numerals"
              description='Convert spoken numbers to digits ("nine hundred" → "900")'
              checked={deepgramConfig.numerals}
              onChange={(v) => updateField("numerals", v)}
            />
            <DeepgramToggle
              label="Profanity Filter"
              param="profanity_filter"
              description="Remove profanity from the transcript"
              checked={deepgramConfig.profanity_filter}
              onChange={(v) => updateField("profanity_filter", v)}
            />
            {!isFlux && (
              <DeepgramToggle
                label="Dictation"
                param="dictation"
                description='Format spoken punctuation commands ("period" → ".")'
                checked={deepgramConfig.dictation}
                onChange={(v) => updateField("dictation", v)}
              />
            )}
          </div>

          {/* Keyterm Prompting */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">Keyterm Prompting</span>
              <code className="text-meta text-muted-foreground/60">keyterm=TERM</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              Boost recognition of specific words or phrases (product names, jargon). Up to 100 keyterms.
            </p>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={keytermInput}
                onChange={(e) => setKeytermInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addKeyterm(); }}
                placeholder="Add keyterm or phrase…"
                className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={addKeyterm}
                disabled={!keytermInput.trim() || deepgramConfig.keyterms.length >= 100}
                className="rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {deepgramConfig.keyterms.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {deepgramConfig.keyterms.map((term) => (
                  <span
                    key={term}
                    className="flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-2 py-0.5 text-meta text-foreground"
                  >
                    {term}
                    <button
                      onClick={() => removeKeyterm(term)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {deepgramConfig.keyterms.length === 0 && (
              <p className="text-meta text-muted-foreground/70">No keyterms — model uses default recognition</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deepgram Toggle Row ──

function DeepgramToggle({
  label,
  param,
  description,
  checked,
  onChange,
}: {
  label: string;
  param: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <code className="text-meta text-muted-foreground/70">{param}={checked ? "true" : "false"}</code>
        </div>
        <p className="text-meta text-muted-foreground/60 leading-tight mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`shrink-0 relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`} />
      </button>
    </div>
  );
}

// ── Groq Models & Presets ──

interface GroqModelInfo {
  id: string;
  label: string;
  description: string;
  costPerHour: number;
  speedFactor: string;
}

const GROQ_MODELS: GroqModelInfo[] = [
  {
    id: "whisper-large-v3",
    label: "Whisper Large v3",
    description: "Highest accuracy, 99+ languages",
    costPerHour: 0.111,
    speedFactor: "189x",
  },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    description: "Fast + cheap, best price/performance",
    costPerHour: 0.04,
    speedFactor: "216x",
  },
];

interface GroqPreset {
  id: string;
  label: string;
  description: string;
  config: GroqConfig;
}

const GROQ_PRESETS: GroqPreset[] = [
  {
    id: "default",
    label: "Default",
    description: "Balanced — fast model, 5s batches",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
  {
    id: "low_latency",
    label: "Low Latency",
    description: "Shorter 3s batches for faster feedback",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 3.0,
    },
  },
  {
    id: "high_accuracy",
    label: "High Accuracy",
    description: "Best model, longer 8s batches for context",
    config: {
      model: "whisper-large-v3",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 8.0,
    },
  },
  {
    id: "verbose",
    label: "Verbose",
    description: "Word timestamps + segment data",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
];

function groqConfigMatchesPreset(config: GroqConfig, preset: GroqConfig): boolean {
  return (
    config.model === preset.model &&
    config.temperature === preset.temperature &&
    config.response_format === preset.response_format &&
    config.segment_duration_secs === preset.segment_duration_secs &&
    JSON.stringify(config.timestamp_granularities) === JSON.stringify(preset.timestamp_granularities)
    // prompt excluded from preset matching — user-specific
  );
}

// ── Groq Advanced Settings ──

function GroqAdvancedSettings() {
  const groqConfig = useConfigStore((s) => s.groqConfig);
  const setGroqConfig = useConfigStore((s) => s.setGroqConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activePresetId = GROQ_PRESETS.find((p) =>
    groqConfigMatchesPreset(groqConfig, p.config)
  )?.id ?? "custom";

  const applyPreset = (preset: GroqPreset) => {
    setGroqConfig({ ...preset.config, prompt: groqConfig.prompt });
  };

  const updateField = <K extends keyof GroqConfig>(key: K, value: GroqConfig[K]) => {
    setGroqConfig({ ...groqConfig, [key]: value });
  };

  const activeModel = GROQ_MODELS.find((m) => m.id === groqConfig.model);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">Groq Whisper Settings</span>
          {activePresetId !== "custom" && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {GROQ_PRESETS.find((p) => p.id === activePresetId)?.label}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              Custom
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              ${activeModel.costPerHour.toFixed(3)}/hr · {activeModel.speedFactor} real-time
            </span>
          )}
        </div>
        <p className="mt-1.5 text-meta text-muted-foreground/60 leading-tight">
          Batch mode — audio is accumulated and sent every {groqConfig.segment_duration_secs}s.
          Expect {groqConfig.segment_duration_secs + 1}–{groqConfig.segment_duration_secs + 2}s total latency.
        </p>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">Presets</p>
        <div className="flex flex-wrap gap-1.5">
          {GROQ_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={preset.description}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Model</label>
        <div className="grid grid-cols-2 gap-1.5">
          {GROQ_MODELS.map((model) => (
            <button
              key={model.id}
              onClick={() => updateField("model", model.id)}
              className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                groqConfig.model === model.id
                  ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                  : "border-border/30 hover:border-border/60 hover:bg-accent/40"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-semibold ${groqConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                    {model.label}
                  </span>
                  {model.id === "whisper-large-v3-turbo" && (
                    <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">FAST</span>
                  )}
                  {model.id === "whisper-large-v3" && (
                    <span className="rounded bg-info/10 px-1 py-0.5 text-[8px] font-bold text-info">BEST</span>
                  )}
                </div>
                <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{model.description}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-meta font-mono text-success">${model.costPerHour.toFixed(3)}/hr</span>
                  <span className="text-meta text-muted-foreground/70">{model.speedFactor}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Batch Duration */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">Batch Duration</span>
            <code className="ml-2 text-meta text-muted-foreground/60">segment={groqConfig.segment_duration_secs}s</code>
          </div>
        </div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-meta text-muted-foreground">Audio accumulation time</span>
          <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.segment_duration_secs.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min={2}
          max={15}
          step={0.5}
          value={groqConfig.segment_duration_secs}
          onChange={(e) => updateField("segment_duration_secs", parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between mt-0.5">
          <span className="text-meta text-muted-foreground/70">2s (fast, less context)</span>
          <span className="text-meta text-muted-foreground/70">15s (slow, more context)</span>
        </div>
        <p className="mt-1 text-meta text-muted-foreground/60">
          Shorter = faster responses but less context per API call. Minimum billed: 10s.
        </p>
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">Advanced Settings</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Temperature */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">Temperature</span>
                <code className="text-meta text-muted-foreground/70">temperature={groqConfig.temperature}</code>
              </div>
              <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.temperature.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={groqConfig.temperature}
              onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">0 (deterministic)</span>
              <span className="text-meta text-muted-foreground/70">1 (creative)</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              Lower values give more consistent results. 0 is recommended for transcription.
            </p>
          </div>

          {/* Response Format */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-xs font-medium text-foreground">Response Format</span>
              <code className="text-meta text-muted-foreground/70">response_format={groqConfig.response_format}</code>
            </div>
            <div className="flex gap-1.5">
              {(["json", "verbose_json", "text"] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => {
                    updateField("response_format", fmt);
                    // Clear granularities when switching away from verbose_json
                    if (fmt !== "verbose_json") {
                      updateField("timestamp_granularities", []);
                    }
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                    groqConfig.response_format === fmt
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
                  }`}
                >
                  {fmt === "json" ? "JSON" : fmt === "verbose_json" ? "Verbose JSON" : "Text"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-meta text-muted-foreground/60">
              {groqConfig.response_format === "verbose_json"
                ? "Includes segment/word timestamps, confidence scores, and no-speech probability"
                : groqConfig.response_format === "text"
                  ? "Plain text output only — no metadata"
                  : "Standard JSON with text field"}
            </p>
          </div>

          {/* Timestamp Granularities — only for verbose_json */}
          {groqConfig.response_format === "verbose_json" && (
            <div className="px-5 py-3 border-b border-border/20">
              <span className="text-xs font-medium text-foreground mb-2 block">Timestamp Granularities</span>
              <div className="space-y-2">
                {(["segment", "word"] as const).map((gran) => (
                  <DeepgramToggle
                    key={gran}
                    label={gran === "segment" ? "Segment Timestamps" : "Word Timestamps"}
                    param={`timestamp_granularities[]=${gran}`}
                    description={gran === "segment"
                      ? "Include start/end times for each segment"
                      : "Include start/end times for each word"}
                    checked={groqConfig.timestamp_granularities.includes(gran)}
                    onChange={(v) => {
                      const current = groqConfig.timestamp_granularities;
                      const updated = v
                        ? [...current, gran]
                        : current.filter((g) => g !== gran);
                      updateField("timestamp_granularities", updated);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Prompt */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">Prompt</span>
              <code className="text-meta text-muted-foreground/60">prompt</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              Guide transcription style, spelling, or context. Up to 224 tokens. Must match audio language.
            </p>
            <textarea
              value={groqConfig.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder="e.g., NexQ, Tauri, WASAPI, transcription..."
              rows={2}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
            />
            {groqConfig.prompt && (
              <p className="mt-1 text-meta text-muted-foreground/70">
                ~{Math.ceil(groqConfig.prompt.length / 4)} tokens (max 224)
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dual-Pass Settings ──

function DualPassSettings() {
  const dualPass = useConfigStore((s) => s.whisperDualPass);
  const setDualPass = useConfigStore((s) => s.setWhisperDualPass);

  const update = (key: keyof typeof dualPass, value: number) => {
    setDualPass({ ...dualPass, [key]: value });
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        Transcription Tuning
      </h3>
      <p className="mb-4 text-meta text-muted-foreground">
        Dual-pass: fast pass shows words immediately, correction pass refines.
        Changes apply instantly.
      </p>

      <div className="space-y-4">
        <SliderSetting
          label="Fast pass interval"
          value={dualPass.shortChunkSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint="Shorter = faster words but less accurate"
          onChange={(v) => update("shortChunkSecs", v)}
        />
        <SliderSetting
          label="Correction interval"
          value={dualPass.longChunkSecs}
          min={2.0}
          max={8.0}
          step={0.5}
          unit="s"
          hint="Longer = more context for correction"
          onChange={(v) => update("longChunkSecs", v)}
        />
        <SliderSetting
          label="Pause for new line"
          value={dualPass.pauseSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint="Silence before starting a new transcript line"
          onChange={(v) => update("pauseSecs", v)}
        />
      </div>
    </div>
  );
}

function SliderSetting({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-foreground">{label}</label>
        <span className="text-xs font-mono text-primary tabular-nums">
          {value.toFixed(1)}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
      />
      <p className="mt-0.5 text-meta text-muted-foreground/60">{hint}</p>
    </div>
  );
}
