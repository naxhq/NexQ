import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type {
  ThemeMode,
  LLMProviderType,
  CustomLlmAuthType,
  MeetingDetectionConfig,
  STTProviderType,
  HotkeyConfig,
  MeetingAudioConfig,
  ContextStrategy,
  WhisperDualPassConfig,
  DeepgramConfig,
  GroqConfig,
  AudioMode,
  AIScenario,
  ClaudeCliConfig,
  ClaudeModelInfo,
  ContextScopeSetting,
} from "../lib/types";
import { clampMinutes, DEFAULT_CONTEXT_SCOPE, SCOPE_KINDS } from "../lib/contextScope";

const DEFAULT_DEEPGRAM_CONFIG: DeepgramConfig = {
  model: "nova-3",
  smart_format: false,
  interim_results: true,
  endpointing: 300,
  punctuate: true,
  diarize: true,
  profanity_filter: false,
  numerals: false,
  dictation: false,
  vad_events: true,
  keyterms: [],
};

const DEFAULT_GROQ_CONFIG: GroqConfig = {
  model: "whisper-large-v3-turbo",
  language: "en",
  temperature: 0,
  response_format: "json",
  timestamp_granularities: [],
  prompt: "",
  segment_duration_secs: 5.0,
};

const STORE_FILE = "config.json";

/** Claude CLI defaults (mirror Rust `ClaudeCliConfig::default`). */
export const DEFAULT_CLAUDE_CLI_CONFIG: ClaudeCliConfig = {
  fast_model: "haiku",
  fast_effort: "low",
  deep_model: "sonnet",
  deep_effort: "medium",
  fast_thinking: false,
  deep_thinking: true,
  fallback_provider: null,
  fallback_model: null,
};

/**
 * Providers that can stand in for Claude CLI. "custom" is left out: the
 * fallback is built from the provider type alone and custom needs its URL.
 */
export const CLAUDE_FALLBACK_PROVIDERS: LLMProviderType[] = [
  "ollama", "lm_studio", "openai", "anthropic", "groq", "gemini", "openrouter",
];

function isFallbackCandidate(provider: string): boolean {
  return (CLAUDE_FALLBACK_PROVIDERS as string[]).includes(provider);
}

/** Push the Claude CLI config to the backend, which holds it in memory only. */
function pushClaudeCliConfig(config: ClaudeCliConfig): void {
  import("../lib/ipc").then(({ setClaudeCliConfig }) =>
    setClaudeCliConfig(config).catch((e) => {
      console.warn("[configStore] Failed to push Claude CLI config:", e);
      import("./toastStore").then(({ showToast }) =>
        showToast(`Claude settings not applied: ${e instanceof Error ? e.message : String(e)}`, "error")
      );
    })
  );
}

const DEFAULT_HOTKEYS: HotkeyConfig = {
  toggle_assist: "Space",
  start_end_meeting: "Ctrl+M",
  show_hide: "Ctrl+B",
  open_settings: "Ctrl+,",
  escape: "Escape",
  mode_assist: "Space",
  mode_say: "1",
  mode_shorten: "2",
  mode_followup: "3",
  mode_recap: "4",
  mode_ask: "5",
};

// Singleton store instance, lazily initialized
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

/**
 * Persist a key-value pair to the Tauri plugin-store.
 * Fire-and-forget: errors are logged but do not block the UI.
 */
/** A saved/synced scope with a known kind and minutes in range (else the default). */
function normalizeContextScope(value: Partial<ContextScopeSetting> | null | undefined): ContextScopeSetting {
  if (!value || !SCOPE_KINDS.includes(value.kind as ContextScopeSetting["kind"])) return DEFAULT_CONTEXT_SCOPE;
  return { kind: value.kind as ContextScopeSetting["kind"], minutes: clampMinutes(value.minutes ?? DEFAULT_CONTEXT_SCOPE.minutes) };
}

/**
 * Backend config JSON for `provider` from what is stored: its API key, or for
 * the custom provider the persisted base URL, auth type and token (saved in
 * the credential manager under "custom").
 */
async function storedProviderConfig(provider: LLMProviderType): Promise<string> {
  const { getApiKey } = await import("../lib/ipc");
  const config: Record<string, unknown> = { provider_type: provider };
  if (provider === "custom") {
    const { customLlmBaseUrl, customLlmAuthType } = useConfigStore.getState();
    if (customLlmBaseUrl) config.base_url = customLlmBaseUrl;
    if (customLlmAuthType !== "none") {
      config.auth_type = customLlmAuthType;
      const token = await getApiKey("custom").catch(() => null);
      if (token) config.auth_value = token;
    }
  } else if (provider !== "claude_cli") {
    const key = await getApiKey(provider).catch(() => null);
    if (key) config.api_key = key;
  }
  return JSON.stringify(config);
}

/** Meeting detection defaults: on for the main meeting apps. */
export const DEFAULT_MEETING_DETECTION: MeetingDetectionConfig = {
  enabled: true,
  zoom: true,
  teams: true,
  google_meet: true,
  webex: true,
  slack: false,
  discord: false,
  auto_dismiss_secs: 60,
  default_scenario: "team_meeting",
  check_interval_secs: 3,
};

function pushMeetingDetection(config: MeetingDetectionConfig): void {
  import("../lib/ipc").then(({ setMeetingDetectionConfig }) =>
    setMeetingDetectionConfig(config).catch((e) =>
      console.warn("[configStore] Failed to apply meeting detection settings:", e),
    ),
  );
}

/** Default global shortcut for stealth mode (Cmd on macOS, Ctrl elsewhere). */
export const DEFAULT_STEALTH_SHORTCUT = "CmdOrCtrl+Shift+H";
/** Assist from any app during a meeting (Space only works in the overlay). */
export const DEFAULT_ASSIST_SHORTCUT = "CmdOrCtrl+Shift+Space";

export async function persistValue(key: string, value: unknown): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch (err) {
    console.error(`[configStore] Failed to persist "${key}":`, err);
  }
}

interface ConfigState {
  // Appearance
  theme: ThemeMode;

  // Providers
  sttProvider: STTProviderType;
  sttLanguage: string;
  llmProvider: LLMProviderType;
  llmModel: string;
  /** Last model used with each provider (default model of the Claude fallback). */
  lastModelByProvider: Record<string, string>;

  // Claude CLI (subscription) settings; the backend gets a copy on load and on change.
  claudeCliConfig: ClaudeCliConfig;
  /**
   * The user picked the fallback themselves. Until then the fallback follows
   * the last active non-CLI provider and its model.
   */
  claudeCliFallbackPinned: boolean;
  /**
   * Last model catalog the Claude CLI reported (refreshed by the launcher on
   * every start and on Check connection). Null until fetched once; the
   * pickers then offer the static aliases.
   */
  claudeModels: ClaudeModelInfo[] | null;
  // Custom LLM provider (persisted so a custom endpoint survives restarts).
  // The auth token itself is stored via the credential manager under "custom".
  customLlmBaseUrl: string;
  customLlmAuthType: CustomLlmAuthType;

  // Audio (legacy — kept for backward compat, new code uses meetingAudioConfig)
  micDeviceId: string | null;
  systemDeviceId: string | null;
  recordingEnabled: boolean;

  // Two-Party Audio Config (new)
  meetingAudioConfig: MeetingAudioConfig | null;

  // User-saved custom presets (persisted)
  customPresets: MeetingAudioConfig[];

