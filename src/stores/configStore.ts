import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import { DEFAULT_HOTKEYS, migrateSavedHotkeys, sanitizeHotkeys } from "../lib/hotkeys";
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
  CliAgentKind,
  ContextScopeSetting,
  ThinkingSetting,
} from "../lib/types";
import {
  normalizeExtraJsonMap,
  normalizeThinkingMap,
  requestOptionFields,
} from "../lib/llmRequestOptions";
import { sanitizePlacement, type WindowPlacement } from "../lib/windowPlacement";
import { CLI_AGENTS, cliAgentInfo, cliAgentName, isCliAgent } from "../lib/cliAgents";
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
export const DEFAULT_CLAUDE_CLI_CONFIG: ClaudeCliConfig = cliAgentInfo("claude_cli").defaultConfig;

/** Per-agent defaults (mirror Rust `ClaudeCliConfig::default_for`). */
export const DEFAULT_CLI_AGENT_CONFIGS: Record<CliAgentKind, ClaudeCliConfig> = Object.fromEntries(
  CLI_AGENTS.map((a) => [a.id, a.defaultConfig]),
) as Record<CliAgentKind, ClaudeCliConfig>;

/**
 * Providers that can stand in for a CLI agent. "custom" is left out: the
 * fallback is built from the provider type alone and custom needs its URL.
 */
export const CLI_FALLBACK_PROVIDERS: LLMProviderType[] = [
  "ollama", "lm_studio", "openai", "anthropic", "groq", "gemini", "openrouter",
];

function isFallbackCandidate(provider: string): boolean {
  return (CLI_FALLBACK_PROVIDERS as string[]).includes(provider);
}

/**
 * The generic model slot of an active CLI agent: its Fast model, or, when that
 * is "" (Codex: "first listed"), the first model of its catalog. Still "" while
 * no catalog is known; the backend then lets the CLI provider pick its own.
 */
export function cliSlotModel(config: ClaudeCliConfig, catalog?: ClaudeModelInfo[]): string {
  return config.fast_model || catalog?.[0]?.value || "";
}

/** Push one CLI agent's config to the backend, which holds it in memory only. */
function pushCliAgentConfig(kind: CliAgentKind, config: ClaudeCliConfig): void {
  import("../lib/ipc").then(({ setCliAgentConfig }) =>
    setCliAgentConfig(kind, config).catch((e) => {
      console.warn(`[configStore] Failed to push the ${kind} config:`, e);
      import("./toastStore").then(({ showToast }) =>
        showToast(`${cliAgentName(kind)} settings not applied: ${e instanceof Error ? e.message : String(e)}`, "error")
      );
    })
  );
}

/** Saved per-agent configs over each agent's defaults (tolerates fields added later). */
function mergeAgentConfigs(
  saved: Partial<Record<string, Partial<ClaudeCliConfig>>> | null | undefined,
): Record<CliAgentKind, ClaudeCliConfig> {
  const out = {} as Record<CliAgentKind, ClaudeCliConfig>;
  for (const a of CLI_AGENTS) out[a.id] = { ...a.defaultConfig, ...(saved?.[a.id] ?? {}) };
  return out;
}

/** Only non-empty catalogs of known agents. */
function cleanAgentModels(saved: unknown): Partial<Record<CliAgentKind, ClaudeModelInfo[]>> {
  const out: Partial<Record<CliAgentKind, ClaudeModelInfo[]>> = {};
  if (!saved || typeof saved !== "object") return out;
  for (const a of CLI_AGENTS) {
    const list = (saved as Record<string, unknown>)[a.id];
    if (Array.isArray(list) && list.length > 0) out[a.id] = list as ClaudeModelInfo[];
  }
  return out;
}

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
  const { llmThinking, llmExtraRequestJson } = useConfigStore.getState();
  Object.assign(config, requestOptionFields(provider, llmThinking[provider], llmExtraRequestJson[provider]));
  if (provider === "custom") {
    const { customLlmBaseUrl, customLlmAuthType } = useConfigStore.getState();
    if (customLlmBaseUrl) config.base_url = customLlmBaseUrl;
    if (customLlmAuthType !== "none") {
      config.auth_type = customLlmAuthType;
      const token = await getApiKey("custom").catch(() => null);
      if (token) config.auth_value = token;
    }
  } else if (!isCliAgent(provider)) {
    const key = await getApiKey(provider).catch(() => null);
    if (key) config.api_key = key;
  }
  return JSON.stringify(config);
}

