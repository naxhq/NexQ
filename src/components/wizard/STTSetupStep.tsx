// Wizard Step 3: STT Configuration — per-party STT provider selection.

import { useState, useEffect, type KeyboardEvent } from "react";
import { useConfigStore } from "../../stores/configStore";
import { hasApiKey } from "../../lib/ipc";
import { hasSttCredential } from "../../lib/whisperApi";
import type { STTProviderType, MeetingAudioConfig } from "../../lib/types";
import {
  Globe,
  Cloud,
  Zap,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

export interface ProviderChoice {
  value: STTProviderType;
  label: string;
  icon: React.ReactNode;
  description: string;
  requiresKey: boolean;
  free: boolean;
  preview?: boolean;
}

// Only engines that survive the load-time migration in configStore.loadConfig:
// whisper_cpp is batch-only (not live STT) and is switched away at the next launch.
export const WIZARD_STT_PROVIDERS: ProviderChoice[] = [
  {
    value: "web_speech",
    label: "Web Speech API",
    icon: <Globe className="h-4 w-4" />,
    description: "Browser-native, works with microphone input",
    requiresKey: false,
    free: true,
  },
  {
    value: "deepgram",
    label: "Deepgram",
    icon: <Cloud className="h-4 w-4" />,
    description: "Real-time streaming STT, high accuracy",
    requiresKey: true,
    free: false,
  },
  {
    value: "whisper_api",
    label: "Whisper API",
    icon: <Cloud className="h-4 w-4" />,
    description: "OpenAI Whisper, excellent multilingual support",
    requiresKey: true,
    free: false,
  },
  {
    value: "azure_mai_streaming",
    label: "Azure MAI Streaming",
    icon: <Cloud className="h-4 w-4" />,
    description: "MAI-Transcribe-2-Streaming",
    requiresKey: true,
    free: false,
    preview: true,
  },
  {
    value: "groq_whisper",
    label: "Groq Whisper",
    icon: <Zap className="h-4 w-4" />,
    description: "Ultra-fast Whisper inference",
    requiresKey: true,
    free: false,
  },
  {
    value: "cartesia",
    label: "Cartesia",
    icon: <Cloud className="h-4 w-4" />,
    description: "Ink-2 streaming with turn detection",
    requiresKey: true,
    free: false,
  },
];

const themProviders = WIZARD_STT_PROVIDERS.filter((p) => p.value !== "web_speech");

/**
 * Arrow-key navigation for a radiogroup (roving tabindex): Up/Left and Down/Right
 * move to the previous/next radio and select it, Home/End jump to the first/last.
 */
function radioArrowKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const current = radios.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  let next: number;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowRight":
      next = (current + 1) % radios.length;
      break;
    case "ArrowUp":
    case "ArrowLeft":
      next = (current - 1 + radios.length) % radios.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = radios.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  radios[next].focus();
  radios[next].click();
}