  // Local STT — globally active whisper model (e.g., "base", "small")
  activeWhisperModel: string | null;

  // Per-engine active models — each engine independently selects its own model
  // Keys are engine IDs (e.g., "sherpa_onnx", "ort_streaming", "whisper_cpp")
  activeModelPerEngine: Record<string, string>;

  // Cloud providers that have been tested and verified (persisted)
  verifiedCloudProviders: string[];

  // Whisper dual-pass config
  whisperDualPass: WhisperDualPassConfig;

  // Deepgram model/feature config
  deepgramConfig: DeepgramConfig;

  // Groq Whisper config
  groqConfig: GroqConfig;

  // Universal pause threshold for transcript line-breaking (ms)
  pauseThresholdMs: number;

  // Intelligence
  autoTrigger: boolean;
  autoSummary: boolean;
  contextWindowSeconds: number;

  // System
  startOnLogin: boolean;
  dataDirectory: string;
  firstRunCompleted: boolean;

  // Hotkeys
  hotkeys: HotkeyConfig;

  // Context Strategy
  contextStrategy: ContextStrategy;

  // In-person meeting mode settings
  rememberedMeetingSetup: { audioMode: AudioMode; scenario: AIScenario } | null;
  diarizationEnabled: boolean;
  noisePreset: string | null;
  confidenceThreshold: number;
  confidenceHighlightEnabled: boolean;

  // Typeset settings
  transcriptFontSize: number;
  translationFontSize: number;
  transcriptTextColor: string;
  translationTextColor: string;
  aiResponseTextColor: string;
  aiResponseFontSize: number;
  aiResponseLineHeight: number;
  aiResponseHPad: number;
  aiResponseAlign: "left" | "center" | "right";

  // Overlay appearance
  overlayOpacity: number;

  // Transcript scope of user actions (overlay picker)
  contextScope: ContextScopeSetting;
  /** Keep the picked scope for the next actions; off = back to the default after one action. */
  contextScopeSticky: boolean;

  // Post-meeting translation
  showPostMeetingTranslation: boolean;

  // OpenRouter catalog
  openrouterFavorites: string[];
  openrouterRecentlyUsed: string[];

  // Tray settings
  trayNotifications: boolean;
  trayAutoStart: boolean;
  trayStartMinimized: boolean;
  trayAutoDetectMeeting: boolean;
  trayStealthEnabled: boolean;
  /**
   * Stealth mode ("Hide from screen share"): NexQ's windows stay visible to
   * the user but are left out of screen sharing, recordings and screenshots.
   */
  stealthMode: boolean;
  /** Global shortcut that toggles stealth mode. */
  stealthShortcut: string;
  assistShortcut: string;
  /** Offer to start NexQ when Zoom, Teams, Meet… start a call. */
  meetingDetection: MeetingDetectionConfig;

  // Loading state
  _loaded: boolean;

  // Mute state (non-persisted, session-only — resets on app restart)
  mutedYou: boolean;
  mutedThem: boolean;
  toggleMuteYou: () => void;
  toggleMuteThem: () => void;

  // Actions
  setTheme: (theme: ThemeMode) => void;
  setContextStrategy: (strategy: ContextStrategy) => void;
  setSTTProvider: (provider: STTProviderType) => void;
  setSTTLanguage: (language: string) => void;
  setLLMProvider: (provider: LLMProviderType) => void;
  /**
   * Set the active model. `provider` names the model's provider (defaults to
   * the active one); the model is remembered for that provider.
   */
  setLLMModel: (model: string, provider?: string) => void;
  /**
   * Make `provider` the active LLM: backend first, then this store (persisted,
   * so every window follows) and mark it verified. The single activation
   * path: Settings, the Claude panel, the footer and the first-run wizard. `model` defaults to the model last used with the provider; Claude
   * always takes its Fast model. `providerConfig` is the backend config JSON
   * (defaults to the provider type plus its stored API key). Throws when the
   * backend refuses the provider (nothing changes) or the model (the
   * provider is switched, the model is not recorded).
   */
  activateLLMProvider: (
    provider: LLMProviderType,
    options?: { model?: string; providerConfig?: string },
  ) => Promise<void>;
  /** Remember `model` as the last one used with `provider` (no activation). */
  rememberModel: (provider: string, model: string) => void;
  /** Replace the Claude CLI config (persisted + pushed to the backend). */
  setClaudeCliConfig: (config: ClaudeCliConfig) => void;
  /** The user's fallback choice: pins it so it no longer follows the active provider. */
  setClaudeCliFallback: (provider: string | null, model: string | null) => void;
  /** Keep the latest Claude model catalog (persisted, shared with every window). */
  setClaudeModels: (models: ClaudeModelInfo[]) => void;
  setCustomLlmConfig: (baseUrl: string, authType: CustomLlmAuthType) => void;
  setMicDeviceId: (id: string | null) => void;
  setSystemDeviceId: (id: string | null) => void;
  setRecordingEnabled: (enabled: boolean) => void;
  setMeetingAudioConfig: (config: MeetingAudioConfig) => void;
  saveCustomPreset: (name: string) => void;
  deleteCustomPreset: (name: string) => void;
  setActiveWhisperModel: (modelId: string | null) => void;
  setActiveModelForEngine: (engineId: string, modelId: string | null) => void;
  getActiveModelForEngine: (engineId: string) => string | null;
  setWhisperDualPass: (config: WhisperDualPassConfig) => void;
  setDeepgramConfig: (config: DeepgramConfig) => void;
  setGroqConfig: (config: GroqConfig) => void;
  setPauseThresholdMs: (ms: number) => void;
  setAutoTrigger: (enabled: boolean) => void;
  setAutoSummary: (enabled: boolean) => void;
  setContextWindowSeconds: (seconds: number) => void;
  setStartOnLogin: (enabled: boolean) => void;
  setDataDirectory: (dir: string) => void;
  setFirstRunCompleted: (completed: boolean) => void;
  setHotkeys: (hotkeys: HotkeyConfig) => void;
  setVerifiedCloudProviders: (providers: string[]) => void;
  setRememberedMeetingSetup: (setup: { audioMode: AudioMode; scenario: AIScenario } | null) => void;
  setDiarizationEnabled: (enabled: boolean) => void;
  setNoisePreset: (preset: string | null) => void;
  setConfidenceThreshold: (threshold: number) => void;
  setConfidenceHighlightEnabled: (enabled: boolean) => void;
  setTranscriptFontSize: (size: number) => void;
  setTranslationFontSize: (size: number) => void;
  setTranscriptTextColor: (color: string) => void;
  setTranslationTextColor: (color: string) => void;
  setAiResponseTextColor: (color: string) => void;
  setAiResponseFontSize: (size: number) => void;
  setAiResponseLineHeight: (v: number) => void;
  setAiResponseHPad: (v: number) => void;
  setAiResponseAlign: (align: "left" | "center" | "right") => void;
  setOverlayOpacity: (opacity: number) => void;
  setContextScope: (scope: ContextScopeSetting) => void;
  setContextScopeSticky: (sticky: boolean) => void;
  setShowPostMeetingTranslation: (enabled: boolean) => void;
  toggleOpenRouterFavorite: (id: string) => void;
  addOpenRouterRecentlyUsed: (id: string) => void;
  removeOpenRouterRecentlyUsed: (id: string) => void;
  clearOpenRouterRecentlyUsed: () => void;
  setTrayNotifications: (enabled: boolean) => void;
  setTrayAutoStart: (enabled: boolean) => void;
  setTrayStartMinimized: (enabled: boolean) => void;
  setTrayAutoDetectMeeting: (enabled: boolean) => void;
  setTrayStealthEnabled: (enabled: boolean) => void;
  /** Turn stealth mode on/off (backend first; throws if it refuses, nothing changes). */
  setStealthMode: (enabled: boolean) => Promise<void>;
  /** Record a stealth change the backend already applied (tray toggle). */
  stealthModeApplied: (enabled: boolean) => void;
  setStealthShortcut: (shortcut: string) => void;
  setAssistShortcut: (shortcut: string) => void;
  /** Replace the meeting detection settings (persisted + pushed to the backend). */
  setMeetingDetection: (config: MeetingDetectionConfig) => void;
  loadConfig: () => Promise<void>;
}

