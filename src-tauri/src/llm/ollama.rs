// Sub-PRD 5: Ollama NDJSON streaming client

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end_with_stats, emit_error, emit_token, TokenSink,
};
use super::stream_parser::{LineBuffer, NDJSONParser};
use super::thinking::{self, RequestOptions, Sent, ThinkingSetting};

/// The context size each local model was last asked for by a background run
/// (`ai_runs`), by `(server, model)`. A server reloads a model whenever the
/// `num_ctx` of a request differs from the loaded one, so live answers on the
/// same model ask for the same size once a background run has set it. Only
/// grows; reading it is one short lock (no await, no I/O), so a live answer
/// pays nothing for it.
fn shared_contexts() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), u64>> {
    static CONTEXTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), u64>>> =
        std::sync::OnceLock::new();
    CONTEXTS.get_or_init(Default::default)
}

/// A server address as the registry knows it (`http://localhost:11434`).
pub fn server_key(base_url: &str) -> String {
    let url = base_url.trim().trim_end_matches('/').to_lowercase();
    if url.is_empty() { "http://localhost:11434".to_string() } else { url }
}

/// A background run asked `model` on `base_url` for `ctx` tokens: later
/// requests on it ask for at least that.
pub fn publish_context(base_url: &str, model: &str, ctx: u64) {
    let mut map = shared_contexts().lock().unwrap();
    let slot = map.entry((server_key(base_url), model.to_string())).or_insert(0);
    *slot = (*slot).max(ctx);
}

/// What a request that names no `num_ctx` should ask for: the size a background
/// run last set on this model, if any (else nothing, as before).
pub fn shared_context(base_url: &str, model: &str) -> Option<u64> {
    shared_contexts().lock().unwrap().get(&(server_key(base_url), model.to_string())).copied()
}

/// `params` with the shared context filled in when it names none. A user's own
/// `options.num_ctx` (extra request JSON) is merged last and still wins.
pub(crate) fn with_shared_context(mut params: GenerationParams, base_url: &str, model: &str) -> GenerationParams {
    if params.num_ctx.is_none() {
        params.num_ctx = shared_context(base_url, model);
    }
    params
}

pub struct OllamaClient {
    base_url: String,
    client: reqwest::Client,
    options: RequestOptions,
}

/// The `/api/chat` request body. `with_thinking` false leaves out `think`
/// (the retry after a model refused it). Returns the body and whether `think` is in it.
pub(crate) fn build_chat_body(
    messages: &[LLMMessage],
    model: &str,
    params: &GenerationParams,
    thinking: ThinkingSetting,
    extra: Option<&serde_json::Map<String, serde_json::Value>>,
    with_thinking: bool,
) -> (serde_json::Value, bool) {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = json!({
        "model": model,
        "messages": msgs,
        "stream": true,
        // Ollama unloads idle models after 5 min by default; questions in a meeting
        // are often further apart, and reloading from disk on CPU-only machines
        // adds many seconds before the first token.
        "keep_alive": "30m"
    });

    // Apply per-request generation params via Ollama's "options" object
    let mut options = serde_json::Map::new();
    if let Some(temp) = params.temperature {
        options.insert("temperature".to_string(), json!(temp));
    }
    if let Some(max_tok) = params.max_tokens {
        options.insert("num_predict".to_string(), json!(max_tok));
    }
    // Only `ai_runs` asks for a window; live answers keep the server's own.
    if let Some(num_ctx) = params.num_ctx {
        options.insert("num_ctx".to_string(), json!(num_ctx));
    }
    if !options.is_empty() {
        body["options"] = serde_json::Value::Object(options);
    }

    let mut sent = false;
    if with_thinking {
        if let Some(think) = thinking::ollama_think(model, thinking) {
            body["think"] = think;
            sent = true;
        }
    }
    if let Some(extra) = extra {
        thinking::merge_extra_request(&mut body, extra, true);
    }
    (body, sent)
}

impl OllamaClient {
    pub fn new(base_url: Option<&str>) -> Self {
        Self {
            base_url: base_url.unwrap_or("http://localhost:11434").to_string(),
            client: reqwest::Client::new(),
            options: RequestOptions::default(),
        }
    }

    /// Applies the user's thinking setting and extra request JSON.
    pub fn with_options(mut self, options: RequestOptions) -> Self {
        self.options = options;
        self
    }
}

#[async_trait::async_trait]
impl LLMProvider for OllamaClient {
    fn provider_name(&self) -> &str {
        "ollama"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let url = format!("{}/api/tags", self.base_url);
        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(LLMError::ConnectionFailed(format!(
                "Ollama not reachable ({}): {}",
                status, body
            )));
        }

        let body: serde_json::Value = response.json().await?;

