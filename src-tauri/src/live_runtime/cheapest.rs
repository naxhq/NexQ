//! "Automatic" model choice: the cheapest model that is good enough for notes,
//! the brief, memory and recaps. One place, one rule per kind of provider, and
//! the label the UI shows before anything is turned on.
//!
//! * subscriptions (Claude, Antigravity, Codex): the CLI's own fast tier;
//! * API providers: the first small model of a per-provider table that the
//!   provider's available model list contains, else the active model;
//! * OpenRouter, whose list carries prices: the lowest-priced text chat model
//!   of the table that has room for the job (see [`PricedModel`]);
//! * local servers and custom endpoints: the active model.
//!
//! "Cheapest" is only said when it is true: the table's first (cheapest) model
//! for a provider, or the lowest price among every model OpenRouter lists for
//! the job. Anything else is a "small model". Every label comes from here.

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

/// One OpenRouter model with what its list says about price and fit.
#[derive(Debug, Clone, PartialEq)]
pub struct PricedModel {
    pub id: String,
    /// Dollars per prompt token and per completion token (only compared, never shown).
    pub prompt: f64,
    pub completion: f64,
    pub context: u64,
    /// Text in, text out: not an image, speech or embedding model.
    pub text_chat: bool,
    /// A free tier (`:free`, or priced at zero).
    pub free: bool,
}

/// A job needs at least this much room (a transcript outline plus its answer).
pub const MIN_CONTEXT: u64 = 32_000;

/// What the job costs on a model: notes, the brief, memory and recaps read much
/// more than they write, so the prompt price weighs four times the completion's.
pub fn job_cost(m: &PricedModel) -> f64 {
    0.8 * m.prompt + 0.2 * m.completion
}

/// The priced view of OpenRouter's own model list.
pub fn priced_from_openrouter(models: &[crate::llm::openrouter_models::OpenRouterModel]) -> Vec<PricedModel> {
    models
        .iter()
        .map(|m| {
            let text_in = m.input_modalities.is_empty() || m.input_modalities.iter().any(|x| x == "text");
            let text_out = if m.output_modalities.is_empty() { m.modality.contains("->text") } else { m.output_modalities.iter().all(|x| x == "text") };
            PricedModel {
                id: m.id.clone(),
                prompt: m.pricing.prompt,
                completion: m.pricing.completion,
                context: m.context_length.unwrap_or(0),
                text_chat: text_in && text_out,
                free: m.is_free || m.id.ends_with(":free") || (m.pricing.prompt <= 0.0 && m.pricing.completion <= 0.0),
            }
        })
        .collect()
}

#[derive(Default)]
pub struct CheapestInput<'a> {
    pub provider: &'a str,
    pub active_model: &'a str,
    /// The provider's available models, when known (may be empty).
    pub available: &'a [String],
    /// A subscription's fast tier: (model, effort), when the provider is one.
    pub cli_fast: Option<(&'a str, &'a str)>,
    /// OpenRouter's models with their prices, when known (empty otherwise).
    pub priced: &'a [PricedModel],
}

/// The label of a model picked from a list.
fn picked_label(name: &str, model: &str, cheapest: bool) -> String {
    format!("{name} · {model} ({})", if cheapest { "cheapest" } else { "small model" })
}

/// The label when the active model is used.
fn active_label(name: &str, active: &str) -> String {
    if active.is_empty() { format!("{name} · active model") } else { format!("{name} · {active} (active model)") }
}