/**
 * While the fallback is not pinned, point it at `provider` (a non-CLI
 * provider just made active) with the last model used there.
 */
function followFallback(provider: string): void {
  const state = useConfigStore.getState();
  if (state.claudeCliFallbackPinned || !isFallbackCandidate(provider)) return;
  const model = state.lastModelByProvider[provider] ?? null;
  const cfg = state.claudeCliConfig;
  if (cfg.fallback_provider === provider && cfg.fallback_model === model) return;
  state.setClaudeCliConfig({ ...cfg, fallback_provider: provider, fallback_model: model });
}

export const useConfigStore = create<ConfigState>((set) => ({
  theme: "dark",
  sttProvider: "windows_native",
  sttLanguage: "en-US",
  llmProvider: "ollama",
  llmModel: "",
  lastModelByProvider: {},
  claudeCliConfig: DEFAULT_CLAUDE_CLI_CONFIG,
  claudeCliFallbackPinned: false,
  claudeModels: null,
  customLlmBaseUrl: "",
  customLlmAuthType: "none",
  micDeviceId: null,
  systemDeviceId: null,
  recordingEnabled: false,
  meetingAudioConfig: null,
  customPresets: [],
  activeWhisperModel: null,
  activeModelPerEngine: {},
  verifiedCloudProviders: [],
  whisperDualPass: { shortChunkSecs: 1.0, longChunkSecs: 3.0, pauseSecs: 1.5 },
  deepgramConfig: DEFAULT_DEEPGRAM_CONFIG,
  groqConfig: DEFAULT_GROQ_CONFIG,
  pauseThresholdMs: 3000,
  autoTrigger: true,
  autoSummary: true,
  contextWindowSeconds: 120,
  startOnLogin: false,
  dataDirectory: "",
  firstRunCompleted: false,
  contextStrategy: "stuffing",
  hotkeys: DEFAULT_HOTKEYS,
  rememberedMeetingSetup: null,
  diarizationEnabled: true,
  noisePreset: null,
  confidenceThreshold: 0.7,
  confidenceHighlightEnabled: true,
  transcriptFontSize: 13,
  translationFontSize: 12,
  transcriptTextColor: "#e4e4e7",
  translationTextColor: "#fbbf24",
  aiResponseTextColor: "#d4d4d8",
  aiResponseFontSize: 12,
  aiResponseLineHeight: 1.6,
  aiResponseHPad: 0,
  aiResponseAlign: "left" as const,
  overlayOpacity: 0.65,
  contextScope: DEFAULT_CONTEXT_SCOPE,
  contextScopeSticky: true,
  showPostMeetingTranslation: true,
  openrouterFavorites: [],
  openrouterRecentlyUsed: [],
  trayNotifications: true,
  trayAutoStart: false,
  trayStartMinimized: true,
  trayAutoDetectMeeting: false,
  trayStealthEnabled: true,
  stealthMode: false,
  stealthShortcut: DEFAULT_STEALTH_SHORTCUT,
  assistShortcut: DEFAULT_ASSIST_SHORTCUT,
  meetingDetection: DEFAULT_MEETING_DETECTION,
  _loaded: false,
  mutedYou: false,
  mutedThem: false,
  toggleMuteYou: () => {
    const next = !useConfigStore.getState().mutedYou;
    set({ mutedYou: next });
    import("../lib/ipc").then(({ setSourceMuted }) =>
      setSourceMuted("you", next)
        .catch((e) => console.warn("[configStore] Failed to set You muted:", e))
    );
  },
  toggleMuteThem: () => {
    const next = !useConfigStore.getState().mutedThem;
    set({ mutedThem: next });
    import("../lib/ipc").then(({ setSourceMuted }) =>
      setSourceMuted("them", next)
        .catch((e) => console.warn("[configStore] Failed to set Them muted:", e))
    );
  },

  setContextStrategy: (strategy) => {
    set({ contextStrategy: strategy });
    persistValue("contextStrategy", strategy);
  },
  setTheme: (theme) => {
    set({ theme });
    persistValue("theme", theme);
  },
  setSTTProvider: (provider) => {
    set({ sttProvider: provider });
    persistValue("sttProvider", provider);
  },
  setSTTLanguage: (language) => {
    set({ sttLanguage: language });
    persistValue("sttLanguage", language);
    // Apply immediately to Rust backend
    import("../lib/ipc").then(({ setSTTLanguage: setBackendSTTLanguage }) =>
      setBackendSTTLanguage(language)
        .catch((e) => console.warn("[configStore] Failed to update STT language:", e))
    );
  },
  setLLMProvider: (provider) => {
    set({ llmProvider: provider });
    persistValue("llmProvider", provider);
    followFallback(provider);
  },
  setLLMModel: (model, provider) => {
    set({ llmModel: model });
    persistValue("llmModel", model);
    useConfigStore.getState().rememberModel(provider ?? useConfigStore.getState().llmProvider, model);
  },
  activateLLMProvider: async (provider, options = {}) => {
    const ipc = await import("../lib/ipc");
    const before = useConfigStore.getState();
    let providerConfig = options.providerConfig;
    if (providerConfig == null) providerConfig = await storedProviderConfig(provider);
    await ipc.setLLMProvider(providerConfig);
    before.setLLMProvider(provider);
    // An activated provider counts as verified (the "Ready" badge in Settings).
    const verified = useConfigStore.getState().verifiedCloudProviders;
    if (!verified.includes(provider)) useConfigStore.getState().setVerifiedCloudProviders([...verified, provider]);
    // Claude ignores the model (Fast / Deep come from its settings) but the
    // backend needs one: its Fast model fills the slot.
    const model =
      provider === "claude_cli"
        ? useConfigStore.getState().claudeCliConfig.fast_model
        : options.model || before.lastModelByProvider[provider] || "";
    // Without a model, Claude's Fast model must not carry over to the new provider.
    if (model || before.llmProvider === "claude_cli") {
      try {
        await ipc.setActiveModel(provider, model);
      } catch (e) {
        // The backend kept its previous model: don't record one it refused.
        throw new Error(`model ${model || "(none)"} not applied: ${e instanceof Error ? e.message : String(e)}`);
      }
      useConfigStore.getState().setLLMModel(model, provider);
    }
  },
  rememberModel: (provider, model) => {
    if (!model || provider === "claude_cli") return;
    const { lastModelByProvider } = useConfigStore.getState();
    if (lastModelByProvider[provider] !== model) {
      const next = { ...lastModelByProvider, [provider]: model };
      set({ lastModelByProvider: next });
      persistValue("lastModelByProvider", next);
    }
    // An unpinned fallback on this provider tracks its latest model.
    const { claudeCliFallbackPinned, claudeCliConfig: cfg } = useConfigStore.getState();
    if (!claudeCliFallbackPinned && cfg.fallback_provider === provider && cfg.fallback_model !== model) {
      useConfigStore.getState().setClaudeCliConfig({ ...cfg, fallback_model: model });
    }
  },
  setClaudeCliConfig: (config) => {
    const { llmProvider, llmModel } = useConfigStore.getState();
    set({ claudeCliConfig: config });
    persistValue("claudeCliConfig", config);
    pushClaudeCliConfig(config);
    // While Claude is active the generic model slot mirrors the Fast model:
    // the provider ignores it, but the backend needs one and the footer shows it.
    if (llmProvider === "claude_cli" && llmModel !== config.fast_model) {
      set({ llmModel: config.fast_model });
      persistValue("llmModel", config.fast_model);
      import("../lib/ipc").then(({ setActiveModel }) =>
        setActiveModel("claude_cli", config.fast_model)
          .catch((e) => console.warn("[configStore] Failed to set Claude model:", e))
      );
    }
  },
  setClaudeModels: (models) => {
    set({ claudeModels: models });
    persistValue("claudeModels", models);
  },
  setClaudeCliFallback: (provider, model) => {
    set({ claudeCliFallbackPinned: true });
    persistValue("claudeCliFallbackPinned", true);
    const cfg = useConfigStore.getState().claudeCliConfig;
    useConfigStore.getState().setClaudeCliConfig({
      ...cfg,
      fallback_provider: provider,
      fallback_model: provider ? model : null,
    });
  },
  setCustomLlmConfig: (baseUrl, authType) => {
    set({ customLlmBaseUrl: baseUrl, customLlmAuthType: authType });
    persistValue("customLlmBaseUrl", baseUrl);
    persistValue("customLlmAuthType", authType);
  },
  setMicDeviceId: (id) => {
    set({ micDeviceId: id });
    persistValue("micDeviceId", id);
  },
  setSystemDeviceId: (id) => {
    set({ systemDeviceId: id });
    persistValue("systemDeviceId", id);
  },
  setRecordingEnabled: (enabled) => {
    set({ recordingEnabled: enabled });
    persistValue("recordingEnabled", enabled);
  },
  setMeetingAudioConfig: (config) => {
    set({ meetingAudioConfig: config });
    persistValue("meetingAudioConfig", config);
    // Keep legacy fields in sync for backward compatibility
    set({
      micDeviceId: config.you.device_id || null,
      systemDeviceId: config.them.device_id || null,
      recordingEnabled: config.recording_enabled,
    });
    persistValue("micDeviceId", config.you.device_id || null);
    persistValue("systemDeviceId", config.them.device_id || null);
    persistValue("recordingEnabled", config.recording_enabled);
  },
  saveCustomPreset: (name) => {
    const state = useConfigStore.getState();
    if (!state.meetingAudioConfig) return;
    const preset: MeetingAudioConfig = {
      ...state.meetingAudioConfig,
      preset_name: name,
    };
    // Replace if exists, else append
    const existing = state.customPresets.filter((p) => p.preset_name !== name);
    const updated = [...existing, preset];
    set({ customPresets: updated });
    persistValue("customPresets", updated);
  },
  deleteCustomPreset: (name) => {
    const state = useConfigStore.getState();
    const updated = state.customPresets.filter((p) => p.preset_name !== name);
    set({ customPresets: updated });
    persistValue("customPresets", updated);
  },
  setActiveWhisperModel: (modelId) => {
    set({ activeWhisperModel: modelId });
    persistValue("activeWhisperModel", modelId);
    // Also update local_model_id on any party using whisper_cpp
    const state = useConfigStore.getState();
    if (state.meetingAudioConfig && modelId) {
      const cfg = { ...state.meetingAudioConfig };
      let changed = false;
      if (cfg.you.stt_provider === "whisper_cpp") {
        cfg.you = { ...cfg.you, local_model_id: modelId };
        changed = true;
      }
      if (cfg.them.stt_provider === "whisper_cpp") {
        cfg.them = { ...cfg.them, local_model_id: modelId };
        changed = true;
      }
      if (changed) {
        set({ meetingAudioConfig: cfg });
        persistValue("meetingAudioConfig", cfg);
      }
    }
  },
  setActiveModelForEngine: (engineId, modelId) => {
    const state = useConfigStore.getState();
    const updated = { ...state.activeModelPerEngine };
    if (modelId) {
      updated[engineId] = modelId;
    } else {
      delete updated[engineId];
    }
    set({ activeModelPerEngine: updated });
    persistValue("activeModelPerEngine", updated);
    // Dev log: model activation
    import("../stores/devLogStore").then(({ useDevLogStore }) => {
      useDevLogStore.getState().addEntry(
        "info", "config",
        `Model activated: ${engineId} → ${modelId ?? "none"}`
      );
    });
    // Also update local_model_id on any party using this engine
    if (state.meetingAudioConfig && modelId) {
      const cfg = { ...state.meetingAudioConfig };
      let changed = false;
      if (cfg.you.stt_provider === engineId) {
        cfg.you = { ...cfg.you, local_model_id: modelId };
        changed = true;
      }
      if (cfg.them.stt_provider === engineId) {
        cfg.them = { ...cfg.them, local_model_id: modelId };
        changed = true;
      }
      if (changed) {
        set({ meetingAudioConfig: cfg });
        persistValue("meetingAudioConfig", cfg);
        import("../stores/devLogStore").then(({ useDevLogStore }) => {
          useDevLogStore.getState().addEntry(
            "info", "config",
            `Model change propagated to audio config` +
            (cfg.you.stt_provider === engineId ? ` (You → ${modelId})` : "") +
            (cfg.them.stt_provider === engineId ? ` (Them → ${modelId})` : "")
          );
        });
      }
    }
  },
  getActiveModelForEngine: (engineId: string): string | null => {
    const state = useConfigStore.getState();
    return state.activeModelPerEngine[engineId] ?? null;
  },
  setWhisperDualPass: (config) => {
    set({ whisperDualPass: config });
    persistValue("whisperDualPass", config);
    // Apply immediately to Rust backend
    import("../lib/ipc").then(({ updateWhisperDualPassConfig }) =>
      updateWhisperDualPassConfig(config.shortChunkSecs, config.longChunkSecs, config.pauseSecs)
        .catch((e) => console.warn("[configStore] Failed to update whisper dual-pass config:", e))
    );
  },
  setDeepgramConfig: (config) => {
    set({ deepgramConfig: config });
    persistValue("deepgramConfig", config);
    // Apply immediately to Rust backend
    import("../lib/ipc").then(({ updateDeepgramConfig }) =>
      updateDeepgramConfig(config)
        .catch((e) => console.warn("[configStore] Failed to update Deepgram config:", e))
    );
  },
  setGroqConfig: (config) => {
    set({ groqConfig: config });
    persistValue("groqConfig", config);
    // Apply immediately to Rust backend
    import("../lib/ipc").then(({ updateGroqConfig }) =>
      updateGroqConfig(config)
        .catch((e) => console.warn("[configStore] Failed to update Groq config:", e))
    );
  },
  setPauseThresholdMs: (ms) => {
    set({ pauseThresholdMs: ms });
    persistValue("pauseThresholdMs", ms);
    // Apply immediately to Rust backend
    import("../lib/ipc").then(({ setPauseThreshold }) =>
      setPauseThreshold(ms)
        .catch((e) => console.warn("[configStore] Failed to update pause threshold:", e))
    );
  },
  setAutoTrigger: (enabled) => {
    set({ autoTrigger: enabled });
    persistValue("autoTrigger", enabled);
  },
  setAutoSummary: (enabled) => {
    set({ autoSummary: enabled });
    persistValue("autoSummary", enabled);
  },
  setContextWindowSeconds: (seconds) => {
    set({ contextWindowSeconds: seconds });
    persistValue("contextWindowSeconds", seconds);
  },
  setStartOnLogin: (enabled) => {
    set({ startOnLogin: enabled });
    persistValue("startOnLogin", enabled);
  },
  setDataDirectory: (dir) => {
    set({ dataDirectory: dir });
    persistValue("dataDirectory", dir);
  },
  setFirstRunCompleted: (completed) => {
    set({ firstRunCompleted: completed });
    persistValue("firstRunCompleted", completed);
  },
  setHotkeys: (hotkeys) => {
    set({ hotkeys });
    persistValue("hotkeys", hotkeys);
  },
  setVerifiedCloudProviders: (providers) => {
    set({ verifiedCloudProviders: providers });
    persistValue("verifiedCloudProviders", providers);
  },
  setRememberedMeetingSetup: (setup) => {
    set({ rememberedMeetingSetup: setup });
    persistValue("rememberedMeetingSetup", setup);
  },
  setDiarizationEnabled: (enabled) => {
    set({ diarizationEnabled: enabled });
    persistValue("diarizationEnabled", enabled);
  },
  setNoisePreset: (preset) => {
    set({ noisePreset: preset });
    persistValue("noisePreset", preset);
  },
  setConfidenceThreshold: (threshold) => {
    set({ confidenceThreshold: threshold });
    persistValue("confidenceThreshold", threshold);
  },
  setConfidenceHighlightEnabled: (enabled) => {
    set({ confidenceHighlightEnabled: enabled });
    persistValue("confidenceHighlightEnabled", enabled);
  },
  setTranscriptFontSize: (size) => {
    set({ transcriptFontSize: size });
    persistValue("transcriptFontSize", size);
  },
  setTranslationFontSize: (size) => {
    set({ translationFontSize: size });
    persistValue("translationFontSize", size);
  },
  setTranscriptTextColor: (color) => {
    set({ transcriptTextColor: color });
    persistValue("transcriptTextColor", color);
  },
  setTranslationTextColor: (color) => {
    set({ translationTextColor: color });
    persistValue("translationTextColor", color);
  },
  setAiResponseTextColor: (color) => {
    set({ aiResponseTextColor: color });
    persistValue("aiResponseTextColor", color);
  },
  setAiResponseFontSize: (size) => {
    set({ aiResponseFontSize: size });
    persistValue("aiResponseFontSize", size);
  },
  setAiResponseLineHeight: (v) => {
    set({ aiResponseLineHeight: v });
    persistValue("aiResponseLineHeight", v);
  },
  setAiResponseHPad: (v) => {
    set({ aiResponseHPad: v });
    persistValue("aiResponseHPad", v);
  },
  setAiResponseAlign: (align) => {
    set({ aiResponseAlign: align });
    persistValue("aiResponseAlign", align);
  },
  setOverlayOpacity: (opacity) => {
    set({ overlayOpacity: opacity });
    persistValue("overlayOpacity", opacity);
  },
  setContextScope: (scope) => {
    const next = normalizeContextScope(scope);
    set({ contextScope: next });
    persistValue("contextScope", next);
  },
  setContextScopeSticky: (sticky) => {
    set({ contextScopeSticky: sticky });
    persistValue("contextScopeSticky", sticky);
  },
  setShowPostMeetingTranslation: (enabled) => {
    set({ showPostMeetingTranslation: enabled });
    persistValue("showPostMeetingTranslation", enabled);
  },
  toggleOpenRouterFavorite: (id) => {
    const { openrouterFavorites } = useConfigStore.getState();
    const next = openrouterFavorites.includes(id)
      ? openrouterFavorites.filter((fav) => fav !== id)
      : [...openrouterFavorites, id];
    set({ openrouterFavorites: next });
    persistValue("openrouterFavorites", next);
  },
  addOpenRouterRecentlyUsed: (id) => {
    const { openrouterRecentlyUsed } = useConfigStore.getState();
    const next = [id, ...openrouterRecentlyUsed.filter((r) => r !== id)].slice(0, 5);
    set({ openrouterRecentlyUsed: next });
    persistValue("openrouterRecentlyUsed", next);
  },
  removeOpenRouterRecentlyUsed: (id) => {
    const { openrouterRecentlyUsed } = useConfigStore.getState();
    const next = openrouterRecentlyUsed.filter((r) => r !== id);
    set({ openrouterRecentlyUsed: next });
    persistValue("openrouterRecentlyUsed", next);
  },
  clearOpenRouterRecentlyUsed: () => {
    set({ openrouterRecentlyUsed: [] });
    persistValue("openrouterRecentlyUsed", []);
  },
  setTrayNotifications: (enabled) => {
    set({ trayNotifications: enabled });
    persistValue("trayNotifications", enabled);
  },
  setTrayAutoStart: (enabled) => {
    set({ trayAutoStart: enabled });
    persistValue("trayAutoStart", enabled);
  },
  setTrayStartMinimized: (enabled) => {
    set({ trayStartMinimized: enabled });
    persistValue("trayStartMinimized", enabled);
  },
  setTrayAutoDetectMeeting: (enabled) => {
    set({ trayAutoDetectMeeting: enabled });
    persistValue("trayAutoDetectMeeting", enabled);
  },
  setTrayStealthEnabled: (enabled) => {
    set({ trayStealthEnabled: enabled });
    persistValue("trayStealthEnabled", enabled);
  },
  setStealthMode: async (enabled) => {
    const { setStealthMode: applyStealthMode } = await import("../lib/ipc");
    await applyStealthMode(enabled);
    useConfigStore.getState().stealthModeApplied(enabled);
  },
  stealthModeApplied: (enabled) => {
    set({ stealthMode: enabled });
    persistValue("stealthMode", enabled);
  },
  setStealthShortcut: (shortcut) => {
    set({ stealthShortcut: shortcut });
    persistValue("stealthShortcut", shortcut);
  },
  setAssistShortcut: (shortcut) => {
    set({ assistShortcut: shortcut });
    persistValue("assistShortcut", shortcut);
  },
  setMeetingDetection: (config) => {
    set({ meetingDetection: config });
    persistValue("meetingDetection", config);
    pushMeetingDetection(config);
  },

  /**
   * Load all persisted config values from the Tauri plugin-store on app start.
   * Any key not found in the store will keep its default value.
   * Auto-migrates old single-provider fields to the new per-party MeetingAudioConfig.
   * IMPORTANT: Migrations only run on first load. Subsequent calls (e.g., navigating
   * to settings mid-meeting) just reload values without applying destructive migrations.
   */
  loadConfig: async () => {
    try {
      const alreadyLoaded = useConfigStore.getState()._loaded;
      const store = await getStore();

      const theme = await store.get<ThemeMode>("theme");
      const sttProvider = await store.get<STTProviderType>("sttProvider");
      const sttLanguage = await store.get<string>("sttLanguage");
      const llmProvider = await store.get<LLMProviderType>("llmProvider");
      const llmModel = await store.get<string>("llmModel");
      const customLlmBaseUrl = await store.get<string>("customLlmBaseUrl");
      const customLlmAuthType = await store.get<CustomLlmAuthType>("customLlmAuthType");
      const micDeviceId = await store.get<string | null>("micDeviceId");
      const systemDeviceId = await store.get<string | null>("systemDeviceId");
      const recordingEnabled = await store.get<boolean>("recordingEnabled");
      const meetingAudioConfig = await store.get<MeetingAudioConfig>("meetingAudioConfig");
      const customPresets = await store.get<MeetingAudioConfig[]>("customPresets");
      const autoTrigger = await store.get<boolean>("autoTrigger");
      const autoSummary = await store.get<boolean>("autoSummary");
      const contextWindowSeconds = await store.get<number>("contextWindowSeconds");
      const startOnLogin = await store.get<boolean>("startOnLogin");
      const dataDirectory = await store.get<string>("dataDirectory");
      const firstRunCompleted = await store.get<boolean>("firstRunCompleted");
      const hotkeys = await store.get<HotkeyConfig>("hotkeys");
      const activeWhisperModel = await store.get<string | null>("activeWhisperModel");
      const whisperDualPass = await store.get<WhisperDualPassConfig>("whisperDualPass");
      const contextStrategy = await store.get<ContextStrategy>("contextStrategy");
      const verifiedCloudProviders = await store.get<string[]>("verifiedCloudProviders");
      const deepgramConfig = await store.get<DeepgramConfig>("deepgramConfig");
      const groqConfig = await store.get<GroqConfig>("groqConfig");
      const pauseThresholdMs = await store.get<number>("pauseThresholdMs");
      const activeModelPerEngine = await store.get<Record<string, string>>("activeModelPerEngine");
      const rememberedMeetingSetup = await store.get<{ audioMode: AudioMode; scenario: AIScenario } | null>("rememberedMeetingSetup");
      const diarizationEnabled = await store.get<boolean>("diarizationEnabled");
      const noisePreset = await store.get<string | null>("noisePreset");
      const confidenceThreshold = await store.get<number>("confidenceThreshold");
      const confidenceHighlightEnabled = await store.get<boolean>("confidenceHighlightEnabled");
      const openrouterFavorites = await store.get<string[]>("openrouterFavorites");
      const openrouterRecentlyUsed = await store.get<string[]>("openrouterRecentlyUsed");
      const transcriptFontSize = await store.get<number>("transcriptFontSize");
      const translationFontSize = await store.get<number>("translationFontSize");
      const transcriptTextColor = await store.get<string>("transcriptTextColor");
      const translationTextColor = await store.get<string>("translationTextColor");
      const aiResponseTextColor = await store.get<string>("aiResponseTextColor");
      const aiResponseFontSize = await store.get<number>("aiResponseFontSize");
      const aiResponseLineHeight = await store.get<number>("aiResponseLineHeight");
      const aiResponseHPad = await store.get<number>("aiResponseHPad");
      const aiResponseAlign = await store.get<string>("aiResponseAlign");
      const overlayOpacity = await store.get<number>("overlayOpacity");
      const contextScope = await store.get<ContextScopeSetting>("contextScope");
      const contextScopeSticky = await store.get<boolean>("contextScopeSticky");
      const showPostMeetingTranslation = await store.get<boolean>("showPostMeetingTranslation");
      const trayNotifications = await store.get<boolean>("trayNotifications");
      const trayAutoStart = await store.get<boolean>("trayAutoStart");
      const trayStartMinimized = await store.get<boolean>("trayStartMinimized");
      const trayAutoDetectMeeting = await store.get<boolean>("trayAutoDetectMeeting");
      const trayStealthEnabled = await store.get<boolean>("trayStealthEnabled");
      const stealthShortcut = await store.get<string>("stealthShortcut");
      const assistShortcut = await store.get<string>("assistShortcut");
      const stealthMode = await store.get<boolean>("stealthMode");
      const savedMeetingDetection = await store.get<Partial<MeetingDetectionConfig>>("meetingDetection");
      const meetingDetection = { ...DEFAULT_MEETING_DETECTION, ...(savedMeetingDetection ?? {}) };
      const storedLastModels = await store.get<Record<string, string>>("lastModelByProvider");
      const storedClaudeCliConfig = await store.get<Partial<ClaudeCliConfig>>("claudeCliConfig");
      const claudeCliFallbackPinned = (await store.get<boolean>("claudeCliFallbackPinned")) ?? false;
      const claudeModels = await store.get<ClaudeModelInfo[]>("claudeModels");

      // Last model per provider; seeded from the saved active provider on upgrade.
      const lastModelByProvider: Record<string, string> = { ...(storedLastModels ?? {}) };
      if (llmProvider && llmModel && llmProvider !== "claude_cli" && !lastModelByProvider[llmProvider]) {
        lastModelByProvider[llmProvider] = llmModel;
      }
      // Claude CLI config: saved values over the defaults (tolerates fields
      // added later). Without a saved config the fallback starts as the last
      // active non-CLI provider and its model.
      const claudeCliConfig: ClaudeCliConfig = { ...DEFAULT_CLAUDE_CLI_CONFIG, ...(storedClaudeCliConfig ?? {}) };
      if (!storedClaudeCliConfig && !claudeCliFallbackPinned && llmProvider && isFallbackCandidate(llmProvider)) {
        claudeCliConfig.fallback_provider = llmProvider;
        claudeCliConfig.fallback_model = lastModelByProvider[llmProvider] ?? null;
      }

      // Auto-migrate: if no meetingAudioConfig exists but old fields do,
      // build a MeetingAudioConfig from legacy fields.
      // ONLY run migrations on first load — not when re-entering settings mid-meeting.
      let resolvedMeetingConfig = meetingAudioConfig ?? null;
      if (!alreadyLoaded && !resolvedMeetingConfig && (micDeviceId || systemDeviceId)) {
        resolvedMeetingConfig = {
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
          recording_enabled: recordingEnabled ?? false,
          preset_name: null,
        };
        await store.set("meetingAudioConfig", resolvedMeetingConfig);
        console.log("[configStore] Migrated legacy audio config to meetingAudioConfig");
      }

      // Migrate whisper_cpp → correct defaults (whisper_cpp is batch-only, not for live STT)
      // Only run on first load to avoid overwriting user settings mid-meeting.
      if (!alreadyLoaded && resolvedMeetingConfig) {
        let migrated = false;
        if ((resolvedMeetingConfig.you.stt_provider as string) === "whisper_cpp") {
          resolvedMeetingConfig.you = { ...resolvedMeetingConfig.you, stt_provider: "web_speech", local_model_id: undefined };
          migrated = true;
        }
        if ((resolvedMeetingConfig.them.stt_provider as string) === "whisper_cpp") {
          resolvedMeetingConfig.them = { ...resolvedMeetingConfig.them, stt_provider: "deepgram", local_model_id: undefined };
          migrated = true;
        }
        // windows_native only works with mic input; migrate Them (non-input) away from it
        if (
          (resolvedMeetingConfig.them.stt_provider as string) === "windows_native" &&
          !resolvedMeetingConfig.them.is_input_device
        ) {
          resolvedMeetingConfig.them = { ...resolvedMeetingConfig.them, stt_provider: "deepgram" };
          migrated = true;
        }
        // Mutual exclusion: Web Speech / Windows Speech can only be used by one party.
        // If both parties have exclusive providers (from old config), keep "You" and fallback "Them".
        const exclusiveProviders = ["web_speech", "windows_native"];
        if (
          exclusiveProviders.includes(resolvedMeetingConfig.you.stt_provider) &&
          exclusiveProviders.includes(resolvedMeetingConfig.them.stt_provider)
        ) {
          resolvedMeetingConfig.them = {
            ...resolvedMeetingConfig.them,
            stt_provider: "deepgram",
            local_model_id: undefined,
          };
          migrated = true;
          console.log("[configStore] Migrated dual-exclusive STT: kept You, fell back Them to deepgram");
        }
        if (migrated) {
          await store.set("meetingAudioConfig", resolvedMeetingConfig);
          console.log("[configStore] Migrated meetingAudioConfig providers");
        }
      }

      // Migrate top-level sttProvider away from whisper_cpp (first load only)
      let resolvedSttProvider = sttProvider;
      if (!alreadyLoaded && (!resolvedSttProvider || (resolvedSttProvider as string) === "whisper_cpp")) {
        resolvedSttProvider = "windows_native" as STTProviderType;
        await store.set("sttProvider", resolvedSttProvider);
        console.log("[configStore] Migrated top-level sttProvider to windows_native");
      }

      // If no meetingAudioConfig was found after all migrations, create a default (first load only)
      if (!alreadyLoaded && !resolvedMeetingConfig) {
        resolvedMeetingConfig = {
          you: {
            role: "You",
            device_id: "default",
            is_input_device: true,
            stt_provider: "web_speech",
          },
          them: {
            role: "Them",
            device_id: "default",
            is_input_device: false,
            stt_provider: "deepgram",
          },
          recording_enabled: false,
          preset_name: null,
        };
        await store.set("meetingAudioConfig", resolvedMeetingConfig);
        console.log("[configStore] Created default meetingAudioConfig (Web Speech + Deepgram)");
      }

      set((state) => ({
        ...state,
        _loaded: true,
        ...(theme != null && { theme }),
        ...(sttProvider != null && { sttProvider }),
        ...(sttLanguage != null && { sttLanguage }),
        ...(llmProvider != null && { llmProvider }),
        ...(llmModel != null && { llmModel }),
        lastModelByProvider,
        claudeCliConfig,
        claudeCliFallbackPinned,
        ...(Array.isArray(claudeModels) && claudeModels.length > 0 && { claudeModels }),
        ...(customLlmBaseUrl != null && { customLlmBaseUrl }),
        ...(customLlmAuthType != null && { customLlmAuthType }),
        ...(micDeviceId !== undefined && { micDeviceId }),
        ...(systemDeviceId !== undefined && { systemDeviceId }),
        ...(recordingEnabled != null && { recordingEnabled }),
        ...(resolvedMeetingConfig != null && { meetingAudioConfig: resolvedMeetingConfig }),
        ...(customPresets != null && { customPresets }),
        ...(autoTrigger != null && { autoTrigger }),
        ...(autoSummary != null && { autoSummary }),
        ...(contextWindowSeconds != null && { contextWindowSeconds }),
        ...(startOnLogin != null && { startOnLogin }),
        ...(dataDirectory != null && { dataDirectory }),
        ...(firstRunCompleted != null && { firstRunCompleted }),
        ...(hotkeys != null && { hotkeys }),
        ...(activeWhisperModel !== undefined && { activeWhisperModel }),
        ...(activeModelPerEngine != null && { activeModelPerEngine }),
        ...(whisperDualPass != null && { whisperDualPass }),
        ...(contextStrategy != null && { contextStrategy }),
        ...(verifiedCloudProviders != null && { verifiedCloudProviders }),
        ...(deepgramConfig != null && { deepgramConfig }),
        ...(groqConfig != null && { groqConfig }),
        ...(pauseThresholdMs != null && { pauseThresholdMs }),
        ...(rememberedMeetingSetup !== undefined && { rememberedMeetingSetup: rememberedMeetingSetup ?? null }),
        ...(diarizationEnabled != null && { diarizationEnabled }),
        ...(noisePreset !== undefined && { noisePreset: noisePreset ?? null }),
        ...(confidenceThreshold != null && { confidenceThreshold }),
        ...(confidenceHighlightEnabled != null && { confidenceHighlightEnabled }),
        ...(openrouterFavorites != null && { openrouterFavorites }),
        ...(openrouterRecentlyUsed != null && { openrouterRecentlyUsed }),
        transcriptFontSize: transcriptFontSize ?? 13,
        translationFontSize: translationFontSize ?? 12,
        transcriptTextColor: transcriptTextColor ?? "#e4e4e7",
        translationTextColor: translationTextColor ?? "#fbbf24",
        aiResponseTextColor: aiResponseTextColor ?? "#d4d4d8",
        aiResponseFontSize: aiResponseFontSize ?? 12,
        aiResponseLineHeight: aiResponseLineHeight ?? 1.6,
        aiResponseHPad: aiResponseHPad ?? 0,
        aiResponseAlign: (aiResponseAlign as "left" | "center" | "right") ?? "left",
        overlayOpacity: overlayOpacity ?? 0.65,
        contextScope: normalizeContextScope(contextScope),
        contextScopeSticky: contextScopeSticky ?? true,
        sttLanguage: sttLanguage ?? "en-US",
        showPostMeetingTranslation: showPostMeetingTranslation ?? true,
        ...(trayNotifications != null && { trayNotifications }),
        ...(trayAutoStart != null && { trayAutoStart }),
        ...(trayStartMinimized != null && { trayStartMinimized }),
        ...(trayAutoDetectMeeting != null && { trayAutoDetectMeeting }),
        ...(trayStealthEnabled != null && { trayStealthEnabled }),
        ...(stealthShortcut != null && { stealthShortcut }),
        ...(assistShortcut != null && { assistShortcut }),
        ...(stealthMode != null && { stealthMode }),
        meetingDetection,
      }));

      // Post-load: ensure local providers have a local_model_id so footer/backend use the right model
      if (resolvedMeetingConfig) {
        const amp = activeModelPerEngine ?? {};
        const defaultModels: Record<string, string> = {
          sherpa_onnx: "streaming-zipformer-en-20M",
          ort_streaming: "zipformer-en-20M",
          parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
        };
        const localProviders = ["sherpa_onnx", "ort_streaming", "parakeet_tdt", "whisper_cpp"];
        let needsPersist = false;
        for (const party of ["you", "them"] as const) {
          const p = resolvedMeetingConfig[party];
          if (localProviders.includes(p.stt_provider) && !p.local_model_id) {
            resolvedMeetingConfig[party] = {
              ...p,
              local_model_id: amp[p.stt_provider] ?? defaultModels[p.stt_provider] ?? undefined,
            };
            needsPersist = true;
          }
        }
        if (needsPersist) {
          set({ meetingAudioConfig: resolvedMeetingConfig });
          persistValue("meetingAudioConfig", resolvedMeetingConfig);
        }
      }

      // Set up cross-window sync: when another window changes the store,
      // update this window's Zustand state automatically.
      store.onKeyChange<MeetingAudioConfig>("meetingAudioConfig", (val) => {
        if (val != null) set({ meetingAudioConfig: val });
      });
      store.onKeyChange<string>("activeWhisperModel", (val) => {
        if (val !== undefined) set({ activeWhisperModel: val ?? null });
      });
      store.onKeyChange<STTProviderType>("sttProvider", (val) => {
        if (val != null) set({ sttProvider: val });
      });
      store.onKeyChange<string>("sttLanguage", (val) => {
        if (val != null) set({ sttLanguage: val });
      });
      store.onKeyChange<LLMProviderType>("llmProvider", (val) => {
        if (val != null) set({ llmProvider: val });
      });
      store.onKeyChange<string>("llmModel", (val) => {
        if (val != null) set({ llmModel: val });
      });
      store.onKeyChange<ClaudeCliConfig>("claudeCliConfig", (val) => {
        if (val != null) set({ claudeCliConfig: { ...DEFAULT_CLAUDE_CLI_CONFIG, ...val } });
      });
      store.onKeyChange<ClaudeModelInfo[]>("claudeModels", (val) => {
        if (Array.isArray(val) && val.length > 0) set({ claudeModels: val });
      });
      store.onKeyChange<boolean>("claudeCliFallbackPinned", (val) => {
        if (val != null) set({ claudeCliFallbackPinned: val });
      });
      store.onKeyChange<Record<string, string>>("lastModelByProvider", (val) => {
        if (val != null) set({ lastModelByProvider: val });
      });
      store.onKeyChange<ContextStrategy>("contextStrategy", (val) => {
        if (val != null) set({ contextStrategy: val });
      });
      store.onKeyChange<WhisperDualPassConfig>("whisperDualPass", (val) => {
        if (val != null) set({ whisperDualPass: val });
      });
      store.onKeyChange<ContextScopeSetting>("contextScope", (val) => {
        if (val != null) set({ contextScope: normalizeContextScope(val) });
      });
      store.onKeyChange<boolean>("contextScopeSticky", (val) => {
        if (val != null) set({ contextScopeSticky: val });
      });
      store.onKeyChange<number>("overlayOpacity", (val) => {
        if (val != null) set({ overlayOpacity: val });
      });
      store.onKeyChange<string>("customLlmBaseUrl", (val) => {
        if (val != null) set({ customLlmBaseUrl: val });
      });
      store.onKeyChange<CustomLlmAuthType>("customLlmAuthType", (val) => {
        if (val != null) set({ customLlmAuthType: val });
      });
      store.onKeyChange<boolean>("stealthMode", (val) => {
        if (val != null) set({ stealthMode: val });
      });
      store.onKeyChange<string>("stealthShortcut", (val) => {
        if (val != null) set({ stealthShortcut: val });
      });
      store.onKeyChange<string>("assistShortcut", (val) => {
        if (val != null) set({ assistShortcut: val });
      });
      store.onKeyChange<MeetingDetectionConfig>("meetingDetection", (val) => {
        if (val != null) set({ meetingDetection: { ...DEFAULT_MEETING_DETECTION, ...val } });
      });

      // The backend detector stays idle until it has the saved settings.
      pushMeetingDetection(meetingDetection);

      // The backend already restored it natively at startup; this re-applies it
      // and, if the windows can't be hidden, shows the setting as off.
      if (stealthMode) {
        import("../lib/ipc").then(({ setStealthMode: applyStealthMode }) =>
          applyStealthMode(true).catch((e) => {
            console.warn("[configStore] Failed to restore stealth mode:", e);
            set({ stealthMode: false });
          }),
        );
      }

      // Sync persisted STT language to Rust backend on startup.
      const loadedSttLanguage = sttLanguage ?? "en-US";
      import("../lib/ipc").then(({ setSTTLanguage: setBackendSTTLanguage }) =>
        setBackendSTTLanguage(loadedSttLanguage)
          .catch((e) => console.warn("[configStore] Failed to sync STT language on load:", e))
      );

      // Sync persisted dual-pass config to Rust backend on startup.
      // The Rust side starts with DualPassConfig::default(); this pushes saved values.
      const loadedDualPass = whisperDualPass ?? { shortChunkSecs: 1.0, longChunkSecs: 3.0, pauseSecs: 1.5 };
      import("../lib/ipc").then(({ updateWhisperDualPassConfig }) =>
        updateWhisperDualPassConfig(
          loadedDualPass.shortChunkSecs,
          loadedDualPass.longChunkSecs,
          loadedDualPass.pauseSecs,
        ).catch((e) => console.warn("[configStore] Failed to sync dual-pass config on load:", e))
      );

      // Sync persisted Deepgram config to Rust backend on startup.
      const loadedDgConfig = deepgramConfig ?? DEFAULT_DEEPGRAM_CONFIG;
      import("../lib/ipc").then(({ updateDeepgramConfig }) =>
        updateDeepgramConfig(loadedDgConfig)
          .catch((e) => console.warn("[configStore] Failed to sync Deepgram config on load:", e))
      );

      // Sync persisted Groq config to Rust backend on startup.
      const loadedGroqConfig = groqConfig ?? DEFAULT_GROQ_CONFIG;
      import("../lib/ipc").then(({ updateGroqConfig }) =>
        updateGroqConfig(loadedGroqConfig)
          .catch((e) => console.warn("[configStore] Failed to sync Groq config on load:", e))
      );

      // Sync persisted pause threshold to Rust backend on startup.
      const loadedPauseThreshold = pauseThresholdMs ?? 3000;
      import("../lib/ipc").then(({ setPauseThreshold }) =>
        setPauseThreshold(loadedPauseThreshold)
          .catch((e) => console.warn("[configStore] Failed to sync pause threshold on load:", e))
      );

      // Sync the Claude CLI config to the backend (it starts with the defaults
      // and keeps the config in memory only).
      pushClaudeCliConfig(claudeCliConfig);
      // ...and the saved model catalog, so effort is clamped even before (or
      // without) this start's probe. A fresher probe answer always wins.
      if (Array.isArray(claudeModels) && claudeModels.length > 0) {
        import("../lib/ipc").then(({ seedClaudeCliModels }) =>
          seedClaudeCliModels(claudeModels).catch((e) =>
            console.warn("[configStore] Failed to seed the Claude model list:", e),
          ),
        );
      }

      // Sync persisted LLM provider + model to Rust backend on startup.
      // The Rust side starts with Ollama as default; this pushes the user's saved provider.
      // Claude CLI ignores the model; its slot carries the Fast model.
      const loadedLLMProvider = llmProvider ?? "ollama";
      const loadedLLMModel = loadedLLMProvider === "claude_cli" ? claudeCliConfig.fast_model : (llmModel ?? "");
      if (loadedLLMProvider) {
        import("../lib/ipc").then(async ({ setLLMProvider: ipcSetLLM, setActiveModel: ipcSetModel }) => {
          try {
            await ipcSetLLM(await storedProviderConfig(loadedLLMProvider));
            if (loadedLLMModel) {
              await ipcSetModel(loadedLLMProvider, loadedLLMModel);
            }
            console.log(`[configStore] LLM synced to backend: ${loadedLLMProvider} / ${loadedLLMModel}`);
          } catch (e) {
            console.warn("[configStore] Failed to sync LLM to backend:", e);
          }
        });
      }

      console.log("[configStore] Config loaded from store (with cross-window sync)");
    } catch (err) {
      console.error("[configStore] Failed to load config:", err);
      set({ _loaded: true });
    }
  },
}));
