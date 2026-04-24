// Sub-PRD 5: Shared OpenAI-compatible client
// Used by: OpenAI, Groq, OpenRouter, LM Studio

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;
use tauri::Emitter;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    StreamEndPayload, StreamTokenPayload,
};
use super::stream_parser::{LineBuffer, SSEParser};

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
}

impl OpenAICompatClient {
    pub fn new(config: OpenAICompatConfig) -> Self {
        let client = reqwest::Client::new();
        Self { config, client }
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
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let start = Instant::now();

        // Build messages array
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content
                })
            })
            .collect();

        let mut body = json!({
            "model": model,
            "messages": msgs,
            "stream": true
        });

        if let Some(temp) = params.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max_tok) = params.max_tokens {
            body["max_tokens"] = json!(max_tok);
        }

        let request = self
            .apply_auth(self.client.post(&url))
            .header("Content-Type", "application/json")
            .json(&body);

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = request.send().await.map_err(|e| {
            let _ = app_handle.emit("llm_stream_error", e.to_string());
            e
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let err_msg = format!("Completion request failed ({}): {}", status, body);
            let _ = app_handle.emit("llm_stream_error", &err_msg);
            return Err(LLMError::ProviderError(err_msg));
        }

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| {
                let _ = app_handle.emit("llm_stream_error", e.to_string());
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
                                    let _ = app_handle.emit(
                                        "llm_stream_token",
                                        StreamTokenPayload {
                                            token: token.clone(),
                                        },
                                    );
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
                            let _ = app_handle.emit(
                                "llm_stream_token",
                                StreamTokenPayload {
                                    token: token.clone(),
                                },
                            );
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

        let _ = app_handle.emit(
            "llm_stream_end",
            StreamEndPayload {
                total_tokens: token_count,
                latency_ms,
            },
        );

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