/// OpenRouter by price: among text chat models with room for the job (free
/// ones only when the active model is free), the table's small models, lowest
/// job cost first. Called "cheapest" only when nothing eligible costs less.
fn openrouter_pick(i: &CheapestInput<'_>, name: &str) -> Option<CheapestChoice> {
    let active_free = i.priced.iter().find(|m| m.id == i.active_model).map(|m| m.free).unwrap_or_else(|| i.active_model.ends_with(":free"));
    let eligible: Vec<&PricedModel> = i
        .priced
        .iter()
        .filter(|m| m.text_chat && m.context >= MIN_CONTEXT && is_chat_model(&m.id) && (active_free || !m.free))
        .collect();
    let lowest = eligible.iter().map(|m| job_cost(m)).fold(f64::INFINITY, f64::min);
    let table = small_models("openrouter");
    let pick = eligible
        .iter()
        .filter(|m| table.iter().any(|p| m.id.to_lowercase().contains(p)))
        .min_by(|a, b| job_cost(a).total_cmp(&job_cost(b)).then_with(|| b.id.cmp(&a.id)))?;
    Some(CheapestChoice {
        provider: i.provider.to_string(),
        model: pick.id.clone(),
        effort: None,
        label: picked_label(name, &pick.id, job_cost(pick) <= lowest),
    })
}

/// Ids that are not chat models, whatever else their name says (a speech, image,
/// embedding, moderation or realtime model can be called "mini" or "flash" too).
const NOT_CHAT: [&str; 14] = [
    "tts", "audio", "image", "imagen", "embed", "moderation", "guard", "whisper", "transcribe", "realtime", "live", "search", "veo",
    "computer-use",
];

