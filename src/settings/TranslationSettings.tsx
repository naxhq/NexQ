// Translation Settings — provider selector with API key management, language config, and behavior toggles.
// Follows the STT/LLM settings pattern: provider grid, API key input, test connection, make active.

import { useState, useEffect, useCallback } from "react";
import { useTranslationStore } from "../stores/translationStore";
import { useConfigStore } from "../stores/configStore";
import {
  setTranslationProvider,
  testTranslationConnection,
  getTranslationLanguages,
  storeApiKey,
  getApiKey,
  hasApiKey,
} from "../lib/ipc";
import type { TranslationProviderType, TranslationLanguage, TranslationConnectionStatus } from "../lib/types";
import {
  Globe,
  Cloud,
  Server,
  Layers,
  Brain,
  CheckCircle,
  XCircle,
  Eye,
  EyeOff,
  Loader2,
  Wifi,
  Zap,
  Info,
} from "lucide-react";
import { OpusMtModelManager } from "./OpusMtModelManager";
import { listOpusMtModels } from "../lib/ipc";
import type { OpusMtModelStatus } from "../lib/types";
import { opusMtDescription } from "../lib/opusMt";

// ── Provider definitions ──

interface ProviderOption {
  value: TranslationProviderType;
  label: string;
  description: string;
  requiresApiKey: boolean;
  isLocal: boolean;
  credentialKey: string;
  needsRegion?: boolean;
  helpUrl?: string;
  helpLabel?: string;
}

const LOCAL_PROVIDERS: ProviderOption[] = [
  {
    value: "opus-mt",
    label: "OPUS-MT",
    description: opusMtDescription([]), // replaced by the real model count once the list loads
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
  },
  {
    value: "llm",
    label: "LLM Translation",
    description: "Uses your active LLM provider",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
  },
];

const CLOUD_PROVIDERS: ProviderOption[] = [
  {
    value: "microsoft",
    label: "Microsoft Translator",
    description: "179 langs · 2M free/mo",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_microsoft",
    needsRegion: true,
    helpUrl: "https://learn.microsoft.com/en-us/azure/cognitive-services/translator/quickstart-text-rest-api",
    helpLabel: "Get a free API key",
  },
  {
    value: "google",
    label: "Google Translate",
    description: "133 langs · $20 free/mo",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_google",
    helpUrl: "https://cloud.google.com/translate/docs/setup",
    helpLabel: "Get a free API key",
  },
  {
    value: "deepl",
    label: "DeepL",
    description: "31 langs · 500K free/mo",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_deepl",
    helpUrl: "https://www.deepl.com/pro-api",
    helpLabel: "Get a free API key",
  },
];

const ALL_PROVIDERS: ProviderOption[] = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS];

// ── Languages (comprehensive default list) ──

const DEFAULT_TARGET_LANGUAGES = [
  { code: "af", name: "Afrikaans" },
  { code: "ar", name: "Arabic" },
  { code: "bn", name: "Bengali" },
  { code: "bg", name: "Bulgarian" },
  { code: "zh", name: "Chinese (Simplified)" },
  { code: "zh-TW", name: "Chinese (Traditional)" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "et", name: "Estonian" },
  { code: "fa", name: "Farsi (Persian)" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "es", name: "Spanish" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "vi", name: "Vietnamese" },
];

// ── Azure Regions ──

const AZURE_REGIONS = [
  "global",
  "eastus",
  "eastus2",
  "westus",
  "westus2",
  "centralus",
  "northeurope",
  "westeurope",
  "southeastasia",
  "eastasia",
  "japaneast",
  "australiaeast",
  "brazilsouth",
  "canadacentral",
  "uksouth",
];

// ── Badge logic ──

type BadgeVariant = "ready" | "available" | "no-key";
interface BadgeState { text: string; variant: BadgeVariant }

const BADGE_STYLES: Record<BadgeVariant, string> = {
  "ready": "bg-success/20 text-success border-success/20",
  "available": "bg-info/20 text-info border-info/20",
  "no-key": "bg-muted text-muted-foreground border-border/30",
};

// Status dot colors derived from badge variant
const DOT_COLORS: Record<BadgeVariant, string> = {
  "ready": "bg-success",
  "available": "bg-info",
  "no-key": "bg-muted-foreground/40",
};

type ConnectionStatus = "idle" | "testing" | "success" | "error";

// ══════════════════════════════════════════════════════════════

