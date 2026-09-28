// Sub-PRD 5: Ollama NDJSON streaming client

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;
use tauri::Emitter;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    StreamEndPayload, StreamTokenPayload,
};
use super::stream_parser::{LineBuffer, NDJSONParser};

pub struct OllamaClient {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaClient {
    pub fn new(base_url: Option<&str>) -> Self {
        Self {
            base_url: base_url.unwrap_or("http://localhost:11434").to_string(),
            client: reqwest::Client::new(),
        }
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
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!("{}/api/chat", self.base_url);
        let start = Instant::now();

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
        if !options.is_empty() {
            body["options"] = serde_json::Value::Object(options);
        }

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                let _ = app_handle.emit("llm_stream_error", e.to_string());
                LLMError::ConnectionFailed(format!("Failed to connect to Ollama: {}", e))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let err_msg = format!("Ollama completion failed ({}): {}", status, body);
            let _ = app_handle.emit("llm_stream_error", &err_msg);
            return Err(LLMError::ProviderError(err_msg));
        }

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;
        let mut prompt_tokens: u64 = 0;
        let mut completion_tokens: u64 = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| {
                let _ = app_handle.emit("llm_stream_error", e.to_string());
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
        };

        let _ = app_handle.emit(
            "llm_stream_end",
            StreamEndPayload {
                total_tokens: total,
                latency_ms,
            },
        );

        Ok(stats)
    }
}