fn is_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    !NOT_CHAT.iter().any(|w| id.contains(w))
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
    if i.provider == "openrouter" && !i.priced.is_empty() {
        if let Some(choice) = openrouter_pick(i, name) {
            return choice;
        }
    }
    let table = small_models(i.provider);
    if !table.is_empty() && !i.available.is_empty() {
        for (index, pref) in table.iter().enumerate() {
            // newest of the matches: the greatest name
            if let Some(m) = i.available.iter().filter(|a| is_chat_model(a) && a.to_lowercase().contains(pref)).max() {
                // the table's first entry is its cheapest; OpenRouter without prices cannot say
                let cheapest = index == 0 && i.provider != "openrouter";
                return CheapestChoice { provider: i.provider.to_string(), model: m.clone(), effort: None, label: picked_label(name, m, cheapest) };
            }
        }
    }
    let active = i.active_model.to_string();
    let label = active_label(name, &active);
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
        cheapest(&CheapestInput { provider, active_model: active, available: &av, ..Default::default() })
    }

    #[test]
    fn api_providers_take_the_first_small_model_the_provider_really_has() {
        let c = pick("openai", "gpt-5", &["gpt-5", "gpt-5-mini", "gpt-4o-mini", "o3"]);
        assert_eq!(c.model, "gpt-5-mini", "nano is not offered, mini is");
        assert!(c.label.contains("small model") && !c.label.contains("cheapest"), "mini is not the table's cheapest: {}", c.label);
        assert!(c.label.starts_with("OpenAI"));
        assert_eq!(pick("openai", "gpt-5", &["gpt-5-nano", "gpt-5-mini"]).model, "gpt-5-nano");
        assert_eq!(pick("anthropic", "claude-sonnet-4", &["claude-sonnet-4", "claude-haiku-4-5"]).model, "claude-haiku-4-5");
        assert_eq!(pick("gemini", "gemini-2.5-pro", &["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]).model, "gemini-2.5-flash-lite");
        assert_eq!(pick("groq", "llama-3.3-70b", &["llama-3.3-70b", "llama-3.1-8b-instant"]).model, "llama-3.1-8b-instant");
    }

    #[test]
    fn speech_image_guard_and_realtime_models_are_never_the_cheapest_chat_model() {
        let noisy = pick("openai", "gpt-5", &["gpt-4o-mini-tts", "gpt-4o-mini-transcribe", "gpt-4o-mini-realtime-preview", "gpt-4o-mini-search-preview", "gpt-4o-mini", "gpt-5"]);
        assert_eq!(noisy.model, "gpt-4o-mini");
        let gemini = pick("gemini", "gemini-2.5-pro", &["gemini-2.5-flash-image", "gemini-live-2.5-flash", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash", "gemini-2.5-pro"]);
        assert_eq!(gemini.model, "gemini-2.5-flash");
        let groq = pick("groq", "llama-3.3-70b-versatile", &["llama-guard-3-8b", "whisper-large-v3", "llama-3.1-8b-instant", "llama-3.3-70b-versatile"]);
        assert_eq!(groq.model, "llama-3.1-8b-instant");
        // Only non-chat models match: the active model, said so.
        let none = pick("openai", "gpt-5", &["gpt-4o-mini-tts", "gpt-5"]);
        assert_eq!((none.model.as_str(), none.label.as_str()), ("gpt-5", "OpenAI · gpt-5 (active model)"));
    }

    #[test]
    fn each_api_provider_picks_its_own_small_model_and_the_newest_of_it() {
        assert_eq!(pick("anthropic", "claude-sonnet-5-5", &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5"]).model, "claude-haiku-5-5");
        assert_eq!(pick("openai", "gpt-5", &["gpt-5", "gpt-5-nano-2025-08-07", "gpt-5-nano"]).model, "gpt-5-nano-2025-08-07");
        assert_eq!(pick("openrouter", "openai/gpt-5", &["openai/gpt-5", "anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"]).model, "anthropic/claude-haiku-4.5");
        let c = pick("gemini", "gemini-2.5-pro", &["gemini-2.5-pro", "gemini-2.5-flash-lite"]);
        assert_eq!(c.label, "Google Gemini · gemini-2.5-flash-lite (cheapest)");
        // flash is a small model, not the cheapest the table knows
        assert_eq!(pick("gemini", "gemini-2.5-pro", &["gemini-2.5-pro", "gemini-2.5-flash"]).label, "Google Gemini · gemini-2.5-flash (small model)");
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
        let c = cheapest(&CheapestInput { provider: "claude_cli", active_model: "sonnet", cli_fast: Some(("haiku", "low")), ..Default::default() });
        assert_eq!((c.model.as_str(), c.effort.as_deref(), c.label.as_str()), ("", Some("low"), "Claude (subscription) · haiku, fast tier"));
        let c = cheapest(&CheapestInput { provider: "codex_cli", cli_fast: Some(("", "low")), ..Default::default() });
        assert_eq!(c.label, "Codex (subscription) · fast tier");
    }

    fn priced(id: &str, prompt: f64, completion: f64, context: u64) -> PricedModel {
        PricedModel { id: id.into(), prompt, completion, context, text_chat: true, free: false }
    }

    fn router(active: &str, list: &[PricedModel]) -> CheapestChoice {
        cheapest(&CheapestInput { provider: "openrouter", active_model: active, priced: list, ..Default::default() })
    }

    #[test]
    fn openrouter_picks_by_listed_price_and_says_cheapest_only_when_it_is() {
        // haiku and nano are both on the table; nano is cheaper for a job that mostly reads.
        let list = vec![
            priced("anthropic/claude-haiku-4.5", 0.000001, 0.000005, 200_000),
            priced("openai/gpt-5-nano", 0.00000005, 0.0000004, 400_000),
            priced("openai/gpt-5", 0.00000125, 0.00001, 400_000),
        ];
        let c = router("openai/gpt-5", &list);
        assert_eq!((c.model.as_str(), c.label.as_str()), ("openai/gpt-5-nano", "OpenRouter · openai/gpt-5-nano (cheapest)"));
        // A cheaper model that is not on the table exists: the pick is small, not cheapest.
        let mut with_tiny = list.clone();
        with_tiny.push(priced("acme/tiny-1b-chat", 0.00000001, 0.00000002, 64_000));
        let c = router("openai/gpt-5", &with_tiny);
        assert_eq!((c.model.as_str(), c.label.as_str()), ("openai/gpt-5-nano", "OpenRouter · openai/gpt-5-nano (small model)"));
        // The prompt price weighs more than the completion's: a cheap-to-read, dear-to-write model can still win.
        // A is cheaper to read (the job's weight) though four times dearer to write; a plain average would say B.
        let reader = vec![priced("a/mini-reader", 0.0000001, 0.0000004, 100_000), priced("b/mini-writer", 0.0000002, 0.0000001, 100_000)];
        assert_eq!(router("x", &reader).model, "a/mini-reader");
    }

    #[test]
    fn openrouter_skips_free_tiers_small_windows_and_models_that_are_not_text_chat() {
        let mut free = priced("meta/llama-8b-mini:free", 0.0, 0.0, 128_000);
        free.free = true;
        let mut image = priced("acme/mini-image", 0.00000001, 0.00000001, 128_000);
        image.text_chat = false;
        let list = vec![
            free.clone(),
            image,
            priced("acme/mini-short", 0.00000001, 0.00000001, 8_000),
            priced("google/gemini-2.5-flash", 0.0000003, 0.0000025, 1_000_000),
        ];
        let c = router("openai/gpt-5", &list);
        assert_eq!(c.model, "google/gemini-2.5-flash");
        assert!(c.label.ends_with("(cheapest)"), "the only paid text chat model with room: {}", c.label);
        // With a cheaper eligible model off the table, the pick is only a small model.
        let mut more = list.clone();
        more.push(priced("acme/chat-3b", 0.00000002, 0.00000002, 64_000));
        assert!(router("openai/gpt-5", &more).label.ends_with("(small model)"));
        // Free is fine when the user's own active model is a free one.
        let c = router("meta/llama-8b-mini:free", &list);
        assert_eq!(c.model, "meta/llama-8b-mini:free");
        // Nothing eligible on the table: the active model, said so.
        let none = router("openai/gpt-5", &[priced("openai/gpt-5", 0.00000125, 0.00001, 400_000)]);
        assert_eq!((none.model.as_str(), none.label.as_str()), ("openai/gpt-5", "OpenRouter · openai/gpt-5 (active model)"));
    }

    #[test]
    fn openrouter_without_prices_never_claims_cheapest() {
        let av: Vec<String> = ["anthropic/claude-haiku-4.5", "openai/gpt-5"].iter().map(|s| s.to_string()).collect();
        let c = cheapest(&CheapestInput { provider: "openrouter", active_model: "openai/gpt-5", available: &av, ..Default::default() });
        assert_eq!(c.label, "OpenRouter · anthropic/claude-haiku-4.5 (small model)");
    }

    #[test]
    fn the_priced_view_of_openrouters_own_list() {
        use crate::llm::openrouter_models::{OpenRouterModel, OpenRouterPricing};
        let base = |id: &str, ins: &[&str], outs: &[&str], prompt: f64| OpenRouterModel {
            id: id.into(), name: id.into(), provider_name: String::new(), description: String::new(), created: 0,
            context_length: Some(100_000), max_completion_tokens: None,
            pricing: OpenRouterPricing { prompt, completion: prompt, image: None, cache_read: None, cache_write: None },
            is_free: false, modality: String::new(),
            input_modalities: ins.iter().map(|s| s.to_string()).collect(), output_modalities: outs.iter().map(|s| s.to_string()).collect(),
            tokenizer: String::new(), supports_tools: false, supports_reasoning: false, supports_web_search: false,
        };
        let v = priced_from_openrouter(&[
            base("a/chat", &["text", "image"], &["text"], 0.000001),
            base("b/image-gen", &["text"], &["image"], 0.000001),
            base("c/free:free", &["text"], &["text"], 0.0),
        ]);
        assert!(v[0].text_chat && !v[0].free);
        assert!(!v[1].text_chat);
        assert!(v[2].free);
    }

    #[test]
    fn labels_of_explicit_choices() {
        assert_eq!(explicit_label("openai", "gpt-5"), "OpenAI · gpt-5");
        assert_eq!(explicit_label("claude_cli", ""), "Claude (subscription) · default");
    }
}
