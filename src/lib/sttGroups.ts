import type { STTProviderType } from "./types";

/**
 * Where an engine runs and what it needs. Every picker groups by this.
 * device: on this computer. builtin: comes with the system, no key, but the audio goes online.
 * cloud: an online service that needs a key.
 */
export type SttGroupId = "device" | "builtin" | "cloud";

export const STT_GROUPS: { id: SttGroupId; label: string; menuLabel: string; note: string }[] = [
  { id: "device", label: "On this computer", menuLabel: "On this computer", note: "Free · Offline after download" },
  { id: "builtin", label: "Built-in", menuLabel: "Built-in · online", note: "Free · No key · Audio goes online" },
  { id: "cloud", label: "Cloud", menuLabel: "Cloud", note: "Requires API key" },
];

const DEVICE: readonly STTProviderType[] = ["sherpa_onnx", "ort_streaming", "whisper_cpp", "parakeet_tdt"];
const BUILTIN: readonly STTProviderType[] = ["web_speech", "windows_native"];

export function sttGroup(provider: STTProviderType): SttGroupId {
  if (DEVICE.includes(provider)) return "device";
  if (BUILTIN.includes(provider)) return "builtin";
  return "cloud";
}
