// Wizard Step 3: STT Configuration — per-party STT provider selection.

import { useState, useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import { hasApiKey } from "../../lib/ipc";
import type { STTProviderType, MeetingAudioConfig } from "../../lib/types";
import {
  Globe,
  Server,
  Cloud,
  Zap,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

interface ProviderChoice {
  value: STTProviderType;
  label: string;
  icon: React.ReactNode;
  description: string;
  requiresKey: boolean;
  free: boolean;
}

const PROVIDERS: ProviderChoice[] = [
  {
    value: "web_speech",
    label: "Web Speech API",
    icon: <Globe className="h-4 w-4" />,
    description: "Browser-native, works with microphone input",
    requiresKey: false,
    free: true,
  },
  {
    value: "whisper_cpp",
    label: "Whisper.cpp (Local)",
    icon: <Server className="h-4 w-4" />,
    description: "OpenAI Whisper running locally — offline, free",
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

export function STTSetupStep() {
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  const [youSTT, setYouSTT] = useState<STTProviderType>(
    meetingAudioConfig?.you.stt_provider ?? "web_speech"
  );
  const [themSTT, setThemSTT] = useState<STTProviderType>(
    meetingAudioConfig?.them.stt_provider ?? "whisper_cpp"
  );
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});

  // Check which API keys are stored
  useEffect(() => {
    async function check() {
      const providers = ["deepgram", "whisper_api", "azure_speech", "groq_whisper", "cartesia"];
      const status: Record<string, boolean> = {};
      for (const p of providers) {
        try {
          status[p] = await hasApiKey(p);
        } catch {
          status[p] = false;
        }
      }
      setKeyStatus(status);
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
            <strong>Recommended (Free):</strong> Web Speech for You + Windows
            Native for Them. No API keys needed!
          </p>
        </div>

        {/* YOU STT Selection */}
        <div>
          <label className="mb-3 flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-primary/10 px-2 py-1 text-meta font-semibold uppercase tracking-wide text-primary">
              You
            </span>
            STT Provider
          </label>
          <div className="grid grid-cols-1 gap-2">
            {PROVIDERS.map((p) => (
              <ProviderButton
                key={p.value}
                provider={p}
                selected={youSTT === p.value}
                hasKey={p.requiresKey ? keyStatus[p.value] ?? false : true}
                onSelect={() => setYouSTT(p.value)}
              />
            ))}
          </div>
        </div>

        {/* THEM STT Selection */}
        <div>
          <label className="mb-3 flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-muted px-2 py-1 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
              Them
            </span>
            STT Provider
          </label>
          <div className="grid grid-cols-1 gap-2">
            {PROVIDERS.filter((p) => p.value !== "web_speech").map((p) => (
              <ProviderButton
                key={p.value}
                provider={p}
                selected={themSTT === p.value}
                hasKey={p.requiresKey ? keyStatus[p.value] ?? false : true}
                onSelect={() => setThemSTT(p.value)}
              />
            ))}
          </div>
          <p className="mt-1 text-meta text-muted-foreground">
            Web Speech API is not available for "Them" — it only works with the browser's microphone.
          </p>
        </div>
      </div>
    </div>
  );
}

function ProviderButton({
  provider,
  selected,
  hasKey,
  onSelect,
}: {
  provider: ProviderChoice;
  selected: boolean;
  hasKey: boolean;
  onSelect: () => void;
}) {
  return (
    <button
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
          {provider.requiresKey && hasKey && (
            <CheckCircle className="h-3 w-3 text-success" />
          )}
          {provider.requiresKey && !hasKey && (
            <AlertCircle className="h-3 w-3 text-yellow-500" />
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {provider.description}
        </p>
      </div>
    </button>
  );
}
