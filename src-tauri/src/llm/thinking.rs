// How much a model "thinks" before answering, per LLM provider.
//
// The user picks Auto / Off / Low / High for each provider. Auto sends nothing
// (the provider's own default, exactly as before). Everything else is mapped
// here to each API's own parameter. A model that doesn't know the parameter
// answers HTTP 400; `send_with_fallback` then retries once without it and
// remembers that for the rest of the session.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};

use super::provider::{cancellable, GenerationParams, LLMError, LLMMessage};

/// The user's choice for one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingSetting {
    /// Send nothing: the provider's default.
    #[default]
    Auto,
    Off,
    Low,
    High,
}

impl ThinkingSetting {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
            Self::Low => "low",
            Self::High => "high",
        }
    }

    /// Lenient: anything unknown is Auto, so a damaged saved value never breaks a request.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Self::Off,
            "low" => Self::Low,
            "high" => Self::High,
            _ => Self::Auto,
        }
    }

    pub fn is_auto(&self) -> bool {
        *self == Self::Auto
    }
}

impl Serialize for ThinkingSetting {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ThinkingSetting {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // Null and non-strings load as Auto too.
        Ok(match Option::<Value>::deserialize(d)? {
            Some(Value::String(s)) => Self::parse(&s),
            _ => Self::Auto,
        })
    }
}

/// What the user configured for the provider in use: thinking, and the
/// optional "Extra request JSON" (only kept for providers that offer it).
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    pub thinking: ThinkingSetting,
    /// A JSON object string merged into the request body last. Stored as
    /// given; `extra_request()` validates it, so invalid JSON is never sent.
    pub extra_json: Option<String>,
}

impl RequestOptions {
    pub fn extra_request(&self) -> Option<Map<String, Value>> {
        parse_extra_request(self.extra_json.as_deref())
    }
}

/// The thinking setting that applies to one request: an explicit one on the
/// request wins, then the provider's own; Auto stays Auto, except for the
/// background JSON tasks (action items, bookmarks), which prefer Off.
pub fn resolve(params: &GenerationParams, provider: ThinkingSetting) -> ThinkingSetting {
    if !params.thinking.is_auto() {
        params.thinking
    } else if !provider.is_auto() {
        provider
    } else if params.thinking_auto_off {
        ThinkingSetting::Off
    } else {
        ThinkingSetting::Auto
    }
}

// ── Qwen3 soft switch ───────────────────────────────────────

/// A Qwen3 hybrid model (thinks unless told `/no_think`): "qwen3" in the id,
/// but not the Instruct / Thinking-only 2507 variants, which have no switch.
pub fn is_qwen3_hybrid(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("qwen3") && !m.contains("instruct") && !m.contains("thinking")
}

/// With thinking Off on a Qwen3 hybrid model, appends Qwen's documented
/// `/no_think` soft switch to the system prompt (else the last user message).
pub fn apply_prompt_hint(messages: &mut [LLMMessage], model: &str, effective: ThinkingSetting) {
    if effective != ThinkingSetting::Off || !is_qwen3_hybrid(model) {
        return;
    }
    let target = messages
        .iter()
        .position(|m| m.role == "system")
        .or_else(|| messages.iter().rposition(|m| m.role == "user"));
    if let Some(i) = target {
        if !messages[i].content.contains("/no_think") {
            messages[i].content.push_str("\n/no_think");
        }
    }
}

// ── Extra request JSON ──────────────────────────────────────

/// Keys the user can never override.
pub const PROTECTED_KEYS: [&str; 3] = ["model", "messages", "stream"];

/// The object in `raw`; `None` when it is empty, not valid JSON, or not an object.
pub fn parse_extra_request(raw: Option<&str>) -> Option<Map<String, Value>> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Some(map),
        _ => {
            log::warn!("LLM extra request JSON is not a JSON object; ignored");
            None
        }
    }
}

