// Meeting Audio Presets — one-click configuration profiles.

import type {
  AudioDevice,
  MeetingAudioConfig,
  STTProviderType,
} from "../lib/types";

export interface MeetingPreset {
  name: string;
  description: string;
  badge?: string;
  you: { hint: DeviceHint; stt: STTProviderType };
  them: { hint: DeviceHint; stt: STTProviderType };
  requiresKey?: string;
  requiresDownload?: string;
  windowsOnly?: boolean;
}

/** Hints for resolving device IDs at apply time. */
export type DeviceHint =
  | "default_mic"    // Default input device
  | "default_output" // Default output device
  | "mic_2";         // Second mic (for in-person with two mics)

export const BUILT_IN_PRESETS: MeetingPreset[] = [
  {
    // Windows Speech can't transcribe system audio (it only listens to the
    // default mic), so the other side uses a local model instead.
    name: "Free",
    description: "Web Speech for you, Parakeet TDT for the other side — free and private (one-time model download)",
    badge: "Default",
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "default_output", stt: "parakeet_tdt" },
    requiresDownload: "parakeet_tdt",
  },
  {
    name: "Best Quality",
    description: "Deepgram cloud — fastest, most accurate",
    badge: "Recommended",
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "default_output", stt: "deepgram" },
    requiresKey: "deepgram",
  },
  {
    name: "Fully Offline",
    description: "Sherpa-ONNX — no internet needed",
    badge: "Free",
    you: { hint: "default_mic", stt: "sherpa_onnx" },
    them: { hint: "default_output", stt: "sherpa_onnx" },
    requiresDownload: "sherpa_onnx",
  },
  {
    name: "All Cloud",
    description: "Deepgram for both parties",
    you: { hint: "default_mic", stt: "deepgram" },
    them: { hint: "default_output", stt: "deepgram" },
    requiresKey: "deepgram",
  },
  {
    name: "Local Only (Parakeet)",
    description: "Parakeet TDT for both parties, offline and free (one-time model download)",
    you: { hint: "default_mic", stt: "parakeet_tdt" },
    them: { hint: "default_output", stt: "parakeet_tdt" },
    requiresDownload: "parakeet_tdt",
  },
  {
    name: "In-Person",
    description: "Both parties use mic input: Web Speech for you, Parakeet TDT for the second mic (one-time model download)",
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "mic_2", stt: "parakeet_tdt" },
    requiresDownload: "parakeet_tdt",
  },
];

/** Resolve a device hint to an actual device ID. */
function resolveHint(hint: DeviceHint, devices: AudioDevice[]): { device_id: string; is_input: boolean } {
  switch (hint) {
    case "default_mic": {
      const mic = devices.find((d) => d.is_input && d.is_default)
        ?? devices.find((d) => d.is_input);
      return { device_id: mic?.id ?? "default", is_input: true };
    }
    case "default_output": {
      const out = devices.find((d) => !d.is_input && d.is_default)
        ?? devices.find((d) => !d.is_input);
      return { device_id: out?.id ?? "default", is_input: false };
    }
    case "mic_2": {
      // Second microphone — skip the default
      const mics = devices.filter((d) => d.is_input);
      const second = mics.find((d) => !d.is_default) ?? mics[0];
      return { device_id: second?.id ?? "default", is_input: true };
    }
  }
}

/** Apply a preset using the current list of audio devices. */
export function applyPreset(
  preset: MeetingPreset,
  devices: AudioDevice[]
): MeetingAudioConfig {
  const youDevice = resolveHint(preset.you.hint, devices);
  const themDevice = resolveHint(preset.them.hint, devices);

  return {
    you: {
      role: "You",
      device_id: youDevice.device_id,
      is_input_device: youDevice.is_input,
      stt_provider: preset.you.stt,
    },
    them: {
      role: "Them",
      device_id: themDevice.device_id,
      is_input_device: themDevice.is_input,
      stt_provider: preset.them.stt,
    },
    recording_enabled: false,
    preset_name: preset.name,
  };
}
