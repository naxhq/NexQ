// Sub-PRD 5: Shared OpenAI-compatible client
// Used by: OpenAI, Groq, OpenRouter, LM Studio

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end, emit_error, emit_token, TokenSink,
};
use super::stream_parser::{LineBuffer, SSEParser};
use super::thinking::{self, RequestOptions, Sent, ThinkingSetting};

/// Configuration for an OpenAI-compatible provider instance.
#[derive(Debug, Clone)]
pub struct OpenAICompatConfig {
    /// Provider name identifier (e.g., "openai", "groq", "openrouter", "lm_studio")
    pub provider_name: String,
    /// Base URL without trailing slash (e.g., "https://api.openai.com/v1")
    pub base_url: String,
    /// Optional authorization header name (e.g., "Authorization")
    pub auth_header: Option<String>,
    /// Optional authorization header value (e.g., "Bearer sk-...")
    pub auth_value: Option<String>,
    /// Optional extra headers (e.g., for OpenRouter's HTTP-Referer)
    pub extra_headers: Vec<(String, String)>,
}

pub struct OpenAICompatClient {
    config: OpenAICompatConfig,
    client: reqwest::Client,
    options: RequestOptions,
}

/// The `/chat/completions` request body. `with_thinking` false leaves out the
/// thinking field (the retry after a model refused it). Returns the body and
/// whether a thinking field is in it.
pub(crate) fn build_chat_body(
    provider: &str,
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

    // OpenRouter: ":online" suffix enables web search grounding (via Exa) for any model.
    let model_id = if params.enable_web_search && provider == "openrouter" {
        format!("{}:online", model)
    } else {
        model.to_string()
    };

    let mut body = json!({
        "model": model_id,
        "messages": msgs,
        "stream": true
    });

    if let Some(temp) = params.temperature {
        body["temperature"] = json!(temp);
    }
    if let Some(max_tok) = params.max_tokens {
        body["max_tokens"] = json!(max_tok);
    }

    let sent = with_thinking && thinking::apply_openai_compat(&mut body, provider, model, thinking);
    if let Some(extra) = extra {
        thinking::merge_extra_request(&mut body, extra, false);
    }
    (body, sent)
}

impl OpenAICompatClient {
    pub fn new(config: OpenAICompatConfig) -> Self {
        let client = reqwest::Client::new();
        Self { config, client, options: RequestOptions::default() }
    }

    /// Applies the user's thinking setting and extra request JSON.
    pub fn with_options(mut self, options: RequestOptions) -> Self {
        self.options = options;
        self
    }

    /// Build a request with auth headers applied.
    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut builder = builder;
        if let (Some(header), Some(value)) = (&self.config.auth_header, &self.config.auth_value) {
            builder = builder.header(header.as_str(), value.as_str());
        }
        for (key, val) in &self.config.extra_headers {
            builder = builder.header(key.as_str(), val.as_str());
        }
        builder
    }
}

#[async_trait::async_trait]
impl LLMProvider for OpenAICompatClient {
    fn provider_name(&self) -> &str {
        &self.config.provider_name
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));

        let response = request.send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(LLMError::AuthError(format!(
                    "Authentication failed ({}): {}",
                    status, body
                )));
            }
            return Err(LLMError::ProviderError(format!(
                "Failed to list models ({}): {}",
                status, body
            )));
        }

        let body: serde_json::Value = response.json().await?;

        let models = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let id = m.get("id")?.as_str()?.to_string();
                        let name = m
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or_else(|| m.get("id").and_then(|i| i.as_str()).unwrap_or(""))
                            .to_string();
                        Some(ModelInfo {
                            id: id.clone(),
                            name: if name.is_empty() { id.clone() } else { name },
                            provider: self.config.provider_name.clone(),
                            context_window: m
                                .get("context_window")
                                .and_then(|c| c.as_u64())
                                .or_else(|| {
                                    m.get("context_length").and_then(|c| c.as_u64())
                                }),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        // OpenRouter's /models endpoint is public (no auth required), so use /auth/key instead
        // to actually validate the API key.
        let url = if self.config.provider_name == "openrouter" {
            format!("{}/auth/key", self.config.base_url)
        } else {
            format!("{}/models", self.config.base_url)
        };
        let request = self.apply_auth(self.client.get(&url));

        let response = request.send().await?;
        Ok(response.status().is_success())
    }

    async fn stream_completion(
        &self,
        mut messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let start = Instant::now();

        let provider = self.config.provider_name.as_str();
        let setting = thinking::resolve(&params, self.options.thinking);
        thinking::apply_prompt_hint(&mut messages, model, setting);
        let extra = self.options.extra_request();

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let send_thinking = thinking::should_send(provider, model, setting);
        let sent = thinking::send_with_fallback(provider, model, send_thinking, &params, |with_thinking| {
            let (body, _) =
                build_chat_body(provider, &messages, model, &params, setting, extra.as_ref(), with_thinking);
            let request = self
                .apply_auth(self.client.post(&url))
                .header("Content-Type", "application/json")
                .json(&body)
                .send();
            let (params, app_handle) = (&params, &app_handle);
            async move {
                cancellable(params, request).await?.map_err(|e| {
                    if is_cancelled(params) {
                        return LLMError::Cancelled;
                    }
                    emit_error(app_handle, params, &e.to_string());
                    LLMError::HttpError(e)
                })
            }
        })
        .await?;

        let response = match sent {
            Sent::Ok(response) => response,
            Sent::Failed { status, body } => {
                let err_msg = format!("Completion request failed ({}): {}", status, body);
                check_cancelled(&params)?;
                emit_error(&app_handle, &params, &err_msg);
                return Err(LLMError::ProviderError(err_msg));
            }
        };

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;

        while let Some(chunk_result) = cancellable(&params, stream.next()).await? {
            check_cancelled(&params)?;
            let chunk = chunk_result.map_err(|e| {
                if is_cancelled(&params) {
                    return LLMError::Cancelled;
                }
                emit_error(&app_handle, &params, &e.to_string());
                LLMError::HttpError(e)
            })?;

            let chunk_str = String::from_utf8_lossy(&chunk);
            let lines = line_buffer.push(&chunk_str);

            for line in lines {
                let events = SSEParser::parse_chunk(&line);
                for event in events {
                    match event {
                        Some(data) => {
                            if let Some(token) = SSEParser::extract_openai_token(&data) {
                                if !token.is_empty() {
                                    token_count += 1;
                                    check_cancelled(&params)?;
                                    emit_token(&app_handle, &params, &token, sink.as_ref());
                                }
                            }
                        }
                        None => {
                            // [DONE] signal
                        }
                    }
                }
            }
        }

        // Flush any remaining data in the buffer
        if let Some(remaining) = line_buffer.flush() {
            let events = SSEParser::parse_chunk(&remaining);
            for event in events {
                if let Some(data) = event {
                    if let Some(token) = SSEParser::extract_openai_token(&data) {
                        if !token.is_empty() {
                            token_count += 1;
                            check_cancelled(&params)?;
                            emit_token(&app_handle, &params, &token, sink.as_ref());
                        }
                    }
                }
            }
        }

        let latency_ms = start.elapsed().as_millis() as u64;
        let stats = CompletionStats {
            prompt_tokens: 0, // Not available in streaming mode for most providers
            completion_tokens: token_count,
            total_tokens: token_count,
            latency_ms,
        };

        check_cancelled(&params)?;
        emit_end(&app_handle, &params, token_count, latency_ms);

        Ok(stats)
    }
}