/// Shallow-merges `extra` into `body` (its keys win), skipping `PROTECTED_KEYS`.
/// With `merge_options` (Ollama), an `options` object is merged key by key into
/// the existing `options` instead of replacing it.
pub fn merge_extra_request(body: &mut Value, extra: &Map<String, Value>, merge_options: bool) {
    let Some(target) = body.as_object_mut() else { return };
    for (key, value) in extra {
        if PROTECTED_KEYS.contains(&key.as_str()) {
            continue;
        }
        if merge_options && key == "options" {
            if let (Some(add), Some(Value::Object(current))) = (value.as_object(), target.get_mut("options")) {
                for (k, v) in add {
                    current.insert(k.clone(), v.clone());
                }
                continue;
            }
        }
        target.insert(key.clone(), value.clone());
    }
}

// ── Per-provider request fields ─────────────────────────────

/// Ollama `/api/chat` top-level `think`. gpt-oss only takes levels (and can't
/// be switched off): "low" / "high"; every other model takes true / false.
pub fn ollama_think(model: &str, setting: ThinkingSetting) -> Option<Value> {
    let gpt_oss = model.to_ascii_lowercase().contains("gpt-oss");
    match setting {
        ThinkingSetting::Auto => None,
        ThinkingSetting::Off => Some(if gpt_oss { json!("low") } else { json!(false) }),
        ThinkingSetting::Low => Some(if gpt_oss { json!("low") } else { json!(true) }),
        ThinkingSetting::High => Some(if gpt_oss { json!("high") } else { json!(true) }),
    }
}

/// `reasoning_effort` meaning "no thinking" for `model`: OpenAI's gpt-5.x take
/// "none", the first gpt-5 line "minimal", o-series and gpt-oss can't be turned
/// off ("low"); everything else (Groq's qwen3, Ollama-compatible servers) "none".
fn off_effort(model: &str) -> &'static str {
    let m = model.to_ascii_lowercase();
    let o_series = ["o1", "o3", "o4"].iter().any(|p| m.starts_with(p));
    if m.contains("gpt-oss") || o_series {
        "low"
    } else if m.contains("gpt-5.") {
        "none"
    } else if m.contains("gpt-5") {
        "minimal"
    } else {
        "none"
    }
}

/// OpenAI-compatible `/chat/completions` (OpenAI, Groq, LM Studio, custom):
/// `reasoning_effort`. OpenRouter has its own unified `reasoning` object.
/// Returns whether anything was added.
pub fn apply_openai_compat(body: &mut Value, provider: &str, model: &str, setting: ThinkingSetting) -> bool {
    if setting.is_auto() {
        return false;
    }
    if provider == "openrouter" {
        body["reasoning"] = match setting {
            ThinkingSetting::Off => json!({ "enabled": false }),
            ThinkingSetting::Low => json!({ "effort": "low" }),
            _ => json!({ "effort": "high" }),
        };
    } else {
        body["reasoning_effort"] = json!(match setting {
            ThinkingSetting::Off => off_effort(model),
            ThinkingSetting::Low => "low",
            _ => "high",
        });
    }
    true
}

/// Gemini `generationConfig.thinkingConfig`. Gemini 3 takes `thinkingLevel`
/// (Pro can't go below "low"); 2.5 takes `thinkingBudget` (0 = off, except
/// Pro, whose minimum is 128). Returns whether anything was added.
pub fn apply_gemini(gen_config: &mut Value, model: &str, setting: ThinkingSetting) -> bool {
    if setting.is_auto() {
        return false;
    }
    let m = model.to_ascii_lowercase();
    let pro = m.contains("pro");
    let config = if m.contains("gemini-3") {
        let level = match setting {
            ThinkingSetting::Off => if pro { "low" } else { "minimal" },
            ThinkingSetting::Low => "low",
            _ => "high",
        };
        json!({ "thinkingLevel": level })
    } else {
        let budget: i64 = match setting {
            ThinkingSetting::Off => if pro { 128 } else { 0 },
            ThinkingSetting::Low => 1024,
            _ => if pro { 32768 } else { 24576 },
        };
        json!({ "thinkingBudget": budget })
    };
    gen_config["thinkingConfig"] = config;
    true
}

