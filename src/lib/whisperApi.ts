import { hasApiKey } from "./ipc";

/** Credential-store keys for the optional custom Whisper API endpoint (non-secret). */
export const WHISPER_API_KEY = "whisper_api";
/** Optional key for a custom endpoint. The OpenAI key (above) is never sent to a custom server. */
export const WHISPER_API_CUSTOM_KEY = "whisper_api_custom_key";
export const WHISPER_API_BASE_URL_KEY = "whisper_api_base_url";
export const WHISPER_API_MODEL_KEY = "whisper_api_model";

/** OpenAI's base URL, the default when no custom endpoint is set. */
export const WHISPER_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Shown when the endpoint field is not an http(s) URL. */
export const WHISPER_ENDPOINT_ERROR = "Endpoint must start with http:// or https:// (for example http://127.0.0.1:8000/v1)";

/** Whisper API counts as configured with the OpenAI key OR a custom endpoint (its own key is optional). */
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

/** True for an http:// endpoint on a host other than this machine (a key would travel unencrypted). */
export function isInsecureRemoteHttp(value: string): boolean {
  const v = value.trim();
  if (!/^http:\/\//i.test(v)) return false;
  try {
    const host = new URL(v).hostname.toLowerCase();
    return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1");
  } catch {
    return false;
  }
}

/**
 * True when the typed endpoint is a server other than OpenAI. Mirrors the Rust
 * normalization: trim, drop trailing slashes, strip a pasted `/audio/transcriptions`,
 * then compare to the OpenAI URL case-insensitively. Empty is not custom.
 */
export function isCustomWhisperEndpoint(raw: string): boolean {
  let v = raw.trim().replace(/\/+$/, "");
  v = v.replace(/\/audio\/transcriptions$/i, "").replace(/\/+$/, "");
  if (v === "") return false;
  return v.toLowerCase() !== WHISPER_OPENAI_BASE_URL;
}
