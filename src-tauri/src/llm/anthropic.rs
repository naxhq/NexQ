// Sub-PRD 5: Anthropic Messages API client

use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end_with_stats, emit_error, emit_token, TokenSink,
};
use super::stream_parser::{LineBuffer, SSEParser};

/// `anthropic-version` sent with every request.
const API_VERSION: &str = "2023-06-01";

/// Output budget when the caller sets none. Current models think before they
/// answer, and thinking counts toward `max_tokens`.
const DEFAULT_MAX_TOKENS: u64 = 16_000;

pub struct AnthropicClient {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

/// One page of `GET /v1/models`.
#[derive(Deserialize)]
struct ModelPage {
    data: Vec<ApiModel>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct ApiModel {
    id: String,
    display_name: Option<String>,
    max_input_tokens: Option<u64>,
    lifecycle: Option<String>,
}

/// Models that can still be called: retired ones fail every request.
fn usable_models(models: Vec<ApiModel>) -> impl Iterator<Item = ModelInfo> {
    models
        .into_iter()
        .filter(|m| m.lifecycle.as_deref() != Some("retired"))
        .map(ModelInfo::from)
}

impl From<ApiModel> for ModelInfo {
    fn from(m: ApiModel) -> Self {
        ModelInfo {
            name: m.display_name.unwrap_or_else(|| m.id.clone()),
            id: m.id,
            provider: "anthropic".to_string(),
            context_window: m.max_input_tokens,
        }
    }
}

impl AnthropicClient {
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://api.anthropic.com")
                .to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Current models, for a base URL that has no Models API (a proxy).
    fn fallback_models() -> Vec<ModelInfo> {
        [
            ("claude-opus-5-5", "Claude Opus 5.5", 1_000_000),
            ("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000),
            ("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000),
            ("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
        ]
        .into_iter()
        .map(|(id, name, context)| ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
            provider: "anthropic".to_string(),
            context_window: Some(context),
        })
        .collect()
    }

    /// `GET /v1/models` request for the page after `after_id`.
    fn models_request(&self, limit: u32, after_id: Option<&str>) -> reqwest::RequestBuilder {
        let mut url = format!("{}/v1/models?limit={limit}", self.base_url);
        if let Some(id) = after_id {
            url.push_str("&after_id=");
            url.push_str(id);
        }
        self.client
            .get(url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
    }

    /// The models this API key can use, newest first. `None` when the base URL
    /// has no Models API.
    async fn fetch_models(&self) -> Result<Option<Vec<ModelInfo>>, LLMError> {
        let mut models = Vec::new();
        let mut after_id: Option<String> = None;
        loop {
            let response = self.models_request(1000, after_id.as_deref()).send().await?;
            let status = response.status();
            if status.as_u16() == 404 {
                return Ok(None);
            }
            if !status.is_success() {
                let body = crate::logging::redact(&response.text().await.unwrap_or_default());
                let message = format!("Anthropic model list failed ({status}): {body}");
                return Err(if status.as_u16() == 401 || status.as_u16() == 403 {
                    LLMError::AuthError(message)
                } else {
                    LLMError::ProviderError(message)
                });
            }
            let page: ModelPage = response.json().await?;
            models.extend(usable_models(page.data));
            match page.last_id {
                Some(last) if page.has_more => after_id = Some(last),
                _ => return Ok(Some(models)),
            }
        }
    }

    /// Parse Anthropic-specific SSE event types.
    /// Anthropic SSE has "event:" lines followed by "data:" lines.
    fn parse_anthropic_sse(chunk: &str) -> Vec<AnthropicEvent> {
        let mut events = Vec::new();
        let mut current_event_type: Option<String> = None;

        for line in chunk.lines() {
            let line = line.trim();
            if line.is_empty() {
                current_event_type = None;
                continue;
            }

            if let Some(event_type) = line.strip_prefix("event:") {
                current_event_type = Some(event_type.trim().to_string());
                continue;
            }

            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = current_event_type
                        .clone()
                        .or_else(|| val.get("type").and_then(|t| t.as_str()).map(|s| s.to_string()))
                        .unwrap_or_default();

                    events.push(AnthropicEvent {
                        event_type,
                        data: val,
                    });
                }
                current_event_type = None;
            }
        }

        events
    }
}

struct AnthropicEvent {
    event_type: String,
    data: serde_json::Value,
}

#[async_trait::async_trait]
impl LLMProvider for AnthropicClient {
    fn provider_name(&self) -> &str {
        "anthropic"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        Ok(self.fetch_models().await?.unwrap_or_else(Self::fallback_models))
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        // Listing models checks the key without spending tokens.
        let response = self.models_request(1, None).send().await?;
        Ok(response.status().is_success())
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!("{}/v1/messages", self.base_url);
        let start = Instant::now();

        // Anthropic requires system message to be separate
        let mut system_content: Option<String> = None;
        let mut api_messages: Vec<serde_json::Value> = Vec::new();

        for msg in &messages {
            if msg.role == "system" {
                system_content = Some(msg.content.clone());
            } else {
                api_messages.push(json!({
                    "role": msg.role,
                    "content": msg.content
                }));
            }
        }

        let max_tokens = params.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
        // No `temperature`: current Claude models reject sampling parameters
        // with a 400, so `params.temperature` is not sent.
        let mut body = json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": api_messages,
            "stream": true
        });