/// Create an OpenAI client (api.openai.com)
pub fn create_openai_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "openai".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![],
    })
}

/// Create a Groq client (api.groq.com)
pub fn create_groq_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "groq".to_string(),
        base_url: "https://api.groq.com/openai/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![],
    })
}

/// Create an OpenRouter client (openrouter.ai)
pub fn create_openrouter_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "openrouter".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![
            ("HTTP-Referer".to_string(), "https://nexq.app".to_string()),
            ("X-Title".to_string(), "NexQ".to_string()),
        ],
    })
}

/// Create an LM Studio client (localhost)
pub fn create_lm_studio_client(base_url: Option<&str>) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "lm_studio".to_string(),
        base_url: base_url
            .unwrap_or("http://localhost:1234/v1")
            .to_string(),
        auth_header: None,
        auth_value: None,
        extra_headers: vec![],
    })
}

#[cfg(test)]
mod thinking_tests {
    use super::*;
    use crate::llm::thinking::{parse_extra_request, ThinkingSetting::*};

    fn user() -> Vec<LLMMessage> {
        vec![LLMMessage { role: "user".into(), content: "hi".into() }]
    }

    fn body(provider: &str, model: &str, setting: ThinkingSetting) -> serde_json::Value {
        let params = GenerationParams { temperature: Some(0.3), max_tokens: Some(50), ..Default::default() };
        build_chat_body(provider, &user(), model, &params, setting, None, true).0
    }

    #[test]
    fn auto_sends_nothing_extra() {
        for provider in ["openai", "groq", "lm_studio", "openrouter"] {
            let b = body(provider, "some-model", Auto);
            assert!(b.get("reasoning_effort").is_none(), "{provider}");
            assert!(b.get("reasoning").is_none(), "{provider}");
            assert_eq!(b["temperature"], 0.3);
            assert_eq!(b["max_tokens"], 50);
            assert_eq!(b["stream"], true);
        }
    }

    #[test]
    fn off_low_high_use_reasoning_effort() {
        assert_eq!(body("openai", "gpt-5.1", Off)["reasoning_effort"], "none");
        assert_eq!(body("openai", "gpt-5-mini", Off)["reasoning_effort"], "minimal");
        assert_eq!(body("groq", "qwen/qwen3-32b", Off)["reasoning_effort"], "none");
        assert_eq!(body("lm_studio", "qwen3-8b", Low)["reasoning_effort"], "low");
        assert_eq!(body("openai", "gpt-5", High)["reasoning_effort"], "high");
    }

    #[test]
    fn openrouter_uses_reasoning_object_and_keeps_online_suffix() {
        assert_eq!(body("openrouter", "m", Off)["reasoning"], serde_json::json!({ "enabled": false }));
        assert_eq!(body("openrouter", "m", Low)["reasoning"], serde_json::json!({ "effort": "low" }));
        assert_eq!(body("openrouter", "m", High)["reasoning"], serde_json::json!({ "effort": "high" }));
        assert!(body("openrouter", "m", High).get("reasoning_effort").is_none());
        let params = GenerationParams { enable_web_search: true, ..Default::default() };
        let (b, _) = build_chat_body("openrouter", &user(), "m", &params, Off, None, true);
        assert_eq!(b["model"], "m:online");
    }

    #[test]
    fn the_retry_body_has_no_thinking_field_and_extra_json_cannot_override_protected_keys() {
        let params = GenerationParams::default();
        let (b, sent) = build_chat_body("openai", &user(), "gpt-5.1", &params, Off, None, false);
        assert!(!sent);
        assert!(b.get("reasoning_effort").is_none());

        let extra = parse_extra_request(Some(r#"{"model":"evil","stream":false,"messages":[],"top_p":0.9}"#));
        let (b, _) = build_chat_body("lm_studio", &user(), "m", &params, Auto, extra.as_ref(), true);
        assert_eq!(b["model"], "m");
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["content"], "hi");
        assert_eq!(b["top_p"], 0.9);
    }
}