/// Anthropic Messages API: adaptive thinking plus `output_config.effort`.
/// Only the models that take them (Opus 4.6 and later, Sonnet 4.6 / 5 / 5.5,
/// Haiku 5.x, Fable, Mythos): older ones don't think unless given a token
/// budget, so nothing is sent. Off: Sonnet 5.5 can't send `disabled` (400), so
/// `between_tools`; Opus 5.5 and Fable / Mythos think always, so the lowest
/// effort; the rest take `disabled`. Returns whether anything was added.
pub fn apply_anthropic(body: &mut Value, model: &str, setting: ThinkingSetting) -> bool {
    const ADAPTIVE: [&str; 9] = [
        "sonnet-5", "opus-5", "haiku-5", "fable", "mythos", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-4-6",
    ];
    let m = model.to_ascii_lowercase();
    if setting.is_auto() || !ADAPTIVE.iter().any(|p| m.contains(p)) {
        return false;
    }
    match setting {
        ThinkingSetting::Off if m.contains("sonnet-5-5") => {
            body["thinking"] = json!({ "type": "between_tools" });
        }
        ThinkingSetting::Off if m.contains("opus-5-5") || m.contains("fable") || m.contains("mythos") => {
            body["output_config"] = json!({ "effort": "low" });
        }
        ThinkingSetting::Off => {
            body["thinking"] = json!({ "type": "disabled" });
        }
        _ => {
            let effort = if setting == ThinkingSetting::Low { "low" } else { "high" };
            body["thinking"] = json!({ "type": "adaptive" });
            body["output_config"] = json!({ "effort": effort });
        }
    }
    true
}

// ── Fallback when a model doesn't know the parameter ────────

fn unsupported() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// One entry per provider label, endpoint (base URL) and model: a new URL
/// for Custom / Ollama / LM Studio is a different server and starts clean.
fn key(provider: &str, endpoint: &str, model: &str) -> String {
    format!("{}\u{1}{}\u{1}{}", provider, endpoint.trim_end_matches('/'), model)
}

/// True once this provider, endpoint and model rejected the thinking parameter this session.
pub fn is_known_unsupported(provider: &str, endpoint: &str, model: &str) -> bool {
    unsupported().lock().map(|s| s.contains(&key(provider, endpoint, model))).unwrap_or(false)
}

pub fn remember_unsupported(provider: &str, endpoint: &str, model: &str) {
    if let Ok(mut s) = unsupported().lock() {
        s.insert(key(provider, endpoint, model));
    }
}

/// Whether the thinking parameter should be built into this request at all.
pub fn should_send(provider: &str, endpoint: &str, model: &str, setting: ThinkingSetting) -> bool {
    !setting.is_auto() && !is_known_unsupported(provider, endpoint, model)
}

/// Words a 400 names when it refuses a thinking parameter.
const PARAM_MARKERS: [&str; 6] = ["think", "reasoning", "effort", "output_config", "budget", "adaptive"];

/// The retry decision: HTTP 400 whose body mentions the thinking parameter.
pub fn rejects_thinking_param(status: u16, body: &str) -> bool {
    if status != 400 {
        return false;
    }
    let body = body.to_ascii_lowercase();
    PARAM_MARKERS.iter().any(|m| body.contains(m))
}

/// A response: successful (stream it), or failed with its status and body.
pub enum Sent {
    Ok(reqwest::Response),
    Failed { status: reqwest::StatusCode, body: String },
}