export function STTSetupStep() {
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  const [youSTT, setYouSTT] = useState<STTProviderType>(
    meetingAudioConfig?.you.stt_provider ?? "web_speech"
  );
  const [themSTT, setThemSTT] = useState<STTProviderType>(
    meetingAudioConfig?.them.stt_provider ?? "deepgram"
  );
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [keysChecked, setKeysChecked] = useState(false);

  // Check which API keys are stored
  useEffect(() => {
    async function check() {
      const providers = ["deepgram", "whisper_api", "azure_speech", "azure_mai_streaming", "groq_whisper", "cartesia"];
      const status: Record<string, boolean> = {};
      for (const p of providers) {
        try {
          status[p] = await hasSttCredential(p);
          if (p === "azure_mai_streaming" && status[p]) {
            status[p] = await hasApiKey("azure_mai_streaming_region");
          }
        } catch {
          status[p] = false;
        }
      }
      setKeyStatus(status);
      setKeysChecked(true);
    }
    check();
  }, []);

  // Save selection to config when it changes
  useEffect(() => {
    if (!meetingAudioConfig) return;
    const updated: MeetingAudioConfig = {
      ...meetingAudioConfig,
      you: { ...meetingAudioConfig.you, stt_provider: youSTT },
      them: { ...meetingAudioConfig.them, stt_provider: themSTT },
      preset_name: null,
    };
    setMeetingAudioConfig(updated);
  }, [youSTT, themSTT]);

  return (
    <div className="flex flex-col items-center">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 shadow-md shadow-primary/10">
          <Globe className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">
          Speech-to-Text Setup
        </h2>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Choose how each party's audio gets transcribed.
        </p>
      </div>

      <div className="w-full max-w-lg space-y-6">
        {/* Recommended free setup banner */}
        <div className="rounded-xl border border-success/20 bg-success/5 px-4 py-3">
          <p className="text-xs text-success leading-relaxed">
            <strong>Recommended:</strong> Web Speech for You (free, no key) +
            Deepgram for Them. Offline local models can be added later in
            Settings.
          </p>
        </div>

        {/* YOU STT Selection */}
        <div>
          <label id="stt-you-label" className="mb-3 flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-primary/10 px-2 py-1 text-meta font-semibold uppercase tracking-wide text-primary">
              You
            </span>
            STT Provider
          </label>
          <div role="radiogroup" aria-labelledby="stt-you-label" onKeyDown={radioArrowKeys} className="grid grid-cols-1 gap-2">
            {WIZARD_STT_PROVIDERS.map((p, i) => (
              <ProviderButton
                key={p.value}
                provider={p}
                selected={youSTT === p.value}
                tabStop={youSTT === p.value || (i === 0 && !WIZARD_STT_PROVIDERS.some((q) => q.value === youSTT))}
                hasKey={p.requiresKey ? keyStatus[p.value] ?? false : true}
                onSelect={() => setYouSTT(p.value)}
              />
            ))}
          </div>
          <MissingKeyNote provider={youSTT} keyStatus={keyStatus} checked={keysChecked} />
        </div>

        {/* THEM STT Selection */}
        <div>
          <label id="stt-them-label" className="mb-3 flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-muted px-2 py-1 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
              Them
            </span>
            STT Provider
          </label>
          <div role="radiogroup" aria-labelledby="stt-them-label" onKeyDown={radioArrowKeys} className="grid grid-cols-1 gap-2">
            {themProviders.map((p, i) => (
              <ProviderButton
                key={p.value}
                provider={p}
                selected={themSTT === p.value}
                tabStop={themSTT === p.value || (i === 0 && !themProviders.some((q) => q.value === themSTT))}
                hasKey={p.requiresKey ? keyStatus[p.value] ?? false : true}
                onSelect={() => setThemSTT(p.value)}
              />
            ))}
          </div>
          <MissingKeyNote provider={themSTT} keyStatus={keyStatus} checked={keysChecked} />
          <p className="mt-1 text-meta text-muted-foreground">
            Web Speech API is not available for "Them" — it only works with the browser's microphone.
          </p>
        </div>
      </div>
    </div>
  );
}

/** One plain line when the chosen engine needs an API key that is not saved yet. */
function MissingKeyNote({
  provider,
  keyStatus,
  checked,
}: {
  provider: STTProviderType;
  keyStatus: Record<string, boolean>;
  checked: boolean;
}) {
  const choice = WIZARD_STT_PROVIDERS.find((p) => p.value === provider);
  if (!checked || !choice?.requiresKey || keyStatus[provider]) return null;
  return (
    <p role="status" className="mt-2 text-xs text-amber-700 dark:text-warning leading-relaxed">
      {choice.value === "azure_mai_streaming"
        ? `${choice.label} needs a tested API key and Speech Resource region. Set both in Settings > STT Providers. `
        : `${choice.label} needs an API key. Add it in Settings > STT Providers. `}Free and
      offline instead: in Settings &gt; STT Providers, download and activate Parakeet TDT
      (one-time 465 MB), then pick Settings &gt; Audio &amp; Devices &gt; Presets &gt; Free.
    </p>
  );
}

function ProviderButton({
  provider,
  selected,
  tabStop,
  hasKey,
  onSelect,
}: {
  provider: ProviderChoice;
  selected: boolean;
  tabStop: boolean;
  hasKey: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabStop ? 0 : -1}
      onClick={onSelect}
      className={`flex items-center gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-all duration-150 ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 hover:border-border/60 hover:bg-accent/20"
      }`}
    >
      <span className={selected ? "text-primary" : "text-muted-foreground"}>
        {provider.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {provider.label}
          </span>
          {provider.free && (
            <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-meta font-semibold text-success">
              FREE
            </span>
          )}
          {provider.preview && (
            <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning">
              Public Preview
            </span>
          )}
          {provider.requiresKey && hasKey && (
            <CheckCircle role="img" aria-label="API key saved" className="h-3 w-3 text-success" />
          )}
          {provider.requiresKey && !hasKey && (
            <AlertCircle role="img" aria-label="API key missing" className="h-3 w-3 text-amber-700 dark:text-warning" />
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {provider.description}
        </p>
      </div>
    </button>
  );
}