/**
 * Changes of the backend's provider run one after another, in the order they
 * were asked for: both activating a provider and re-applying its options load
 * credentials first, so a slow one must not land after a later switch and put
 * the old provider back.
 */
let providerChanges: Promise<unknown> = Promise.resolve();
function enqueueProviderChange<T>(task: () => Promise<T>): Promise<T> {
  const run = providerChanges.then(task, task);
  providerChanges = run.catch(() => {});
  return run;
}

/**
 * A request option of the provider in use changed: the backend gets the whole
 * config again (it keeps the model). A provider not in use gets it on activation.
 * The check of which provider is in use runs when its turn comes, after any
 * switch asked for earlier, so a stale update is dropped.
 */
function reapplyIfActive(provider: LLMProviderType): void {
  if (isCliAgent(provider)) return;
  enqueueProviderChange(async () => {
    if (useConfigStore.getState().llmProvider !== provider) return;
    const config = await storedProviderConfig(provider);
    if (useConfigStore.getState().llmProvider !== provider) return;
    const ipc = await import("../lib/ipc");
    await ipc.setLLMProvider(config);
  })
    .catch((e) => {
      console.warn("[configStore] Failed to apply the request options:", e);
      import("./toastStore").then(({ showToast }) =>
        showToast(`Couldn't apply the AI setting: ${e instanceof Error ? e.message : String(e)}`, "error"),
      );
    });
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
/** Capture the screen under the mouse into the Ask box (Claude subscription, during a meeting). */
export const DEFAULT_CAPTURE_SHORTCUT = "CmdOrCtrl+Shift+S";

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
  /** How much each provider's model thinks; a provider not listed is "auto". */
  llmThinking: Record<string, ThinkingSetting>;
  /** Advanced: extra JSON merged into each provider's request (only valid JSON is kept). */
  llmExtraRequestJson: Record<string, string>;

  // CLI agent (subscription) settings by provider id; the backend gets a copy on load and on change.
  cliAgentConfigs: Record<CliAgentKind, ClaudeCliConfig>;
  /**
   * The user picked that agent's fallback themselves. Until then it follows
   * the last active non-CLI provider and its model.
   */
  cliFallbackPinned: Partial<Record<CliAgentKind, boolean>>;
  /**
   * Last model catalog each CLI agent reported (refreshed by the launcher on
   * every start and on Check connection). Missing until fetched once; the
   * pickers then offer the static aliases (Claude) or what the config names.
   */
  cliAgentModels: Partial<Record<CliAgentKind, ClaudeModelInfo[]>>;
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
  /** Remove the other side's voice that "You" picks up from the speakers. */
  echoCancellation: boolean;
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
  /** Meeting window's dock layout, as saved (sanitized by the dock on load). Only the overlay window writes it. */
  overlayDock: unknown;
  /** Panels the user opened for the current meeting only (Escape closes the last one). */
  overlayDockTransient: string[];
  /** Last size and place of each window (null: never saved). Each window writes only its own. */
  launcherPlacement: WindowPlacement | null;
  overlayPlacement: WindowPlacement | null;

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
  /** Global shortcut that captures the screen under the pointer into Ask. */
  captureShortcut: string;
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
  /** Set how much `provider`'s model thinks (persisted, synced, applied at once when it is active). */
  setLlmThinking: (provider: LLMProviderType, value: ThinkingSetting) => void;
  /** Set `provider`'s extra request JSON; the caller passes valid JSON or "". */
  setLlmExtraRequestJson: (provider: LLMProviderType, json: string) => void;
  /** Replace one CLI agent's config (persisted + pushed to the backend). */
  setCliAgentConfig: (kind: CliAgentKind, config: ClaudeCliConfig) => void;
  /** The user's fallback choice for `kind`: pins it so it no longer follows the active provider. */
  setCliAgentFallback: (kind: CliAgentKind, provider: string | null, model: string | null) => void;
  /** Keep the latest model catalog of one CLI agent (persisted, shared with every window). */
  setCliAgentModels: (kind: CliAgentKind, models: ClaudeModelInfo[]) => void;
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
  setEchoCancellation: (enabled: boolean) => void;
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
  setOverlayDock: (dock: unknown) => void;
  setOverlayDockTransient: (panels: string[]) => void;
  setWindowPlacement: (label: "launcher" | "overlay", placement: WindowPlacement) => void;
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
  setCaptureShortcut: (shortcut: string) => void;
  /** Replace the meeting detection settings (persisted + pushed to the backend). */
  setMeetingDetection: (config: MeetingDetectionConfig) => void;
  loadConfig: () => Promise<void>;
}