/// Sends the request via `send(with_thinking)`. When `thinking_sent` and the
/// answer is a 400 that rejects the parameter, remembers that for
/// `provider`+`endpoint`+`model` and sends once more without it.
pub async fn send_with_fallback<F, Fut>(
    provider: &str,
    endpoint: &str,
    model: &str,
    thinking_sent: bool,
    params: &GenerationParams,
    mut send: F,
) -> Result<Sent, LLMError>
where
    F: FnMut(bool) -> Fut,
    Fut: Future<Output = Result<reqwest::Response, LLMError>>,
{
    let first = send(thinking_sent).await?;
    if first.status().is_success() {
        return Ok(Sent::Ok(first));
    }
    let status = first.status();
    let body = cancellable(params, first.text()).await?.unwrap_or_default();
    if thinking_sent && rejects_thinking_param(status.as_u16(), &body) {
        log::warn!("{}/{} rejected the thinking parameter; retrying without it", provider, model);
        remember_unsupported(provider, endpoint, model);
        let second = send(false).await?;
        if second.status().is_success() {
            return Ok(Sent::Ok(second));
        }
        let status = second.status();
        let body = cancellable(params, second.text()).await?.unwrap_or_default();
        return Ok(Sent::Failed { status, body });
    }
    Ok(Sent::Failed { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ThinkingSetting::*;

    fn msgs() -> Vec<LLMMessage> {
        vec![
            LLMMessage { role: "system".into(), content: "Be brief.".into() },
            LLMMessage { role: "user".into(), content: "hi".into() },
        ]
    }

    #[test]
    fn setting_parses_leniently_and_defaults_to_auto() {
        assert_eq!(serde_json::from_str::<ThinkingSetting>("\"off\"").unwrap(), Off);
        assert_eq!(serde_json::from_str::<ThinkingSetting>("\"HIGH\"").unwrap(), High);
        assert_eq!(serde_json::from_str::<ThinkingSetting>("\"bogus\"").unwrap(), Auto);
        assert_eq!(serde_json::from_str::<ThinkingSetting>("null").unwrap(), Auto);
        assert_eq!(serde_json::from_str::<ThinkingSetting>("3").unwrap(), Auto);
        assert_eq!(serde_json::to_string(&Low).unwrap(), "\"low\"");
    }

    #[test]
    fn resolve_order_is_request_then_provider_then_background_off() {
        let plain = GenerationParams::default();
        assert_eq!(resolve(&plain, Auto), Auto);
        assert_eq!(resolve(&plain, High), High);
        let background = GenerationParams { thinking_auto_off: true, ..Default::default() };
        assert_eq!(resolve(&background, Auto), Off);
        // An explicit user setting wins over the background preference.
        assert_eq!(resolve(&background, High), High);
        assert_eq!(resolve(&background, Low), Low);
        let explicit = GenerationParams { thinking: Low, thinking_auto_off: true, ..Default::default() };
        assert_eq!(resolve(&explicit, High), Low);
    }

    #[test]
    fn qwen3_hint_only_for_hybrid_models_when_off() {
        assert!(is_qwen3_hybrid("qwen3:8b"));
        assert!(is_qwen3_hybrid("Qwen/Qwen3-32B"));
        assert!(!is_qwen3_hybrid("qwen3-30b-a3b-instruct-2507"));
        assert!(!is_qwen3_hybrid("qwen3-4b-thinking-2507"));
        assert!(!is_qwen3_hybrid("qwen2.5:7b"));

        let mut m = msgs();
        apply_prompt_hint(&mut m, "qwen3:8b", Off);
        assert_eq!(m[0].content, "Be brief.\n/no_think");
        assert_eq!(m[1].content, "hi");
        // Twice does not stack.
        apply_prompt_hint(&mut m, "qwen3:8b", Off);
        assert_eq!(m[0].content, "Be brief.\n/no_think");

        for setting in [Auto, Low, High] {
            let mut m = msgs();
            apply_prompt_hint(&mut m, "qwen3:8b", setting);
            assert_eq!(m[0].content, "Be brief.");
        }
        let mut other = msgs();
        apply_prompt_hint(&mut other, "llama3.2", Off);
        assert_eq!(other[0].content, "Be brief.");

        // No system message: the last user message carries it.
        let mut user_only = vec![LLMMessage { role: "user".into(), content: "q".into() }];
        apply_prompt_hint(&mut user_only, "qwen3:8b", Off);
        assert_eq!(user_only[0].content, "q\n/no_think");
    }

    #[test]
    fn extra_request_must_be_a_json_object() {
        assert!(parse_extra_request(None).is_none());
        assert!(parse_extra_request(Some("  ")).is_none());
        assert!(parse_extra_request(Some("{bad")).is_none());
        assert!(parse_extra_request(Some("[1,2]")).is_none());
        assert_eq!(parse_extra_request(Some(r#"{"top_p":0.5}"#)).unwrap()["top_p"], 0.5);
    }

    #[test]
    fn extra_request_merges_last_and_never_touches_protected_keys() {
        let mut body = json!({ "model": "m", "messages": [1], "stream": true, "think": false, "temperature": 0.2 });
        let extra = parse_extra_request(Some(
            r#"{"model":"evil","messages":[],"stream":false,"think":true,"top_p":0.9}"#,
        ))
        .unwrap();
        merge_extra_request(&mut body, &extra, false);
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"], json!([1]));
        assert_eq!(body["stream"], true);
        assert_eq!(body["think"], true, "the user's JSON wins over what NexQ built");
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["temperature"], 0.2);
    }

    #[test]
    fn extra_request_options_merge_for_ollama_only() {
        let extra = parse_extra_request(Some(r#"{"options":{"num_ctx":8192,"temperature":0.7}}"#)).unwrap();
        let mut ollama = json!({ "options": { "temperature": 0.2, "num_predict": 50 } });
        merge_extra_request(&mut ollama, &extra, true);
        assert_eq!(ollama["options"], json!({ "temperature": 0.7, "num_predict": 50, "num_ctx": 8192 }));
        let mut ollama_without = json!({ "model": "m" });
        merge_extra_request(&mut ollama_without, &extra, true);
        assert_eq!(ollama_without["options"]["num_ctx"], 8192);
        let mut other = json!({ "options": { "temperature": 0.2 } });
        merge_extra_request(&mut other, &extra, false);
        assert_eq!(other["options"], json!({ "num_ctx": 8192, "temperature": 0.7 }));
        assert_eq!(other["options"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn ollama_think_values() {
        assert_eq!(ollama_think("qwen3:8b", Auto), None);
        assert_eq!(ollama_think("qwen3:8b", Off), Some(json!(false)));
        assert_eq!(ollama_think("qwen3:8b", Low), Some(json!(true)));
        assert_eq!(ollama_think("qwen3:8b", High), Some(json!(true)));
        assert_eq!(ollama_think("gpt-oss:20b", Off), Some(json!("low")));
        assert_eq!(ollama_think("gpt-oss:20b", Low), Some(json!("low")));
        assert_eq!(ollama_think("gpt-oss:20b", High), Some(json!("high")));
    }

    #[test]
    fn openai_compat_fields() {
        let mut b = json!({});
        assert!(!apply_openai_compat(&mut b, "openai", "gpt-5.1", Auto));
        assert_eq!(b, json!({}), "Auto sends nothing");
        let cases = [
            ("openai", "gpt-5.1", Off, "none"),
            ("openai", "gpt-5-mini", Off, "minimal"),
            ("openai", "o3", Off, "low"),
            ("groq", "qwen/qwen3-32b", Off, "none"),
            ("groq", "openai/gpt-oss-20b", Off, "low"),
            ("lm_studio", "qwen3-8b", Off, "none"),
            ("custom", "x", Low, "low"),
            ("openai", "gpt-5", High, "high"),
        ];
        for (provider, model, setting, want) in cases {
            let mut b = json!({});
            assert!(apply_openai_compat(&mut b, provider, model, setting));
            assert_eq!(b["reasoning_effort"], want, "{provider} {model} {setting:?}");
            assert!(b.get("reasoning").is_none());
        }
    }

    #[test]
    fn openrouter_uses_the_reasoning_object() {
        let mut b = json!({});
        apply_openai_compat(&mut b, "openrouter", "qwen/qwen3-32b", Off);
        assert_eq!(b, json!({ "reasoning": { "enabled": false } }));
        let mut b = json!({});
        apply_openai_compat(&mut b, "openrouter", "x", Low);
        assert_eq!(b, json!({ "reasoning": { "effort": "low" } }));
        let mut b = json!({});
        apply_openai_compat(&mut b, "openrouter", "x", High);
        assert_eq!(b, json!({ "reasoning": { "effort": "high" } }));
        let mut b = json!({});
        assert!(!apply_openai_compat(&mut b, "openrouter", "x", Auto));
        assert_eq!(b, json!({}));
    }

    #[test]
    fn gemini_thinking_config() {
        let cfg = |model: &str, s| {
            let mut g = json!({ "maxOutputTokens": 10 });
            let sent = apply_gemini(&mut g, model, s);
            (sent, g)
        };
        let (sent, g) = cfg("gemini-2.5-flash", Auto);
        assert!(!sent);
        assert_eq!(g, json!({ "maxOutputTokens": 10 }));
        assert_eq!(cfg("gemini-2.5-flash", Off).1["thinkingConfig"], json!({ "thinkingBudget": 0 }));
        assert_eq!(cfg("gemini-2.5-pro", Off).1["thinkingConfig"], json!({ "thinkingBudget": 128 }));
        assert_eq!(cfg("gemini-2.5-flash", Low).1["thinkingConfig"], json!({ "thinkingBudget": 1024 }));
        assert_eq!(cfg("gemini-2.5-flash", High).1["thinkingConfig"], json!({ "thinkingBudget": 24576 }));
        assert_eq!(cfg("gemini-3-flash-preview", Off).1["thinkingConfig"], json!({ "thinkingLevel": "minimal" }));
        assert_eq!(cfg("gemini-3-pro-preview", Off).1["thinkingConfig"], json!({ "thinkingLevel": "low" }));
        assert_eq!(cfg("gemini-3-pro-preview", Low).1["thinkingConfig"], json!({ "thinkingLevel": "low" }));
        assert_eq!(cfg("gemini-3-pro-preview", High).1["thinkingConfig"], json!({ "thinkingLevel": "high" }));
        assert_eq!(cfg("gemini-3-pro-preview", High).1["maxOutputTokens"], 10);
    }

    #[test]
    fn anthropic_fields() {
        let run = |model: &str, s| {
            let mut b = json!({ "model": model });
            let sent = apply_anthropic(&mut b, model, s);
            (sent, b)
        };
        let (sent, b) = run("claude-sonnet-5-5", Auto);
        assert!(!sent);
        assert_eq!(b, json!({ "model": "claude-sonnet-5-5" }));
        assert_eq!(run("claude-sonnet-5-5", Off).1["thinking"], json!({ "type": "between_tools" }));
        assert_eq!(run("claude-opus-5-5", Off).1["output_config"], json!({ "effort": "low" }));
        assert!(run("claude-opus-5-5", Off).1.get("thinking").is_none());
        assert_eq!(run("claude-fable-5-2", Off).1["output_config"], json!({ "effort": "low" }));
        assert_eq!(run("claude-opus-4-8", Off).1["thinking"], json!({ "type": "disabled" }));
        assert_eq!(run("claude-haiku-5-5", Off).1["thinking"], json!({ "type": "disabled" }));
        for old in ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"] {
            for s in [Off, Low, High] {
                assert!(!run(old, s).0, "{old} doesn't think unless given a budget");
            }
        }
        for (s, effort) in [(Low, "low"), (High, "high")] {
            let (sent, b) = run("claude-sonnet-5-5", s);
            assert!(sent);
            assert_eq!(b["thinking"], json!({ "type": "adaptive" }));
            assert_eq!(b["output_config"], json!({ "effort": effort }));
        }
    }

    #[test]
    fn retry_decision_needs_a_400_naming_the_parameter() {
        assert!(rejects_thinking_param(400, r#"{"error":"\"llama3.2\" does not support thinking"}"#));
        assert!(rejects_thinking_param(400, r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#));
        assert!(rejects_thinking_param(400, "Unknown name \"thinkingConfig\": Cannot find field."));
        assert!(rejects_thinking_param(400, r#"{"error":{"message":"output_config.effort: Extra inputs are not permitted"}}"#));
        assert!(!rejects_thinking_param(400, r#"{"error":"context length exceeded"}"#));
        assert!(!rejects_thinking_param(401, "invalid reasoning key"));
        assert!(!rejects_thinking_param(500, "thinking failed"));
        assert!(!rejects_thinking_param(404, "model not found"));
    }

    #[test]
    fn unsupported_is_remembered_per_provider_and_model() {
        let url = "http://a:1/v1";
        assert!(should_send("p-test", url, "m1", Off));
        assert!(!should_send("p-test", url, "m1", Auto));
        remember_unsupported("p-test", url, "m1");
        assert!(!should_send("p-test", url, "m1", Off));
        assert!(!should_send("p-test", "http://a:1/v1/", "m1", Off), "a trailing slash is the same endpoint");
        assert!(should_send("p-test", url, "m2", Off));
        assert!(should_send("p-other", url, "m1", Off));
    }

    #[test]
    fn a_different_endpoint_with_the_same_model_is_not_suppressed() {
        remember_unsupported("custom-ep", "http://old-server:8080/v1", "qwen3");
        assert!(!should_send("custom-ep", "http://old-server:8080/v1", "qwen3", Off));
        assert!(should_send("custom-ep", "http://new-server:9090/v1", "qwen3", Off));
        assert!(!is_known_unsupported("custom-ep", "http://new-server:9090/v1", "qwen3"));
    }

    // ── send_with_fallback against a local server ───────────

    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A server answering 400 `reject_body` to any request whose body contains
    /// "reasoning_effort", else 200 / 400 `other_error`. Records each request body.
    async fn server(reject_body: &'static str, always_fail: bool) -> (String, Arc<StdMutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let seen: Arc<StdMutex<Vec<String>>> = Arc::default();
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (mut raw, mut buf) = (Vec::new(), [0u8; 4096]);
                let head_end = loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break None;
                    }
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(i + 4);
                    }
                };
                let Some(head_end) = head_end else { continue };
                let head = String::from_utf8_lossy(&raw[..head_end]).to_lowercase();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                    .unwrap_or(0);
                while raw.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let body = String::from_utf8_lossy(&raw[head_end..]).to_string();
                let rejected = always_fail || body.contains("reasoning_effort");
                log.lock().unwrap().push(body);
                let (status, text) = if rejected { (400, reject_body) } else { (200, "ok") };
                let resp = format!(
                    "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    text.len(),
                    text
                );
                socket.write_all(resp.as_bytes()).await.unwrap();
                let _ = socket.shutdown().await;
            }
        });
        (url, seen)
    }

    async fn post(url: &str, with_thinking: bool) -> Result<reqwest::Response, LLMError> {
        let mut body = json!({ "model": "m" });
        if with_thinking {
            body["reasoning_effort"] = json!("none");
        }
        Ok(reqwest::Client::new().post(url).json(&body).send().await?)
    }

    #[tokio::test]
    async fn a_rejected_parameter_is_retried_once_without_it_and_remembered() {
        let (url, seen) = server(r#"{"error":"Unrecognized request argument supplied: reasoning_effort"}"#, false).await;
        let params = GenerationParams::default();
        let sent = send_with_fallback("retry-prov", &url, "retry-model", true, &params, |t| post(&url, t))
            .await
            .unwrap();
        assert!(matches!(sent, Sent::Ok(_)));
        let bodies = seen.lock().unwrap().clone();
        assert_eq!(bodies.len(), 2);
        assert!(bodies[0].contains("reasoning_effort"));
        assert!(!bodies[1].contains("reasoning_effort"));
        assert!(is_known_unsupported("retry-prov", &url, "retry-model"));
        // The next request builds no thinking parameter at all.
        assert!(!should_send("retry-prov", &url, "retry-model", Off));
    }

    #[tokio::test]
    async fn an_unrelated_400_is_not_retried() {
        let (url, seen) = server(r#"{"error":"context length exceeded"}"#, true).await;
        let params = GenerationParams::default();
        let sent = send_with_fallback("retry-prov2", &url, "retry-model2", true, &params, |t| post(&url, t))
            .await
            .unwrap();
        match sent {
            Sent::Failed { status, body } => {
                assert_eq!(status.as_u16(), 400);
                assert!(body.contains("context length"));
            }
            Sent::Ok(_) => panic!("expected a failure"),
        }
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(!is_known_unsupported("retry-prov2", &url, "retry-model2"));
    }

    #[tokio::test]
    async fn nothing_is_retried_when_no_thinking_parameter_was_sent() {
        let (url, seen) = server(r#"{"error":"bad reasoning_effort"}"#, true).await;
        let params = GenerationParams::default();
        let sent = send_with_fallback("retry-prov3", &url, "retry-model3", false, &params, |t| post(&url, t))
            .await
            .unwrap();
        assert!(matches!(sent, Sent::Failed { .. }));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
