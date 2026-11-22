import { hasApiKey } from "./ipc";

/** Credential-store keys for the optional custom Whisper API endpoint (non-secret). */
export const WHISPER_API_KEY = "whisper_api";
export const WHISPER_API_BASE_URL_KEY = "whisper_api_base_url";
export const WHISPER_API_MODEL_KEY = "whisper_api_model";

/** Whisper API counts as configured with an API key OR a custom endpoint (local servers need no key). */
export function isWhisperApiConfigured(hasKey: boolean, hasBaseUrl: boolean): boolean {
  return hasKey || hasBaseUrl;
}

/**
 * Whether a cloud STT provider has its credentials stored.
 * Same as `hasApiKey`, except Whisper API is also configured by a custom endpoint alone.
 */
export async function hasSttCredential(provider: string): Promise<boolean> {
  if (provider !== WHISPER_API_KEY) return hasApiKey(provider);
  const [hasKey, hasBaseUrl] = await Promise.all([
    hasApiKey(WHISPER_API_KEY).catch(() => false),
    hasApiKey(WHISPER_API_BASE_URL_KEY).catch(() => false),
  ]);
  return isWhisperApiConfigured(hasKey, hasBaseUrl);
}

/** Empty is valid (OpenAI default); otherwise the endpoint needs an http(s) scheme and a host. */
export function isValidWhisperBaseUrl(value: string): boolean {
  const v = value.trim();
  return v === "" || /^https?:\/\/[^/\s]+/i.test(v);
}
