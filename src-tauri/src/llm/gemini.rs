// Sub-PRD 5: Google Gemini streamGenerateContent client

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end_with_stats, emit_error, emit_sources, emit_token, StreamSource, TokenSink,
};
use super::stream_parser::{LineBuffer, SSEParser};

pub struct GeminiClient {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

impl GeminiClient {
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://generativelanguage.googleapis.com")
                .to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Convert standard LLM messages to Gemini format.
    /// Gemini uses "user" and "model" roles, with a separate systemInstruction field.
    fn convert_messages(
        messages: &[LLMMessage],
    ) -> (Option<String>, Vec<serde_json::Value>) {
        let mut system_instruction: Option<String> = None;
        let mut contents: Vec<serde_json::Value> = Vec::new();

        for msg in messages {
            match msg.role.as_str() {
                "system" => {
                    system_instruction = Some(msg.content.clone());
                }
                "assistant" => {
                    contents.push(json!({
                        "role": "model",
                        "parts": [{"text": msg.content}]
                    }));
                }
                _ => {
                    // "user" or anything else maps to "user"
                    contents.push(json!({
                        "role": "user",
                        "parts": [{"text": msg.content}]
                    }));
                }
            }
        }

        (system_instruction, contents)
    }
}

#[async_trait::async_trait]
impl LLMProvider for GeminiClient {
    fn provider_name(&self) -> &str {
        "gemini"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let url = format!(
            "{}/v1beta/models?key={}",
            self.base_url, self.api_key
        );

        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = crate::logging::redact(&response.text().await.unwrap_or_default());
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(LLMError::AuthError(format!(
                    "Gemini authentication failed ({}): {}",
                    status, body
                )));
            }
            return Err(LLMError::ProviderError(format!(
                "Failed to list Gemini models ({}): {}",
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
                        let display_name = m
                            .get("displayName")
                            .and_then(|n| n.as_str())
                            .unwrap_or(&name)
                            .to_string();

                        // Filter to only generateContent-supporting models
                        let supported = m
                            .get("supportedGenerationMethods")
                            .and_then(|s| s.as_array())
                            .map(|methods| {
                                methods.iter().any(|method| {
                                    method.as_str() == Some("generateContent")
                                        || method.as_str() == Some("streamGenerateContent")
                                })
                            })
                            .unwrap_or(false);

                        if !supported {
                            return None;
                        }

                        // Extract model ID from "models/gemini-pro" -> "gemini-pro"
                        let id = name
                            .strip_prefix("models/")
                            .unwrap_or(&name)
                            .to_string();

                        let context_window = m
                            .get("inputTokenLimit")
                            .and_then(|c| c.as_u64());

                        Some(ModelInfo {
                            id,
                            name: display_name,
                            provider: "gemini".to_string(),
                            context_window,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        match self.list_models().await {
            Ok(models) => Ok(!models.is_empty()),
            Err(_) => Ok(false),
        }
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?key={}&alt=sse",
            self.base_url, model, self.api_key
        );
        let start = Instant::now();

        let (system_instruction, contents) = Self::convert_messages(&messages);

        let max_output = params.max_tokens.unwrap_or(4096);
        let mut gen_config = json!({
            "maxOutputTokens": max_output
        });
        if let Some(temp) = params.temperature {
            gen_config["temperature"] = json!(temp);
        }

        let mut body = if let Some(cache_name) = &params.cache_name {
            // Cache active: reference cached content, skip systemInstruction (it's in the cache).
            // Only dynamic contents (transcript + question) are sent fresh.
            json!({
                "cachedContent": cache_name,
                "contents": contents,
                "generationConfig": gen_config
            })
        } else {
            let mut b = json!({
                "contents": contents,
                "generationConfig": gen_config
            });
            if let Some(system) = system_instruction {
                b["systemInstruction"] = json!({
                    "parts": [{"text": system}]
                });
            }
            b
        };

        if params.enable_web_search {
            body["tools"] = json!([{ "google_search": {} }]);
        }

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = cancellable(
            &params,
            self
                .client
                .post(&url)
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
            let err_msg = format!("Gemini request failed ({}): {}", status, body);
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
        let mut prompt_tokens: u64 = 0;
        let mut completion_tokens: u64 = 0;
        let mut grounding_sources: Vec<(String, String)> = Vec::new();

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
                            // Extract token from Gemini format
                            if let Some(token) = SSEParser::extract_gemini_token(&data) {
                                if !token.is_empty() {
                                    token_count += 1;
                                    check_cancelled(&params)?;
                                    emit_token(&app_handle, &params, &token, sink.as_ref());
                                }
                            }

                            if params.enable_web_search {
                                grounding_sources.extend(SSEParser::extract_gemini_grounding(&data));
                            }

                            // Extract usage metadata if available
                            if let Some(usage) = data.get("usageMetadata") {
                                if let Some(pt) =
                                    usage.get("promptTokenCount").and_then(|v| v.as_u64())
                                {
                                    prompt_tokens = pt;
                                }
                                if let Some(ct) =
                                    usage.get("candidatesTokenCount").and_then(|v| v.as_u64())
                                {
                                    completion_tokens = ct;
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

        // Flush remaining buffer
        if let Some(remaining) = line_buffer.flush() {
            let events = SSEParser::parse_chunk(&remaining);
            for event in events {
                if let Some(data) = event {
                    if let Some(token) = SSEParser::extract_gemini_token(&data) {
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

        if completion_tokens == 0 {
            completion_tokens = token_count;
        }
        let total = prompt_tokens + completion_tokens;

        let stats = CompletionStats {
            prompt_tokens,
            completion_tokens,
            total_tokens: total,
            latency_ms,
        };

        if !grounding_sources.is_empty() {
            let mut seen = std::collections::HashSet::new();
            let sources: Vec<StreamSource> = grounding_sources
                .into_iter()
                .filter(|(_, url)| seen.insert(url.clone()))
                .map(|(title, url)| StreamSource { title, url })
                .collect();
            check_cancelled(&params)?;
            emit_sources(&app_handle, &params, sources);
        }

        check_cancelled(&params)?;
        emit_end_with_stats(&app_handle, &params, &stats);

        Ok(stats)
    }
}