        let models = body
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let name = m.get("name")?.as_str()?.to_string();
                        let model_name = m
                            .get("model")
                            .and_then(|n| n.as_str())
                            .unwrap_or(&name)
                            .to_string();
                        Some(ModelInfo {
                            id: name.clone(),
                            name: model_name,
                            provider: "ollama".to_string(),
                            context_window: m
                                .get("details")
                                .and_then(|d| d.get("context_length"))
                                .and_then(|v| v.as_u64())
                                .or_else(|| {
                                    // Fallback: estimate from model name
                                    let name_lower = name.to_lowercase();
                                    if name_lower.contains("llama3") {
                                        Some(8192)
                                    } else if name_lower.contains("mistral")
                                        || name_lower.contains("mixtral")
                                    {
                                        Some(32768)
                                    } else if name_lower.contains("gemma") {
                                        Some(8192)
                                    } else if name_lower.contains("phi") {
                                        Some(4096)
                                    } else if name_lower.contains("qwen") {
                                        Some(32768)
                                    } else {
                                        Some(4096) // Safe default
                                    }
                                }),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        let url = format!("{}/api/tags", self.base_url);
        match self.client.get(&url).send().await {
            Ok(response) => Ok(response.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    async fn stream_completion(
        &self,
        mut messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        // Same context size as the background runs on this model: no reload between them.
        let params = with_shared_context(params, &self.base_url, model);
        let url = format!("{}/api/chat", self.base_url);
        let start = Instant::now();

        let setting = thinking::resolve(&params, self.options.thinking);
        thinking::apply_prompt_hint(&mut messages, model, setting);
        let extra = self.options.extra_request();

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let send_thinking = thinking::should_send("ollama", &self.base_url, model, setting);
        let sent = thinking::send_with_fallback("ollama", &self.base_url, model, send_thinking, &params, |with_thinking| {
            let (body, _) = build_chat_body(&messages, model, &params, setting, extra.as_ref(), with_thinking);
            let request = self
                .client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send();
            let (params, app_handle) = (&params, &app_handle);
            async move {
                cancellable(params, request).await?.map_err(|e| {
                    if is_cancelled(params) {
                        return LLMError::Cancelled;
                    }
                    emit_error(app_handle, params, &super::provider::error_text(&e));
                    LLMError::ConnectionFailed(format!("Failed to connect to Ollama: {}", e))
                })
            }
        })
        .await?;

        let response = match sent {
            Sent::Ok(response) => response,
            Sent::Failed { status, body } => {
                let err_msg = format!("Ollama completion failed ({}): {}", status, body);
                check_cancelled(&params)?;
                emit_error(&app_handle, &params, &err_msg);
                return Err(LLMError::ProviderError(err_msg));
            }
        };

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;
        let mut prompt_tokens: u64 = 0;
        let mut completion_tokens: u64 = 0;

        while let Some(chunk_result) = cancellable(&params, stream.next()).await? {
            check_cancelled(&params)?;
            let chunk = chunk_result.map_err(|e| {
                if is_cancelled(&params) {
                    return LLMError::Cancelled;
                }
                emit_error(&app_handle, &params, &super::provider::error_text(&e));
                LLMError::HttpError(e)
            })?;

            let chunk_str = String::from_utf8_lossy(&chunk);
            let lines = line_buffer.push(&chunk_str);

            for line in lines {
                let parsed = NDJSONParser::parse_chunk(&line);
                for data in parsed {
                    // Check if done
                    if NDJSONParser::is_ollama_done(&data) {
                        // Extract final token counts if available
                        if let Some(pt) = data.get("prompt_eval_count").and_then(|v| v.as_u64()) {
                            prompt_tokens = pt;
                        }
                        if let Some(ct) = data.get("eval_count").and_then(|v| v.as_u64()) {
                            completion_tokens = ct;
                        }
                        continue;
                    }

                    // Extract token
                    if let Some(token) = NDJSONParser::extract_ollama_token(&data) {
                        if !token.is_empty() {
                            token_count += 1;
                            check_cancelled(&params)?;
                            emit_token(&app_handle, &params, &token, sink.as_ref());
                        }
                    }
                }
            }
        }

        // Flush remaining buffer
        if let Some(remaining) = line_buffer.flush() {
            let parsed = NDJSONParser::parse_chunk(&remaining);
            for data in parsed {
                if NDJSONParser::is_ollama_done(&data) {
                    if let Some(pt) = data.get("prompt_eval_count").and_then(|v| v.as_u64()) {
                        prompt_tokens = pt;
                    }
                    if let Some(ct) = data.get("eval_count").and_then(|v| v.as_u64()) {
                        completion_tokens = ct;
                    }
                } else if let Some(token) = NDJSONParser::extract_ollama_token(&data) {
                    if !token.is_empty() {
                        token_count += 1;
                        check_cancelled(&params)?;
                        emit_token(&app_handle, &params, &token, sink.as_ref());
                    }
                }
            }
        }

        let latency_ms = start.elapsed().as_millis() as u64;

        // Use Ollama's reported counts if available, otherwise use our count
        if completion_tokens == 0 {
            completion_tokens = token_count;
        }

        let total = prompt_tokens + completion_tokens;
        let stats = CompletionStats {
            prompt_tokens,
            completion_tokens,
            total_tokens: total,
            latency_ms,
            ..Default::default()
        };

        check_cancelled(&params)?;
        emit_end_with_stats(&app_handle, &params, &stats);

        Ok(stats)
    }
}

#[cfg(test)]
mod thinking_tests {
    use super::*;
    use crate::llm::thinking::{parse_extra_request, ThinkingSetting::*};

    fn user() -> Vec<LLMMessage> {
        vec![LLMMessage { role: "user".into(), content: "hi".into() }]
    }

    fn body(model: &str, setting: ThinkingSetting, extra: Option<&str>, with: bool) -> (serde_json::Value, bool) {
        let extra = parse_extra_request(extra);
        let params = GenerationParams { temperature: Some(0.3), ..Default::default() };
        build_chat_body(&user(), model, &params, setting, extra.as_ref(), with)
    }

    #[test]
    fn auto_sends_no_think_field() {
        let (b, sent) = body("qwen3:8b", Auto, None, true);
        assert!(!sent);
        assert!(b.get("think").is_none());
        // Everything else is what it always was.
        assert_eq!(b["stream"], true);
        assert_eq!(b["keep_alive"], "30m");
        assert_eq!(b["options"]["temperature"], 0.3);
    }

    #[test]
    fn off_low_high_set_think() {
        assert_eq!(body("qwen3:8b", Off, None, true).0["think"], false);
        assert_eq!(body("qwen3:8b", Low, None, true).0["think"], true);
        assert_eq!(body("qwen3:8b", High, None, true).0["think"], true);
        assert_eq!(body("gpt-oss:20b", Off, None, true).0["think"], "low");
        assert_eq!(body("gpt-oss:20b", High, None, true).0["think"], "high");
    }

    #[test]
    fn the_retry_body_has_no_think() {
        let (b, sent) = body("llama3.2", Off, None, false);
        assert!(!sent);
        assert!(b.get("think").is_none());
    }

    #[test]
    fn extra_json_merges_last_with_options_merged_and_protected_keys_kept() {
        let extra = r#"{"options":{"num_ctx":8192},"think":true,"model":"x","stream":false,"messages":[]}"#;
        let (b, _) = body("qwen3:8b", Off, Some(extra), true);
        assert_eq!(b["model"], "qwen3:8b");
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["content"], "hi");
        assert_eq!(b["options"]["num_ctx"], 8192);
        assert_eq!(b["options"]["temperature"], 0.3, "options are merged, not replaced");
        assert_eq!(b["think"], true, "the user's JSON has the last word");
    }

    #[test]
    fn num_ctx_is_sent_only_when_a_run_asks_for_it() {
        let (live, _) = build_chat_body(&user(), "m", &GenerationParams::default(), ThinkingSetting::Auto, None, true);
        assert!(live.get("options").is_none(), "live answers send no options of their own");
        let params = GenerationParams { num_ctx: Some(16384), temperature: Some(0.1), ..Default::default() };
        let (b, _) = build_chat_body(&user(), "m", &params, ThinkingSetting::Auto, None, true);
        assert_eq!(b["options"]["num_ctx"], 16384);
        assert_eq!(b["options"]["temperature"], 0.1);
        // The user's own extra JSON still wins.
        let extra: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"options":{"num_ctx":4096}}"#).unwrap();
        let (b, _) = build_chat_body(&user(), "m", &params, ThinkingSetting::Auto, Some(&extra), true);
        assert_eq!(b["options"]["num_ctx"], 4096);
    }

    #[test]
    fn live_requests_follow_the_context_a_background_run_set_and_never_invent_one() {
        let base = "http://ctx-test-host:11434/";
        let plain = GenerationParams::default();
        // Nothing published: a live request is exactly as before.
        assert_eq!(with_shared_context(plain.clone(), base, "m").num_ctx, None);
        publish_context(base, "m", 16384);
        publish_context("HTTP://CTX-TEST-HOST:11434", "m", 8192); // another spelling, a smaller size
        assert_eq!(with_shared_context(plain.clone(), base, "m").num_ctx, Some(16384), "only grows");
        // Another model or server is its own.
        assert_eq!(with_shared_context(plain.clone(), base, "other").num_ctx, None);
        assert_eq!(with_shared_context(plain.clone(), "http://elsewhere:11434", "m").num_ctx, None);
        // A request that names its own size keeps it.
        let own = GenerationParams { num_ctx: Some(4096), ..Default::default() };
        assert_eq!(with_shared_context(own, base, "m").num_ctx, Some(4096));
        // The size reaches the body (and the user's extra JSON still wins over it).
        let params = with_shared_context(plain, base, "m");
        let (body, _) = build_chat_body(&user(), "m", &params, ThinkingSetting::Auto, None, true);
        assert_eq!(body["options"]["num_ctx"], 16384);
        publish_context(base, "grow", 4096);
        publish_context(base, "grow", 32768);
        assert_eq!(shared_context(base, "grow"), Some(32768));
    }
}
