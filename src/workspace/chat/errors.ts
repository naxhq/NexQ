// What went wrong with an answer, in words that say what to do. The raw text is always kept (shown under it).

export type ChatErrorKind = "auth" | "model" | "limit" | "window" | "offline" | "busy" | "other";
export type ChatFix = "settings" | "model" | "retry";

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  title: string;
  /** The provider's own message, trimmed. */
  detail: string;
  /** What the user can do about it, best first. */
  fixes: ChatFix[];
}

const RULES: Array<[RegExp, ChatErrorKind]> = [
  [/api key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|not logged in|log ?in|sign ?in|authenticat|credential/i, "auth"],
  [/(model|deployment).{0,40}(not found|unknown|unavailable|does not exist|not supported)|\b404\b/i, "model"],
  [/rate.?limit|\b429\b|quota|usage limit|overloaded|\b529\b|too many requests/i, "limit"],
  [/context (length|window)|too long|maximum context|token limit|exceeds the (limit|window)/i, "window"],
  [/econnrefused|connect|timed? ?out|network|unreachable|not running|dns|offline|refused/i, "offline"],
  [/another request|one at a time|already running|busy/i, "busy"],
];

const TITLES: Record<ChatErrorKind, string> = {
  auth: "The provider didn't accept your sign-in",
  model: "This model isn't available",
  limit: "The provider is limiting requests",
  window: "The question and its material don't fit this model",
  offline: "Couldn't reach the model",
  busy: "Another answer is still running",
  other: "The answer failed",
};

const FIXES: Record<ChatErrorKind, ChatFix[]> = {
  auth: ["settings", "model"],
  model: ["model", "settings"],
  limit: ["model", "retry"],
  window: ["model", "retry"],
  offline: ["settings", "retry", "model"],
  busy: ["retry"],
  other: ["retry", "model", "settings"],
};

export function classifyChatError(raw: string): ChatErrorInfo {
  const detail = (raw || "").trim();
  const kind = RULES.find(([re]) => re.test(detail))?.[1] ?? "other";
  return { kind, title: TITLES[kind], detail: detail || "No details were given.", fixes: FIXES[kind] };
}
