// One vocabulary for providers, wherever a model is named (chat, notes, brief, memory).
// Never show a raw id: an id we do not know is turned into words.

export const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  custom: "Custom server",
  claude_cli: "Claude",
  antigravity_cli: "Antigravity",
  codex_cli: "Codex",
};

export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known) return known;
  const words = provider.replace(/_cli$/, "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Provider";
}