/**
 * While the fallback is not pinned, point it at `provider` (a non-CLI
 * provider just made active) with the last model used there.
 */
function followFallback(provider: string): void {
  if (!isFallbackCandidate(provider)) return;
  for (const { id } of CLI_AGENTS) {
    const state = useConfigStore.getState();
    if (state.cliFallbackPinned[id]) continue;
    const model = state.lastModelByProvider[provider] ?? null;
    const cfg = state.cliAgentConfigs[id];
    if (cfg.fallback_provider === provider && cfg.fallback_model === model) continue;
    state.setCliAgentConfig(id, { ...cfg, fallback_provider: provider, fallback_model: model });
  }
}

export const useConfigStore = create<ConfigState>((set) => ({
  theme: "dark",
  sttProvider: "windows_native",
  sttLanguage: "en-US",
  llmProvider: "ollama",
  llmModel: "",
  lastModelByProvider: {},
  llmThinking: {},
  llmExtraRequestJson: {},
  cliAgentConfigs: DEFAULT_CLI_AGENT_CONFIGS,
  cliFallbackPinned: {},
  cliAgentModels: {},
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
  echoCancellation: true,
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
  overlayDock: null,
  overlayDockTransient: [],
  launcherPlacement: null,
  overlayPlacement: null,
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
  captureShortcut: DEFAULT_CAPTURE_SHORTCUT,
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
  activateLLMProvider: (provider, options = {}) => enqueueProviderChange(async () => {
    const ipc = await import("../lib/ipc");
    const before = useConfigStore.getState();
    let providerConfig = options.providerConfig;
    if (providerConfig == null) providerConfig = await storedProviderConfig(provider);
    await ipc.setLLMProvider(providerConfig);
    before.setLLMProvider(provider);
    // An activated provider counts as verified (the "Ready" badge in Settings).
    const verified = useConfigStore.getState().verifiedCloudProviders;
    if (!verified.includes(provider)) useConfigStore.getState().setVerifiedCloudProviders([...verified, provider]);
    // A CLI agent ignores the model (Fast / Deep come from its settings) but the
    // backend needs one: its Fast model fills the slot.
    const state = useConfigStore.getState();
    const model = isCliAgent(provider)
      ? cliSlotModel(state.cliAgentConfigs[provider], state.cliAgentModels[provider])
      : options.model || before.lastModelByProvider[provider] || "";
    // Without a model, an agent's Fast model must not carry over to the new provider,
    // and an agent with no model yet must not inherit the previous provider's.
    if (model || isCliAgent(provider) || isCliAgent(before.llmProvider)) {
      try {
        await ipc.setActiveModel(provider, model);
      } catch (e) {
        // The backend kept its previous model: don't record one it refused.
        throw new Error(`model ${model || "(none)"} not applied: ${e instanceof Error ? e.message : String(e)}`);
      }
      useConfigStore.getState().setLLMModel(model, provider);
    }
  }),
  rememberModel: (provider, model) => {
    if (!model || isCliAgent(provider)) return;
    const { lastModelByProvider } = useConfigStore.getState();
    if (lastModelByProvider[provider] !== model) {
      const next = { ...lastModelByProvider, [provider]: model };
      set({ lastModelByProvider: next });
      persistValue("lastModelByProvider", next);
    }
    // An unpinned fallback on this provider tracks its latest model.
    for (const { id } of CLI_AGENTS) {
      const { cliFallbackPinned, cliAgentConfigs } = useConfigStore.getState();
      const cfg = cliAgentConfigs[id];
      if (!cliFallbackPinned[id] && cfg.fallback_provider === provider && cfg.fallback_model !== model) {
        useConfigStore.getState().setCliAgentConfig(id, { ...cfg, fallback_model: model });
      }
    }
  },
  setLlmThinking: (provider, value) => {
    const { [provider]: _previous, ...others } = useConfigStore.getState().llmThinking;
    const next = value === "auto" ? others : { ...others, [provider]: value };
    set({ llmThinking: next });
    persistValue("llmThinking", next);
    reapplyIfActive(provider);
  },
  setLlmExtraRequestJson: (provider, json) => {
    const { [provider]: _previous, ...others } = useConfigStore.getState().llmExtraRequestJson;
    const next = json.trim() ? { ...others, [provider]: json } : others;
    set({ llmExtraRequestJson: next });
    persistValue("llmExtraRequestJson", next);
    reapplyIfActive(provider);
  },
  setCliAgentConfig: (kind, config) => {
    const { llmProvider, llmModel, cliAgentConfigs, cliAgentModels } = useConfigStore.getState();
    const next = { ...cliAgentConfigs, [kind]: config };
    set({ cliAgentConfigs: next });
    persistValue("cliAgentConfigs", next);
    pushCliAgentConfig(kind, config);
    // While this agent is active the generic model slot mirrors its Fast model:
    // the provider ignores it, but the backend needs one and the footer shows it.
    const slot = cliSlotModel(config, cliAgentModels[kind]);
    if (llmProvider === kind && llmModel !== slot) {
      set({ llmModel: slot });
      persistValue("llmModel", slot);
      import("../lib/ipc").then(({ setActiveModel }) =>
        setActiveModel(kind, slot)
          .catch((e) => console.warn(`[configStore] Failed to set the ${kind} model:`, e))
      );
    }
  },
  setCliAgentModels: (kind, models) => {
    const next = { ...useConfigStore.getState().cliAgentModels, [kind]: models };
    set({ cliAgentModels: next });
    persistValue("cliAgentModels", next);
  },
  setCliAgentFallback: (kind, provider, model) => {
    const pinned = { ...useConfigStore.getState().cliFallbackPinned, [kind]: true };
    set({ cliFallbackPinned: pinned });
    persistValue("cliFallbackPinned", pinned);
    const cfg = useConfigStore.getState().cliAgentConfigs[kind];
    useConfigStore.getState().setCliAgentConfig(kind, {
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
    const clean = sanitizeHotkeys(hotkeys);
    set({ hotkeys: clean });
    persistValue("hotkeys", clean);
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
  setEchoCancellation: (enabled) => {
    set({ echoCancellation: enabled });
    persistValue("echoCancellation", enabled);
    // Applies mid-meeting: the capture loop reads it per chunk.
    import("../lib/ipc").then(({ setEchoCancellation }) =>
      setEchoCancellation(enabled)
        .catch((e) => console.warn("[configStore] Failed to update echo cancellation:", e))
    );
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
  setOverlayDock: (dock) => {
    set({ overlayDock: dock });
    persistValue("overlayDock", dock);
  },
  setOverlayDockTransient: (panels) => {
    set({ overlayDockTransient: panels });
    persistValue("overlayDockTransient", panels);
  },
  setWindowPlacement: (label, placement) => {
    if (label === "launcher") set({ launcherPlacement: placement });
    else set({ overlayPlacement: placement });
    persistValue(`${label}Placement`, placement);
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
  setCaptureShortcut: (shortcut) => {
    set({ captureShortcut: shortcut });
    persistValue("captureShortcut", shortcut);
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
      const savedHotkeys = await store.get<unknown>("hotkeys");
      // Older versions saved bindings nothing read (Ctrl+1..5 after a Reset): fix them here.
      const hotkeys = migrateSavedHotkeys(savedHotkeys);
      if (savedHotkeys != null && JSON.stringify(savedHotkeys) !== JSON.stringify(hotkeys)) {
        persistValue("hotkeys", hotkeys);
      }
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
      const echoCancellation = await store.get<boolean>("echoCancellation");
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
      const overlayDock = await store.get<unknown>("overlayDock");
      const overlayDockTransient = await store.get<unknown>("overlayDockTransient");
      const launcherPlacement = await store.get<unknown>("launcherPlacement");
      const overlayPlacement = await store.get<unknown>("overlayPlacement");
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
      const captureShortcut = await store.get<string>("captureShortcut");
      const stealthMode = await store.get<boolean>("stealthMode");
      const savedMeetingDetection = await store.get<Partial<MeetingDetectionConfig>>("meetingDetection");
      const meetingDetection = { ...DEFAULT_MEETING_DETECTION, ...(savedMeetingDetection ?? {}) };
      const storedLastModels = await store.get<Record<string, string>>("lastModelByProvider");
      // Per-agent keys; configs saved before them hold Claude's under the old keys.
      const storedAgentConfigs = await store.get<Partial<Record<string, Partial<ClaudeCliConfig>>>>("cliAgentConfigs");
      const storedClaudeCliConfig = await store.get<Partial<ClaudeCliConfig>>("claudeCliConfig");
      const storedFallbackPinned = await store.get<Record<string, boolean>>("cliFallbackPinned");
      const oldClaudeFallbackPinned = (await store.get<boolean>("claudeCliFallbackPinned")) ?? false;
      const storedAgentModels = await store.get<unknown>("cliAgentModels");
      const oldClaudeModels = await store.get<ClaudeModelInfo[]>("claudeModels");
      // Absent in configs saved before these settings: every provider is Auto, no extra JSON.
      const llmThinking = normalizeThinkingMap(await store.get<unknown>("llmThinking"));
      const llmExtraRequestJson = normalizeExtraJsonMap(await store.get<unknown>("llmExtraRequestJson"));

      // Last model per provider; seeded from the saved active provider on upgrade.
      const lastModelByProvider: Record<string, string> = { ...(storedLastModels ?? {}) };
      if (llmProvider && llmModel && !isCliAgent(llmProvider) && !lastModelByProvider[llmProvider]) {
        lastModelByProvider[llmProvider] = llmModel;
      }
      // CLI agent configs: saved values over the defaults (tolerates fields
      // added later). Without a saved config an agent's fallback starts as the
      // last active non-CLI provider and its model.
      const savedConfigs = storedAgentConfigs ?? (storedClaudeCliConfig ? { claude_cli: storedClaudeCliConfig } : null);
      const cliAgentConfigs = mergeAgentConfigs(savedConfigs);
      const cliFallbackPinned: Partial<Record<CliAgentKind, boolean>> = {
        ...(oldClaudeFallbackPinned && { claude_cli: true }),
        ...(storedFallbackPinned ?? {}),
      };
      for (const { id } of CLI_AGENTS) {
        if (!savedConfigs?.[id] && !cliFallbackPinned[id] && llmProvider && isFallbackCandidate(llmProvider)) {
          cliAgentConfigs[id] = {
            ...cliAgentConfigs[id],
            fallback_provider: llmProvider,
            fallback_model: lastModelByProvider[llmProvider] ?? null,
          };
        }
      }
      const cliAgentModels = cleanAgentModels({
        ...(Array.isArray(oldClaudeModels) && { claude_cli: oldClaudeModels }),
        ...(storedAgentModels && typeof storedAgentModels === "object" ? storedAgentModels : {}),
      });

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
          // The engines no longer match the saved preset, so its chip must not light.
          resolvedMeetingConfig = { ...resolvedMeetingConfig, preset_name: null };
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
        llmThinking,
        llmExtraRequestJson,
        cliAgentConfigs,
        cliFallbackPinned,
        cliAgentModels,
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
        hotkeys,
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
        ...(echoCancellation != null && { echoCancellation }),
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
        overlayDock: overlayDock ?? null,
        overlayDockTransient: Array.isArray(overlayDockTransient)
          ? overlayDockTransient.filter((p): p is string => typeof p === "string")
          : [],
        launcherPlacement: sanitizePlacement(launcherPlacement),
        overlayPlacement: sanitizePlacement(overlayPlacement),
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
        ...(captureShortcut != null && { captureShortcut }),
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
      store.onKeyChange<Record<string, string>>("activeModelPerEngine", (val) => {
        if (val != null) set({ activeModelPerEngine: val });
      });
      store.onKeyChange<DeepgramConfig>("deepgramConfig", (val) => {
        if (val != null) set({ deepgramConfig: { ...DEFAULT_DEEPGRAM_CONFIG, ...val } });
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
      store.onKeyChange<Partial<Record<string, Partial<ClaudeCliConfig>>>>("cliAgentConfigs", (val) => {
        if (val != null) set({ cliAgentConfigs: mergeAgentConfigs(val) });
      });
      store.onKeyChange<unknown>("cliAgentModels", (val) => {
        const models = cleanAgentModels(val);
        if (Object.keys(models).length > 0) set({ cliAgentModels: models });
      });
      store.onKeyChange<Record<string, boolean>>("cliFallbackPinned", (val) => {
        if (val != null) set({ cliFallbackPinned: val });
      });
      store.onKeyChange<Record<string, string>>("lastModelByProvider", (val) => {
        if (val != null) set({ lastModelByProvider: val });
      });
      store.onKeyChange<Record<string, ThinkingSetting>>("llmThinking", (val) => {
        set({ llmThinking: normalizeThinkingMap(val) });
      });
      store.onKeyChange<Record<string, string>>("llmExtraRequestJson", (val) => {
        set({ llmExtraRequestJson: normalizeExtraJsonMap(val) });
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
      // The overlay window writes the layout; the launcher (demo mode) only reads it.
      store.onKeyChange<unknown>("overlayDock", (val) => {
        set({ overlayDock: val ?? null });
      });
      store.onKeyChange<string>("customLlmBaseUrl", (val) => {
        if (val != null) set({ customLlmBaseUrl: val });
      });
      store.onKeyChange<CustomLlmAuthType>("customLlmAuthType", (val) => {
        if (val != null) set({ customLlmAuthType: val });
      });
      store.onKeyChange<unknown>("hotkeys", (val) => {
        if (val != null) set({ hotkeys: sanitizeHotkeys(val) });
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
      store.onKeyChange<string>("captureShortcut", (val) => {
        if (val != null) set({ captureShortcut: val });
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

      // Sync echo cancellation to the backend (it starts on).
      import("../lib/ipc").then(({ setEchoCancellation }) =>
        setEchoCancellation(echoCancellation ?? true)
          .catch((e) => console.warn("[configStore] Failed to sync echo cancellation on load:", e))
      );

      // Sync every CLI agent's config to the backend (it starts with the
      // defaults and keeps the config in memory only).
      for (const { id } of CLI_AGENTS) pushCliAgentConfig(id, cliAgentConfigs[id]);
      // ...and the saved model catalogs, so effort is clamped even before (or
      // without) this start's probe. A fresher probe answer always wins.
      for (const { id } of CLI_AGENTS) {
        const saved = cliAgentModels[id];
        if (!saved || saved.length === 0) continue;
        import("../lib/ipc").then(({ seedCliAgentModels }) =>
          seedCliAgentModels(id, saved).catch((e) =>
            console.warn(`[configStore] Failed to seed the ${id} model list:`, e),
          ),
        );
      }

      // Sync persisted LLM provider + model to Rust backend on startup.
      // The Rust side starts with Ollama as default; this pushes the user's saved provider.
      // A CLI agent ignores the model; its slot carries its Fast model.
      const loadedLLMProvider = llmProvider ?? "ollama";
      const loadedLLMModel = isCliAgent(loadedLLMProvider)
        ? cliSlotModel(cliAgentConfigs[loadedLLMProvider], cliAgentModels[loadedLLMProvider])
        : (llmModel ?? "");
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
