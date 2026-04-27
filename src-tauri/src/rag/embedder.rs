use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use std::time::Duration;

/// Ollama embedding HTTP client.
pub struct OllamaEmbedder {
    client: Client,
    base_url: String,
}

/// Connection status for the Ollama server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub connected: bool,
    pub models: Vec<String>,
}

/// Response from the Ollama /api/embed endpoint.
#[derive(Debug, Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

/// Request body for the Ollama /api/embed endpoint.
#[derive(Debug, Serialize)]
struct EmbedRequest {
    model: String,
    input: Vec<String>,
}

/// A single model entry in the Ollama /api/tags response.
#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

/// Response from the Ollama /api/tags endpoint.
#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<OllamaModel>,
}

/// Request body for the Ollama /api/pull endpoint.
#[derive(Debug, Serialize)]
struct PullRequest {
    name: String,
    stream: bool,
}

/// A single streamed line from the /api/pull response.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PullProgress {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub completed: u64,
}

/// Returns the approximate character limit for a model to avoid exceeding its context window.
/// Based on known max sequence lengths for common Ollama embedding models.
fn model_char_limit(model: &str) -> usize {
    let m = model.to_lowercase();
    if m.contains("all-minilm") {
        // all-MiniLM-L6-v2: 256 subword tokens × ~3.5 chars/token = ~900, minus prefix slack
        800
    } else if m.contains("mxbai-embed-large") {
        // mxbai-embed-large: 512 subword tokens
        1_700
    } else if m.contains("nomic-embed-text") {
        // nomic-embed-text base: 2048 subword tokens; v1.5: 8192.
        // Use conservative 2048-token estimate (~4 bytes/token for Spanish) = 5000 chars
        5_000
    } else if m.contains("bge-large") || m.contains("bge-base") {
        // BGE models: 512 subword tokens
        1_700
    } else if m.contains("bge-small") || m.contains("bge-micro") {
        800
    } else if m.contains("e5-large") || m.contains("e5-base") {
        1_700
    } else if m.contains("e5-small") {
        800
    } else if m.contains("jina") {
        // jina-embeddings: 8192 subword tokens
        28_000
    } else {
        // Conservative default for unknown models — assume 256 subword tokens to be safe.
        // Spanish/accented text uses more BPE tokens per char than ASCII.
        800
    }
}

/// Truncate text to at most `max_chars` **bytes**, always on a valid UTF-8 char boundary.
fn truncate_text(text: &str, max_chars: usize) -> &str {
    if text.len() <= max_chars {
        return text;
    }
    // Find the largest valid UTF-8 byte boundary that fits within max_chars bytes
    let safe_end = text
        .char_indices()
        .take_while(|(i, _)| *i < max_chars)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    // Prefer breaking at whitespace to avoid splitting a word
    let boundary = text[..safe_end]
        .rfind(|c: char| c.is_whitespace())
        .unwrap_or(safe_end);
    text[..boundary].trim_end()
}