export function TranslationSettings() {
  const provider = useTranslationStore((s) => s.provider);
  const setStoreProvider = useTranslationStore((s) => s.setProvider);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const setTargetLang = useTranslationStore((s) => s.setTargetLang);
  const sourceLang = useTranslationStore((s) => s.sourceLang);
  const setSourceLang = useTranslationStore((s) => s.setSourceLang);
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const autoTranslateEnabled = useTranslationStore((s) => s.autoTranslateEnabled);
  const setAutoTranslateEnabled = useTranslationStore((s) => s.setAutoTranslateEnabled);
  const selectionToolbarEnabled = useTranslationStore((s) => s.selectionToolbarEnabled);
  const setSelectionToolbarEnabled = useTranslationStore((s) => s.setSelectionToolbarEnabled);
  const cacheEnabled = useTranslationStore((s) => s.cacheEnabled);
  const setCacheEnabled = useTranslationStore((s) => s.setCacheEnabled);
  const showPostMeetingTranslation = useConfigStore((s) => s.showPostMeetingTranslation);
  const setShowPostMeetingTranslation = useConfigStore((s) => s.setShowPostMeetingTranslation);

  const [selectedProvider, setSelectedProvider] = useState<TranslationProviderType>(provider);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [responseMs, setResponseMs] = useState<number | null>(null);
  const [azureRegion, setAzureRegion] = useState("global");
  const [keyStatusMap, setKeyStatusMap] = useState<Record<string, boolean>>({});
  const [availableLanguages, setAvailableLanguages] = useState<TranslationLanguage[]>([]);
  const [testedProviders, setTestedProviders] = useState<Set<string>>(new Set());
  const [opusMtModels, setOpusMtModels] = useState<OpusMtModelStatus[]>([]);

  // Sync selectedProvider grid when the active provider loads from storage
  // (loadConfig runs async after mount, so useState initial value may be stale)
  useEffect(() => {
    setSelectedProvider(provider);
  }, [provider]);

  const currentProviderOption = ALL_PROVIDERS.find((p) => p.value === selectedProvider);

  // ── Load OPUS-MT model status for badge display + language filtering ──
  // Refreshes when the active provider changes (e.g., after activating a new model)

  const refreshOpusMtModels = useCallback((fresh?: OpusMtModelStatus[]) => {
    const apply = (models: OpusMtModelStatus[]) => {
      setOpusMtModels(models);
      // When OPUS-MT is active, sync targetLang to the active model's target
      if (provider === "opus-mt") {
        const active = models.find((m) => m.is_active);
        if (active && targetLang !== active.definition.target_lang) {
          setTargetLang(active.definition.target_lang);
          setSourceLang(active.definition.source_lang);
        }
      }
    };
    if (fresh) {
      apply(fresh);
    } else {
      listOpusMtModels().then(apply).catch(() => {});
    }
  }, [provider, targetLang, setTargetLang, setSourceLang]);

  useEffect(() => {
    refreshOpusMtModels();
  }, [provider, refreshOpusMtModels]);

  const opusMtDownloadedCount = opusMtModels.filter((m) => m.is_downloaded).length;
  const opusMtHasActive = opusMtModels.some((m) => m.is_active);

  // ── Check which cloud providers have stored keys (for badge display) ──

  useEffect(() => {
    async function checkAllKeys() {
      const status: Record<string, boolean> = {};
      for (const p of CLOUD_PROVIDERS) {
        try { status[p.credentialKey] = await hasApiKey(p.credentialKey); } catch { status[p.credentialKey] = false; }
      }
      setKeyStatusMap(status);
    }
    checkAllKeys();
  }, []);

  // ── Fetch languages from active provider on initial load ──

  useEffect(() => {
    async function fetchLanguages() {
      try {
        const langs = await getTranslationLanguages();
        if (langs.length > 0) setAvailableLanguages(langs);
      } catch { /* fallback to defaults */ }
    }
    fetchLanguages();
  }, []);

  // ── Load key when provider changes ──

  useEffect(() => {
    const loadKeyForProvider = async () => {
      setApiKey("");
      setShowApiKey(false);
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");
      setResponseMs(null);

      if (!currentProviderOption?.requiresApiKey) return;

      const credKey = currentProviderOption.credentialKey;
      if (!credKey) return;

      try {
        const keyExists = await hasApiKey(credKey);
        setHasStoredKey(keyExists);
        if (keyExists) {
          const stored = await getApiKey(credKey);
          if (stored) setApiKey(stored);
        }
      } catch (e) {
        console.warn("Failed to load translation API key:", e);
      }

      if (currentProviderOption.needsRegion) {
        try {
          const regionExists = await hasApiKey("translation_microsoft_region");
          if (regionExists) {
            const stored = await getApiKey("translation_microsoft_region");
            if (stored) setAzureRegion(stored);
          }
        } catch (e) {
          console.warn("Failed to load Azure region:", e);
        }
      }
    };
    loadKeyForProvider();
  }, [selectedProvider, currentProviderOption?.credentialKey, currentProviderOption?.requiresApiKey, currentProviderOption?.needsRegion]);

  // ── Badge state ──

  function getBadgeState(p: ProviderOption): BadgeState {
    if (p.isLocal) {
      if (p.value === "llm") {
        return { text: "Available", variant: "available" };
      }
      // OPUS-MT — dynamic badge based on model presence
      if (p.value === "opus-mt") {
        if (opusMtHasActive) return { text: "Ready", variant: "ready" };
        if (opusMtDownloadedCount > 0) return { text: `${opusMtDownloadedCount} Models`, variant: "available" };
        return { text: "No Models", variant: "no-key" };
      }
      return { text: "Not Ready", variant: "no-key" };
    }
    // Cloud providers
    if (testedProviders.has(p.value)) return { text: "Ready", variant: "ready" };
    if (keyStatusMap[p.credentialKey]) return { text: "Has Key", variant: "available" };
    return { text: "No Key", variant: "no-key" };
  }

  // ── Handlers ──

  const handleProviderSelect = (prov: TranslationProviderType) => {
    setSelectedProvider(prov);
    setConnectionStatus("idle");
    setStatusMessage("");
    setResponseMs(null);
  };

  const handleSaveAndTest = useCallback(async () => {
    if (!currentProviderOption?.requiresApiKey) return;
    if (!apiKey.trim()) return;

    setConnectionStatus("testing");
    setStatusMessage("Testing connection...");
    setResponseMs(null);

    try {
      // Store the key in CredentialManager
      await storeApiKey(currentProviderOption.credentialKey, apiKey.trim());

      // Store region for Microsoft
      if (currentProviderOption.needsRegion && azureRegion.trim()) {
        await storeApiKey("translation_microsoft_region", azureRegion.trim());
      }

      // Temporarily set this provider on backend to test it
      const previousProvider = provider; // the currently active provider
      await setTranslationProvider(
        selectedProvider,
        currentProviderOption.needsRegion ? azureRegion : undefined
      );

      // Test the connection
      const result: TranslationConnectionStatus = await testTranslationConnection(selectedProvider);

      if (result.connected) {
        // Test passed — keep this provider active on backend
        setHasStoredKey(true);
        setKeyDirty(false);
        setConnectionStatus("success");
        setResponseMs(result.response_ms);
        setStatusMessage(
          `Connected — ${result.language_count} languages available (${result.response_ms}ms)`
        );
        setKeyStatusMap((prev) => ({ ...prev, [currentProviderOption.credentialKey]: true }));
        setTestedProviders((prev) => new Set(prev).add(selectedProvider));

        // Load available languages
        try {
          const langs = await getTranslationLanguages();
          if (langs.length > 0) setAvailableLanguages(langs);
        } catch { /* ignore — fallback to defaults */ }

        // Restore previous active provider on backend (don't change active yet — user must click Make Active)
        if (previousProvider && previousProvider !== selectedProvider) {
          await setTranslationProvider(previousProvider).catch(() => {});
        }
      } else {
        // Test failed — restore previous provider on backend
        if (previousProvider) {
          await setTranslationProvider(previousProvider).catch(() => {});
        }
        setConnectionStatus("error");
        setStatusMessage(result.error || "Connection failed");
      }
    } catch (e) {
      setConnectionStatus("error");
      setStatusMessage(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  }, [apiKey, azureRegion, selectedProvider, currentProviderOption, setStoreProvider]);

  const handleTestLocal = useCallback(async () => {
    setConnectionStatus("testing");
    setStatusMessage("Testing...");
    setResponseMs(null);

    const previousProvider = provider;
    try {
      await setTranslationProvider(selectedProvider);
      const result = await testTranslationConnection(selectedProvider);

      if (result.connected) {
        setConnectionStatus("success");
        setResponseMs(result.response_ms);
        setStatusMessage(
          `Connected — ${result.language_count} languages (${result.response_ms}ms)`
        );
        setTestedProviders((prev) => new Set(prev).add(selectedProvider));
        setStoreProvider(selectedProvider);
      } else {
        // Restore previous provider on test failure
        if (previousProvider && previousProvider !== selectedProvider) {
          await setTranslationProvider(previousProvider).catch(() => {});
        }
        setConnectionStatus("error");
        setStatusMessage(result.error || "Connection failed");
      }
    } catch (e) {
      // Restore previous provider on exception
      if (previousProvider && previousProvider !== selectedProvider) {
        await setTranslationProvider(previousProvider).catch(() => {});
      }
      setConnectionStatus("error");
      setStatusMessage(e instanceof Error ? e.message : "Test failed");
    }
  }, [selectedProvider, provider, setStoreProvider]);

  const handleMakeActive = useCallback(async () => {
    try {
      if (currentProviderOption?.requiresApiKey && apiKey) {
        await storeApiKey(currentProviderOption.credentialKey, apiKey).catch(() => {});
      }
      await setTranslationProvider(
        selectedProvider,
        currentProviderOption?.needsRegion ? azureRegion : undefined
      );
      setStoreProvider(selectedProvider);
    } catch { /* ignore */ }
  }, [selectedProvider, apiKey, azureRegion, currentProviderOption, setStoreProvider]);

  // ── Language list for dropdowns ──
  // Always use the comprehensive default list as the base.
  // If the provider returned additional languages not in the defaults, merge them in.

  const languageOptions = (() => {
    // When OPUS-MT is active, only show the active model's target language
    if (provider === "opus-mt" && opusMtModels.length > 0) {
      const activeModel = opusMtModels.find((m) => m.is_active);
      if (activeModel) {
        const code = activeModel.definition.target_lang;
        const match = DEFAULT_TARGET_LANGUAGES.find((l) => l.code === code);
        return match ? [match] : [{ code, name: activeModel.definition.target_name }];
      }
    }

    const base = [...DEFAULT_TARGET_LANGUAGES];
    if (availableLanguages.length > 0) {
      const existingCodes = new Set(base.map((l) => l.code));
      for (const pl of availableLanguages) {
        if (!existingCodes.has(pl.code)) {
          base.push({ code: pl.code, name: pl.name });
        }
      }
    }
    return base.sort((a, b) => a.name.localeCompare(b.name));
  })();

  const isCloud = currentProviderOption?.requiresApiKey ?? false;
  const isOpusMt = selectedProvider === "opus-mt";
  const isLlm = selectedProvider === "llm";

  // ── "Make Active" gating logic ──
  // Cloud: tested this session OR has a stored key (and key not dirty). OPUS-MT: when model is active. LLM: always.
  const canMakeActive = (() => {
    if (selectedProvider === provider) return false; // already active
    if (isOpusMt) return opusMtHasActive;
    if (isCloud) return (testedProviders.has(selectedProvider) || hasStoredKey) && !keyDirty;
    if (isLlm) return true;
    return false;
  })();

  return (
    <div className="space-y-5">
      {/* ── Active Provider Banner (full-width above grid) ── */}
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3.5">
        <Globe className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Active: {ALL_PROVIDERS.find((p) => p.value === provider)?.label || provider}
            {" · "}
            {DEFAULT_TARGET_LANGUAGES.find((l) => l.code === targetLang)?.name || targetLang}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            This provider will be used for transcript translation
          </p>
        </div>
        {connectionStatus === "success" && selectedProvider === provider && (
          <div className="flex items-center gap-1 text-success shrink-0">
            <CheckCircle className="h-3.5 w-3.5" />
            <span className="text-xs">Connected</span>
          </div>
        )}
      </div>

      {/* ── Two-column grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ═══ LEFT COLUMN: Provider-specific ═══ */}
        <div className="space-y-5">
          {/* ── Provider Selection Grid ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
            {/* Local & Offline */}
            <div className="px-5 pt-4 pb-3 border-b border-border/20 bg-muted/10">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-success/10">
                  <Server className="h-3 w-3 text-success" />
                </div>
                <span className="text-xs font-semibold text-foreground">Local & Offline</span>
                <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">
                  Free · No API Key · Private
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {LOCAL_PROVIDERS.map((p) => (
                  <ProviderCard
                    key={p.value}
                    provider={p.value === "opus-mt" ? { ...p, description: opusMtDescription(opusMtModels) } : p}
                    isSelected={selectedProvider === p.value}
                    isActive={provider === p.value}
                    badge={getBadgeState(p)}
                    onClick={() => handleProviderSelect(p.value)}
                  />
                ))}
              </div>
            </div>

            {/* Cloud Providers */}
            <div className="px-5 pt-4 pb-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-info/10">
                  <Cloud className="h-3 w-3 text-info" />
                </div>
                <span className="text-xs font-semibold text-foreground">Cloud Providers</span>
                <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">
                  Requires API Key
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {CLOUD_PROVIDERS.map((p) => (
                  <ProviderCard
                    key={p.value}
                    provider={p}
                    isSelected={selectedProvider === p.value}
                    isActive={provider === p.value}
                    badge={getBadgeState(p)}
                    onClick={() => handleProviderSelect(p.value)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ── API Key Configuration (cloud providers only) ── */}
          {isCloud && (
            <div className="rounded-xl border border-border/30 bg-card/50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-primary/80">API Key</h3>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyDirty(true);
                      setConnectionStatus("idle");
                      setStatusMessage("");
                    }}
                    placeholder={
                      hasStoredKey && !keyDirty
                        ? "Key stored — type to replace"
                        : `Enter ${currentProviderOption?.label || selectedProvider} API key`
                    }
                    maxLength={256}
                    className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                    type="button"
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    aria-pressed={showApiKey}
                  >
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {/* State 1: Key is new or changed → Save & Test */}
                {keyDirty && apiKey.trim() && (
                  <button
                    onClick={handleSaveAndTest}
                    disabled={connectionStatus === "testing"}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  >
                    {connectionStatus === "testing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wifi className="h-3.5 w-3.5" />
                    )}
                    Save & Test
                  </button>
                )}

                {/* State 2: Key stored, not yet tested this session → Test Connection */}
                {hasStoredKey && !keyDirty && !testedProviders.has(selectedProvider) && (
                  <button
                    onClick={handleSaveAndTest}
                    disabled={connectionStatus === "testing"}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  >
                    {connectionStatus === "testing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wifi className="h-3.5 w-3.5" />
                    )}
                    Test Connection
                  </button>
                )}

                {/* Clear stored key */}
                {hasStoredKey && !keyDirty && (
                  <button
                    onClick={async () => {
                      if (!currentProviderOption) return;
                      try {
                        const { deleteApiKey } = await import("../lib/ipc");
                        await deleteApiKey(currentProviderOption.credentialKey);
                        setHasStoredKey(false);
                        setApiKey("");
                        setConnectionStatus("idle");
                        setStatusMessage("");
                        setTestedProviders((prev) => {
                          const next = new Set(prev);
                          next.delete(selectedProvider);
                          return next;
                        });
                        setKeyStatusMap((prev) => ({ ...prev, [currentProviderOption.credentialKey]: false }));
                      } catch { /* ignore */ }
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                    title="Remove stored API key"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
              </div>

              {/* Help link */}
              {currentProviderOption?.helpUrl && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <a
                    href={currentProviderOption.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary/70 hover:text-primary underline-offset-2 hover:underline"
                  >
                    {currentProviderOption.helpLabel || "Get a free API key"} &rarr;
                  </a>
                </p>
              )}

              {/* Azure Region dropdown (Microsoft only) */}
              {currentProviderOption?.needsRegion && (
                <div className="mt-3">
                  <label className="mb-1.5 block text-xs font-medium text-foreground">Azure Region</label>
                  <select
                    value={azureRegion}
                    onChange={(e) => setAzureRegion(e.target.value)}
                    className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
                  >
                    {AZURE_REGIONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Region for your Azure Translator resource
                  </p>
                </div>
              )}

              {/* Status feedback */}
              <div className="mt-2 min-h-[18px]">
                {connectionStatus === "success" && (
                  <div className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle className="h-3 w-3" />
                    {statusMessage}
                  </div>
                )}
                {connectionStatus === "error" && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <XCircle className="h-3 w-3" />
                    {statusMessage}
                  </div>
                )}
                {connectionStatus === "idle" && hasStoredKey && !keyDirty && (
                  <p className="text-xs text-success/70">
                    API key stored securely
                  </p>
                )}
                {connectionStatus === "idle" && !hasStoredKey && (
                  <p className="text-xs text-muted-foreground">
                    Enter your key and click Save & Test
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── OPUS-MT Model Manager ── */}
          {isOpusMt && <OpusMtModelManager onModelsChanged={refreshOpusMtModels} />}

          {/* ── LLM local provider — Test Connection ── */}
          {isLlm && (
            <div className="rounded-xl border border-border/30 bg-card/50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-primary/80">Connection</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTestLocal}
                  disabled={connectionStatus === "testing"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {connectionStatus === "testing" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wifi className="h-3.5 w-3.5" />
                  )}
                  Test Connection
                </button>

                {canMakeActive && (
                  <button
                    onClick={handleMakeActive}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Make Active
                  </button>
                )}

                {connectionStatus === "success" && (
                  <div className="flex items-center gap-1 text-success">
                    <CheckCircle className="h-3.5 w-3.5" />
                    <span className="text-xs">{statusMessage}</span>
                  </div>
                )}
                {connectionStatus === "error" && (
                  <div className="flex items-center gap-1 text-destructive">
                    <XCircle className="h-3.5 w-3.5" />
                    <span className="text-xs">{statusMessage}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Make Active — full-width at bottom of left column */}
          {canMakeActive && (
            <button
              onClick={handleMakeActive}
              className="w-full rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition-all duration-150 hover:bg-primary/10 hover:-translate-y-px active:translate-y-px active:scale-[0.99] cursor-pointer"
            >
              Set {currentProviderOption?.label || selectedProvider} as Active Translation Provider
            </button>
          )}
        </div>

        {/* ═══ RIGHT COLUMN: Common settings ═══ */}
        <div className="space-y-5">
          {/* ── Language Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">Language</h3>

            {/* Banner: activate provider to see its languages */}
            {selectedProvider !== provider && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-info/20 bg-info/5 px-3 py-2">
                <Info className="h-3.5 w-3.5 text-info shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Activate <span className="font-medium text-foreground">{currentProviderOption?.label}</span> to see its supported languages
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Target Language</label>
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
                >
                  {languageOptions.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Translate transcripts into this language
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Source Language</label>
                <select
                  value={sourceLang}
                  onChange={(e) => setSourceLang(e.target.value)}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
                >
                  <option value="auto">Auto-detect (recommended)</option>
                  {languageOptions.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Detect source language automatically or set explicitly
                </p>
              </div>
            </div>
          </div>

          {/* ── Behavior Toggles ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">Behavior</h3>
            <div className="space-y-4">
              {/* Select-to-translate toolbar */}
              <ToggleRow
                label="Select-to-translate toolbar"
                description="Show a translate button when selecting text in the transcript"
                checked={selectionToolbarEnabled}
                onChange={setSelectionToolbarEnabled}
              />

              {/* Show translations in post-meeting */}
              <ToggleRow
                label="Show translations in post-meeting review"
                description="Display translation toolbar and cached translations when reviewing past meetings"
                checked={showPostMeetingTranslation}
                onChange={setShowPostMeetingTranslation}
              />

              {/* Cache translations */}
              <ToggleRow
                label="Cache translations"
                description="Store translated text locally to avoid re-translating the same content"
                checked={cacheEnabled}
                onChange={setCacheEnabled}
              />
            </div>
          </div>
        </div>
      </div>
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
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 bg-card/30 hover:border-border/70 hover:bg-accent/60"
      }`}
    >
      {/* Status dot — color reflects actual badge state */}
      {isActive && (
        <div className="absolute -top-1 -right-1">
          <div
            className={`h-2.5 w-2.5 rounded-full ring-2 ring-card ${DOT_COLORS[badge.variant]}`}
            title={`Active provider — ${badge.text}`}
            aria-hidden="true"
          />
        </div>
      )}
      <div className="flex w-full items-center gap-1.5 mb-1">
        <ProviderIcon value={provider.value} isSelected={isSelected} />
        <span className={`text-xs font-medium ${isSelected ? "text-primary" : "text-foreground"}`}>
          {provider.label}
        </span>
        <span
          className={`ml-auto inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[8px] font-semibold tracking-wide ${BADGE_STYLES[badge.variant]}`}
        >
          {badge.text}
        </span>
      </div>
      <span className="text-meta text-muted-foreground/70 leading-tight">
        {provider.description}
      </span>
    </button>
  );
}

// ── Provider icon helper ──

function ProviderIcon({ value, isSelected }: { value: TranslationProviderType; isSelected?: boolean }) {
  const cls = `h-3.5 w-3.5 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`;
  switch (value) {
    case "opus-mt":
      return <Layers className={cls} />;
    case "llm":
      return <Brain className={cls} />;
    case "microsoft":
      return <Cloud className={cls} />;
    case "google":
      return <Globe className={cls} />;
    case "deepl":
      return <Cloud className={cls} />;
    default:
      return <Server className={cls} />;
  }
}

// ── Toggle Row ──

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}
