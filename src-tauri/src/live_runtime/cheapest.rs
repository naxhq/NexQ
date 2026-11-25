//! "Automatic" model choice: the cheapest model that is good enough for notes,
//! the brief, memory and recaps. One place, one rule per kind of provider, and
//! the label the UI shows before anything is turned on.
//!
//! * subscriptions (Claude, Antigravity, Codex): the CLI's own fast tier;
//! * API providers: the first small model of a per-provider table that the
//!   provider's available model list contains, else the active model;
//! * local servers and custom endpoints: the active model.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheapestChoice {
    pub provider: String,
    /// Empty: the provider's own fast tier (subscriptions).
    pub model: String,
    pub effort: Option<String>,
    /// What to show: "OpenAI · gpt-5-nano (cheapest)".
    pub label: String,
}

pub struct CheapestInput<'a> {
    pub provider: &'a str,
    pub active_model: &'a str,
    /// The provider's available models, when known (may be empty).
    pub available: &'a [String],
    /// A subscription's fast tier: (model, effort), when the provider is one.
    pub cli_fast: Option<(&'a str, &'a str)>,
}

/// Small models, best (cheapest and still good at structured output) first.
fn small_models(provider: &str) -> &'static [&'static str] {
    match provider {
        "openai" => &["gpt-5-nano", "gpt-5-mini", "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o-mini"],
        "anthropic" => &["haiku"],
        "gemini" => &["flash-lite", "flash"],
        "groq" => &["llama-3.1-8b-instant", "8b", "instant"],
        "openrouter" => &["haiku", "nano", "flash-lite", "mini", "flash", "8b"],
        _ => &[],
    }
}

fn pretty(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "gemini" => "Google Gemini",
        "groq" => "Groq",
        "openrouter" => "OpenRouter",
        "ollama" => "Ollama",
        "lm_studio" => "LM Studio",
        "custom" => "Custom",
        "claude_cli" => "Claude (subscription)",
        "antigravity_cli" => "Antigravity (subscription)",
        "codex_cli" => "Codex (subscription)",
        _ => "Provider",
    }
}

pub fn cheapest(i: &CheapestInput<'_>) -> CheapestChoice {
    let name = pretty(i.provider);
    if matches!(i.provider, "claude_cli" | "antigravity_cli" | "codex_cli") {
        let (model, effort) = i.cli_fast.unwrap_or(("", ""));
        let shown = if model.is_empty() { "fast tier".to_string() } else { format!("{model}, fast tier") };
        return CheapestChoice {
            provider: i.provider.to_string(),
            model: String::new(),
            effort: Some(effort.to_string()).filter(|e| !e.is_empty()),
            label: format!("{name} · {shown}"),
        };
    }
    let table = small_models(i.provider);
    if !table.is_empty() && !i.available.is_empty() {
        for pref in table {
            // newest of the matches: the greatest name
            if let Some(m) = i.available.iter().filter(|a| a.to_lowercase().contains(pref)).max() {
                return CheapestChoice { provider: i.provider.to_string(), model: m.clone(), effort: None, label: format!("{name} · {m} (cheapest)") };
            }
        }
    }
    let active = i.active_model.to_string();
    let label = if active.is_empty() { format!("{name} · active model") } else { format!("{name} · {active} (active model)") };
    CheapestChoice { provider: i.provider.to_string(), model: active, effort: None, label }
}

/// The label of an explicit choice.
pub fn explicit_label(provider: &str, model: &str) -> String {
    if model.is_empty() {
        format!("{} · default", pretty(provider))
    } else {
        format!("{} · {model}", pretty(provider))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(provider: &str, active: &str, available: &[&str]) -> CheapestChoice {
        let av: Vec<String> = available.iter().map(|s| s.to_string()).collect();
        cheapest(&CheapestInput { provider, active_model: active, available: &av, cli_fast: None })
    }

    #[test]
    fn api_providers_take_the_first_small_model_the_provider_really_has() {
        let c = pick("openai", "gpt-5", &["gpt-5", "gpt-5-mini", "gpt-4o-mini", "o3"]);
        assert_eq!(c.model, "gpt-5-mini", "nano is not offered, mini is");
        assert!(c.label.contains("cheapest") && c.label.starts_with("OpenAI"));
        assert_eq!(pick("openai", "gpt-5", &["gpt-5-nano", "gpt-5-mini"]).model, "gpt-5-nano");
        assert_eq!(pick("anthropic", "claude-sonnet-4", &["claude-sonnet-4", "claude-haiku-4-5"]).model, "claude-haiku-4-5");
        assert_eq!(pick("gemini", "gemini-2.5-pro", &["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]).model, "gemini-2.5-flash-lite");
        assert_eq!(pick("groq", "llama-3.3-70b", &["llama-3.3-70b", "llama-3.1-8b-instant"]).model, "llama-3.1-8b-instant");
    }

    #[test]
    fn without_a_list_or_a_match_the_active_model_is_used_and_said_so() {
        let c = pick("openai", "gpt-5", &[]);
        assert_eq!((c.model.as_str(), c.label.as_str()), ("gpt-5", "OpenAI · gpt-5 (active model)"));
        assert_eq!(pick("openai", "gpt-5", &["o3", "gpt-5"]).model, "gpt-5");
        // local servers and custom endpoints: always the active model
        assert_eq!(pick("ollama", "llama3.2:3b", &["llama3.2:3b", "mini-thing"]).model, "llama3.2:3b");
        assert_eq!(pick("lm_studio", "qwen", &[]).model, "qwen");
        assert_eq!(pick("custom", "x", &["a-mini"]).model, "x");
    }

    #[test]
    fn subscriptions_use_their_fast_tier() {
        let c = cheapest(&CheapestInput { provider: "claude_cli", active_model: "sonnet", available: &[], cli_fast: Some(("haiku", "low")) });
        assert_eq!((c.model.as_str(), c.effort.as_deref(), c.label.as_str()), ("", Some("low"), "Claude (subscription) · haiku, fast tier"));
        let c = cheapest(&CheapestInput { provider: "codex_cli", active_model: "", available: &[], cli_fast: Some(("", "low")) });
        assert_eq!(c.label, "Codex (subscription) · fast tier");
    }

    #[test]
    fn labels_of_explicit_choices() {
        assert_eq!(explicit_label("openai", "gpt-5"), "OpenAI · gpt-5");
        assert_eq!(explicit_label("claude_cli", ""), "Claude (subscription) · default");
    }
}