impl OllamaEmbedder {
    /// Create a new embedder pointing at the given Ollama base URL.
    pub fn new(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Get the configured base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Embed one or more texts using the specified model.
    /// Sends a POST to `/api/embed` with a 120-second timeout.
    ///
    /// Texts are silently truncated to the model's context-safe character limit before
    /// sending — prevents 400 "input length exceeds context length" errors from models
    /// with small context windows like all-minilm (256 tokens).
    pub async fn embed_texts(
        &self,
        texts: Vec<String>,
        model: &str,
    ) -> Result<Vec<Vec<f32>>, String> {
        let url = format!("{}/api/embed", self.base_url);
        let base_limit = model_char_limit(model);

        // Retry with progressively halved char limit on 400 "input length" errors.
        // Handles models whose real BPE token count per char is higher than estimated
        // (common with Spanish/accented text on smaller context models).
        let mut char_limit = base_limit;
        let mut last_err = String::new();

        loop {
            let safe_texts: Vec<String> = texts
                .iter()
                .map(|t| truncate_text(t, char_limit.max(64)).to_string())
                .collect();

            let request_body = EmbedRequest {
                model: model.to_string(),
                input: safe_texts,
            };

            let response = self
                .client
                .post(&url)
                .json(&request_body)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("Ollama embed request failed: {}", e))?;

            if response.status().as_u16() == 400 {
                let body = response.text().await.unwrap_or_default();
                if body.contains("input length") || body.contains("context length") {
                    last_err = format!("Ollama embed returned status 400 Bad Request: {}", body);
                    if char_limit <= 64 {
                        break; // can't go smaller — give up
                    }
                    char_limit /= 2;
                    log::warn!(
                        "Ollama embed 400 context exceeded, retrying at char_limit={}. model={}",
                        char_limit, model
                    );
                    continue;
                }
                return Err(format!("Ollama embed returned status 400 Bad Request: {}", body));
            }

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_else(|_| "no body".to_string());
                return Err(format!("Ollama embed returned status {}: {}", status, body));
            }

            let embed_response: EmbedResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse embed response: {}", e))?;

            return Ok(embed_response.embeddings);
        }

        Err(last_err)
    }

    /// Embed a single query text with the "search_query: " prefix.
    pub async fn embed_query(
        &self,
        text: &str,
        model: &str,
    ) -> Result<Vec<f32>, String> {
        let prefixed = format!("search_query: {}", text);
        let results = self.embed_texts(vec![prefixed], model).await?;
        results
            .into_iter()
            .next()
            .ok_or_else(|| "No embedding returned for query".to_string())
    }

    /// Embed multiple document texts with the "search_document: " prefix.
    pub async fn embed_documents(
        &self,
        texts: Vec<String>,
        model: &str,
    ) -> Result<Vec<Vec<f32>>, String> {
        let prefixed: Vec<String> = texts
            .into_iter()
            .map(|t| format!("search_document: {}", t))
            .collect();
        self.embed_texts(prefixed, model).await
    }

    /// Test connectivity to an Ollama server and list available models.
    pub async fn test_connection(base_url: &str) -> Result<OllamaStatus, String> {
        let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
        let client = Client::new();

        let response = client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("Cannot connect to Ollama at {}: {}", base_url, e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Ollama returned status {}",
                response.status()
            ));
        }

        let tags: TagsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Ollama tags response: {}", e))?;

        let model_names: Vec<String> = tags.models.into_iter().map(|m| m.name).collect();

        Ok(OllamaStatus {
            connected: true,
            models: model_names,
        })
    }

    /// Pull (download) a model from Ollama, streaming progress events.
    ///
    /// Emits "ollama_pull_progress" events on the Tauri app handle with
    /// `{status, total, completed}` for each streamed line.
    pub async fn pull_model(
        base_url: &str,
        model: &str,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
        let client = Client::new();

        let request_body = PullRequest {
            name: model.to_string(),
            stream: true,
        };

        let response = client
            .post(&url)
            .json(&request_body)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| format!("Ollama pull request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "no body".to_string());
            return Err(format!(
                "Ollama pull returned status {}: {}",
                status, body
            ));
        }

        let mut stream = response.bytes_stream();

        // Buffer for incomplete lines across chunk boundaries
        let mut line_buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result
                .map_err(|e| format!("Stream read error during pull: {}", e))?;

            let text = String::from_utf8_lossy(&chunk);
            line_buffer.push_str(&text);

            // Process complete lines
            while let Some(newline_pos) = line_buffer.find('\n') {
                let line: String = line_buffer.drain(..=newline_pos).collect();
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                if let Ok(progress) = serde_json::from_str::<PullProgress>(line) {
                    let _ = app_handle.emit("ollama_pull_progress", &progress);
                }
            }
        }

        // Process any remaining data in the buffer
        let remaining = line_buffer.trim();
        if !remaining.is_empty() {
            if let Ok(progress) = serde_json::from_str::<PullProgress>(remaining) {
                let _ = app_handle.emit("ollama_pull_progress", &progress);
            }
        }

        Ok(())
    }
}