        if let Some(system) = &system_content {
            body["system"] = json!(system);
        }

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = cancellable(
            &params,
            self
                .client
                .post(&url)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", API_VERSION)
                .header("Content-Type", "application/json")
                .json(&body)
                .send(),
        )
        .await?
        .map_err(|e| {
            if is_cancelled(&params) {
                return LLMError::Cancelled;
            }
                emit_error(&app_handle, &params, &e.to_string());
            LLMError::HttpError(e)
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::logging::redact(&response.text().await.unwrap_or_default());
            let err_msg = format!("Anthropic request failed ({}): {}", status, body);
            check_cancelled(&params)?;
            emit_error(&app_handle, &params, &err_msg);

            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(LLMError::AuthError(err_msg));
            }
            return Err(LLMError::ProviderError(err_msg));
        }

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;

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
                let events = Self::parse_anthropic_sse(&line);
                for event in events {
                    match event.event_type.as_str() {
                        "message_start" => {
                            // Extract input token count from usage
                            if let Some(usage) = event.data.get("message").and_then(|m| m.get("usage")) {
                                if let Some(it) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                                    input_tokens = it;
                                }
                            }
                        }
                        "content_block_delta" => {
                            if let Some(token) = SSEParser::extract_anthropic_token(&event.data) {
                                if !token.is_empty() {
                                    token_count += 1;
                                    check_cancelled(&params)?;
                                    emit_token(&app_handle, &params, &token, sink.as_ref());
                                }
                            }
                        }
                        "message_delta" => {
                            // Extract output token count
                            if let Some(usage) = event.data.get("usage") {
                                if let Some(ot) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                                    output_tokens = ot;
                                }
                            }
                        }
                        "message_stop" | "content_block_start" | "content_block_stop" | "ping" => {
                            // No action needed for these event types
                        }
                        "error" => {
                            let err_msg = event
                                .data
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown Anthropic error")
                                .to_string();
                            let err_msg = crate::logging::redact(&err_msg);
                            emit_error(&app_handle, &params, &err_msg);
                            return Err(LLMError::ProviderError(err_msg));
                        }
                        _ => {}
                    }
                }
            }
        }

        // Flush remaining buffer
        if let Some(remaining) = line_buffer.flush() {
            let events = Self::parse_anthropic_sse(&remaining);
            for event in events {
                if event.event_type == "content_block_delta" {
                    if let Some(token) = SSEParser::extract_anthropic_token(&event.data) {
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

        // Use API-reported counts if available
        if output_tokens == 0 {
            output_tokens = token_count;
        }
        let total = input_tokens + output_tokens;

        let stats = CompletionStats {
            prompt_tokens: input_tokens,
            completion_tokens: output_tokens,
            total_tokens: total,
            latency_ms,
        };

        check_cancelled(&params)?;
        emit_end_with_stats(&app_handle, &params, &stats);

        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_page_lists_callable_models_with_their_names() {
        let page: ModelPage = serde_json::from_str(
            r#"{
                "data": [
                    {"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                     "max_input_tokens": 1000000, "lifecycle": "active"},
                    {"type": "model", "id": "claude-old", "display_name": "Old", "lifecycle": "retired"},
                    {"type": "model", "id": "claude-haiku-4-5-20251001", "lifecycle": "deprecated"}
                ],
                "has_more": false, "first_id": "claude-opus-5-5", "last_id": "claude-haiku-4-5-20251001"
            }"#,
        )
        .unwrap();
        assert!(!page.has_more);
        let models: Vec<ModelInfo> = usable_models(page.data).collect();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
        assert_eq!(models[0].name, "Claude Opus 5.5");
        assert_eq!(models[0].context_window, Some(1_000_000));
        assert_eq!(models[1].name, "claude-haiku-4-5-20251001"); // no display name
    }

    #[test]
    fn fallback_lists_only_current_models() {
        let ids: Vec<String> = AnthropicClient::fallback_models().into_iter().map(|m| m.id).collect();
        assert!(ids.contains(&"claude-opus-5-5".to_string()));
        assert!(ids.iter().all(|id| !id.starts_with("claude-3")));
    }
}
