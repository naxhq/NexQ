// Sub-PRD 5: User-configured custom endpoint with auto-detect SSE/NDJSON

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end, emit_error, emit_token, TokenSink,
};
use super::stream_parser::{LineBuffer, NDJSONParser, SSEParser};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CustomAuthType {
    None,
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone)]
pub struct CustomConfig {
    pub base_url: String,
    pub auth_type: CustomAuthType,
    pub auth_value: Option<String>,
    pub auth_header: Option<String>,
}

pub struct CustomClient {
    config: CustomConfig,
    client: reqwest::Client,
}

/// Longest part of an error body quoted in an error message.
const ERROR_DETAIL_MAX_CHARS: usize = 300;

/// How the client authenticates, for the log: the kind and the credential's
/// length, never the credential itself.
fn describe_auth(config: &CustomConfig) -> String {
    let kind = match &config.auth_type {
        CustomAuthType::None => return "auth none".to_string(),
        CustomAuthType::Bearer => "bearer".to_string(),
        CustomAuthType::ApiKey => format!("API key in header '{}'", config.auth_header.as_deref().unwrap_or("x-api-key")),
    };
    let credential = match config.auth_value.as_deref().map(|v| (v, v.trim())) {
        None | Some((_, "")) => "no credential (nothing is sent)".to_string(),
        Some((v, t)) if t != v => format!("{}-character credential (spaces around it removed)", t.chars().count()),
        Some((_, t)) => format!("{}-character credential", t.chars().count()),
    };
    format!("auth {}, {}", kind, credential)
}

/// The reason in an error body: `{"error": "..."}` or `{"error": {"message": "..."}}`,
/// else the body itself, shortened.
fn error_detail(body: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let error = parsed.as_ref().and_then(|v| v.get("error"));
    let reason = error
        .and_then(|e| e.as_str().or_else(|| e.get("message").and_then(|m| m.as_str())))
        .unwrap_or(body)
        .trim();
    reason.chars().take(ERROR_DETAIL_MAX_CHARS).collect()
}

impl CustomClient {
    pub fn new(config: CustomConfig) -> Self {
        log::info!("CustomLLM: {}", describe_auth(&config));
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// Opens the chat stream: OpenAI-compatible `/chat/completions` first, then
    /// Ollama's native `/api/chat`. When both fail, the error gives both
    /// answers, the first one first: a server that has `/chat/completions` (a
    /// base URL ending in /v1) gives its real reason there, such as a refused
    /// key or an unknown model, while `/api/chat` only says it doesn't exist.
    async fn open_chat_stream(
        &self,
        msgs: &[serde_json::Value],
        model: &str,
        params: &GenerationParams,
    ) -> Result<reqwest::Response, LLMError> {
        let mut body = json!({ "model": model, "messages": msgs, "stream": true });
        if let Some(temp) = params.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max_tok) = params.max_tokens {
            body["max_tokens"] = json!(max_tok);
        }
        let first = match self.post_json("/chat/completions", &body, params).await? {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                log::warn!("CustomLLM: /chat/completions answered {}; trying /api/chat", resp.status());
                cancellable(params, Self::failure(resp)).await?
            }
            Err(e) => {
                log::warn!("CustomLLM: /chat/completions couldn't be reached; trying /api/chat");
                format!("couldn't be reached ({})", e)
            }
        };

        // Ollama's native API takes no OpenAI options.
        let body = json!({ "model": model, "messages": msgs, "stream": true });
        let (second, unreachable) = match self.post_json("/api/chat", &body, params).await? {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => (cancellable(params, Self::failure(resp)).await?, false),
            Err(e) => (format!("couldn't be reached ({})", e), true),
        };
        let message = format!("Custom endpoint request failed: /chat/completions {}; /api/chat {}", first, second);
        Err(if unreachable { LLMError::ConnectionFailed(message) } else { LLMError::ProviderError(message) })
    }

    /// POST `body` as JSON to `path` under the base URL, with the configured auth.
    async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
        params: &GenerationParams,
    ) -> Result<Result<reqwest::Response, reqwest::Error>, LLMError> {
        let request = self
            .apply_auth(self.client.post(format!("{}{}", self.config.base_url, path)))
            .header("Content-Type", "application/json")
            .json(body);
        cancellable(params, request.send()).await
    }

    /// "answered 401 Unauthorized (reason)" for a failed response.
    async fn failure(resp: reqwest::Response) -> String {
        let status = resp.status();
        let detail = error_detail(&resp.text().await.unwrap_or_default());
        if detail.is_empty() {
            format!("answered {}", status)
        } else {
            format!("answered {} ({})", status, detail)
        }
    }

    /// Apply authentication to a request based on the configured auth type.
    /// Spaces around the credential (a pasted key often has some) aren't sent,
    /// and a blank credential sends no header at all.
    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let credential = self.config.auth_value.as_deref().map(str::trim).filter(|v| !v.is_empty());
        match (&self.config.auth_type, credential) {
            (CustomAuthType::Bearer, Some(token)) => builder.header("Authorization", format!("Bearer {}", token)),
            (CustomAuthType::ApiKey, Some(key)) => {
                builder.header(self.config.auth_header.as_deref().unwrap_or("x-api-key"), key)
            }
            _ => builder,
        }
    }

    /// Detect whether a stream is SSE or NDJSON and parse tokens accordingly.
    /// Returns (token_text, is_done).
    fn try_extract_token(line: &str) -> Vec<(Option<String>, bool)> {
        let mut results = Vec::new();

        // Try SSE format first
        let sse_events = SSEParser::parse_chunk(line);
        if !sse_events.is_empty() {
            for event in sse_events {
                match event {
                    Some(data) => {
                        // Try OpenAI-compat format
                        if let Some(token) = SSEParser::extract_openai_token(&data) {
                            results.push((Some(token), false));
                            continue;
                        }
                        // Try Anthropic format
                        if let Some(token) = SSEParser::extract_anthropic_token(&data) {
                            results.push((Some(token), false));
                            continue;
                        }
                        // Try Gemini format
                        if let Some(token) = SSEParser::extract_gemini_token(&data) {
                            results.push((Some(token), false));
                            continue;
                        }
                        // Unknown SSE format - try generic text extraction
                        if let Some(text) = data.get("text").and_then(|t| t.as_str()) {
                            results.push((Some(text.to_string()), false));
                            continue;
                        }
                        if let Some(content) = data.get("content").and_then(|t| t.as_str()) {
                            results.push((Some(content.to_string()), false));
                        }
                    }
                    None => {
                        // [DONE]
                        results.push((None, true));
                    }
                }
            }
            return results;
        }

        // Try NDJSON format
        let ndjson_events = NDJSONParser::parse_chunk(line);
        for data in ndjson_events {
            if NDJSONParser::is_ollama_done(&data) {
                results.push((None, true));
                continue;
            }
            // Try Ollama format
            if let Some(token) = NDJSONParser::extract_ollama_token(&data) {
                results.push((Some(token), false));
                continue;
            }
            // Try generic extraction
            if let Some(text) = data.get("text").and_then(|t| t.as_str()) {
                results.push((Some(text.to_string()), false));
                continue;
            }
            if let Some(content) = data.get("content").and_then(|t| t.as_str()) {
                results.push((Some(content.to_string()), false));
                continue;
            }
            // Try OpenAI format in NDJSON (some servers do this)
            if let Some(token) = SSEParser::extract_openai_token(&data) {
                results.push((Some(token), false));
            }
        }

        results
    }
}

#[async_trait::async_trait]
impl LLMProvider for CustomClient {
    fn provider_name(&self) -> &str {
        "custom"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        // Try OpenAI-compatible /models endpoint
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));

        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value = response.json().await?;
                let models = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                let id = m.get("id")?.as_str()?.to_string();
                                Some(ModelInfo {
                                    id: id.clone(),
                                    name: m
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or(&id)
                                        .to_string(),
                                    provider: "custom".to_string(),
                                    context_window: None,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(models)
            }
            _ => {
                // Try Ollama-compatible /api/tags endpoint
                let url = format!("{}/api/tags", self.config.base_url);
                let request = self.apply_auth(self.client.get(&url));

                match request.send().await {
                    Ok(response) if response.status().is_success() => {
                        let body: serde_json::Value = response.json().await?;
                        let models = body
                            .get("models")
                            .and_then(|m| m.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| {
                                        let name = m.get("name")?.as_str()?.to_string();
                                        Some(ModelInfo {
                                            id: name.clone(),
                                            name: name.clone(),
                                            provider: "custom".to_string(),
                                            context_window: None,
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        Ok(models)
                    }
                    _ => {
                        // Return empty list - user can type model name manually
                        Ok(vec![])
                    }
                }
            }
        }
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        // Try /models first (OpenAI-compat)
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));
        if let Ok(resp) = request.send().await {
            if resp.status().is_success() {
                return Ok(true);
            }
        }

        // Try /api/tags (Ollama-compat)
        let url = format!("{}/api/tags", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));
        if let Ok(resp) = request.send().await {
            if resp.status().is_success() {
                return Ok(true);
            }
        }

        // Try a simple GET to the base URL
        let request = self.apply_auth(self.client.get(&self.config.base_url));
        match request.send().await {
            Ok(resp) => Ok(resp.status().is_success()),
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

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = match self.open_chat_stream(&msgs, model, &params).await {
            Ok(response) => response,
            Err(LLMError::Cancelled) => return Err(LLMError::Cancelled),
            Err(e) => {
                check_cancelled(&params)?;
                let message = match &e {
                    LLMError::ProviderError(m) | LLMError::ConnectionFailed(m) => m.clone(),
                    other => other.to_string(),
                };
                emit_error(&app_handle, &params, &message);
                return Err(e);
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
                let extractions = Self::try_extract_token(&line);
                for (maybe_token, _is_done) in extractions {
                    if let Some(token) = maybe_token {
                        if !token.is_empty() {
                            token_count += 1;
                            check_cancelled(&params)?;
                            emit_token(&app_handle, &params, &token, sink.as_ref());
                        }
                    }
                }
            }
        }

        // Flush remaining
        if let Some(remaining) = line_buffer.flush() {
            let extractions = Self::try_extract_token(&remaining);
            for (maybe_token, _is_done) in extractions {
                if let Some(token) = maybe_token {
                    if !token.is_empty() {
                        token_count += 1;
                        check_cancelled(&params)?;
                        emit_token(&app_handle, &params, &token, sink.as_ref());
                    }
                }
            }
        }

        let latency_ms = start.elapsed().as_millis() as u64;
        let stats = CompletionStats {
            prompt_tokens: 0,
            completion_tokens: token_count,
            total_tokens: token_count,
            latency_ms,
        };

        check_cancelled(&params)?;
        emit_end(&app_handle, &params, token_count, latency_ms);

        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The requests a test server saw: path and Authorization header.
    type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

    /// A local HTTP server answering each path with a fixed status and body
    /// (404 for any other path). Returns its base URL, ending in /v1.
    async fn server(routes: Vec<(&'static str, u16, &'static str)>) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
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
                let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case(name).then(|| value.trim().to_string())
                    })
                };
                let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while raw.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push((path.clone(), header("authorization")));
                let (status, body) = routes
                    .iter()
                    .find(|(p, _, _)| *p == path)
                    .map(|(_, s, b)| (*s, *b))
                    .unwrap_or((404, r#"{"error":"no such path"}"#));
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                let _ = socket.shutdown().await;
            }
        });
        (base, seen)
    }

    fn client(base: &str, auth_type: CustomAuthType, auth_value: Option<&str>) -> CustomClient {
        CustomClient::new(CustomConfig {
            base_url: base.to_string(),
            auth_type,
            auth_value: auth_value.map(String::from),
            auth_header: None,
        })
    }

    fn hi() -> Vec<serde_json::Value> {
        vec![json!({ "role": "user", "content": "hi" })]
    }

    async fn failure_message(client: &CustomClient, model: &str) -> String {
        match client.open_chat_stream(&hi(), model, &GenerationParams::default()).await {
            Err(LLMError::ProviderError(message)) => message,
            other => panic!("expected a provider error, got {:?}", other.map(|r| r.status())),
        }
    }

    /// Reported bug: Ollama Cloud refusing the request showed only the
    /// fallback's answer, "path /v1/api/chat not found".
    #[tokio::test]
    async fn when_both_endpoints_fail_the_first_answer_comes_first() {
        let (base, _) = server(vec![
            ("/v1/chat/completions", 401, r#"{"error":"unauthorized"}"#),
            ("/v1/api/chat", 404, r#"{"error":"path \"/v1/api/chat\" not found"}"#),
        ])
        .await;
        assert_eq!(
            failure_message(&client(&base, CustomAuthType::None, None), "gemma4:31b").await,
            r#"Custom endpoint request failed: /chat/completions answered 401 Unauthorized (unauthorized); /api/chat answered 404 Not Found (path "/v1/api/chat" not found)"#
        );
    }

    #[tokio::test]
    async fn an_unknown_model_is_named_as_the_reason() {
        let (base, _) = server(vec![(
            "/v1/chat/completions",
            404,
            r#"{"error":{"message":"model \"gemma\" not found","type":"not_found_error"}}"#,
        )])
        .await;
        let message = failure_message(&client(&base, CustomAuthType::Bearer, Some("tok")), "gemma").await;
        assert!(message.contains(r#"/chat/completions answered 404 Not Found (model "gemma" not found)"#), "{message}");
    }

    #[tokio::test]
    async fn an_ollama_native_server_still_answers_on_api_chat() {
        let (base, seen) = server(vec![("/v1/api/chat", 200, "{}")]).await;
        let response = client(&base, CustomAuthType::None, None)
            .open_chat_stream(&hi(), "llama3.2", &GenerationParams::default())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let paths: Vec<String> = seen.lock().unwrap().iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(paths, ["/v1/chat/completions", "/v1/api/chat"]);
    }

    /// Reported: a key pasted with spaces around it was refused (401).
    #[tokio::test]
    async fn a_bearer_token_is_sent_without_spaces_around_it() {
        let (base, seen) = server(vec![("/v1/chat/completions", 200, "{}")]).await;
        client(&base, CustomAuthType::Bearer, Some("  tok "))
            .open_chat_stream(&hi(), "m", &GenerationParams::default())
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap()[0], ("/v1/chat/completions".to_string(), Some("Bearer tok".to_string())));
    }

    /// A token cleared in Settings applies at once, as it does after a restart:
    /// no header at all, not "Bearer " with nothing after it.
    #[tokio::test]
    async fn a_blank_credential_sends_no_auth_header() {
        let (base, seen) = server(vec![("/v1/chat/completions", 200, "{}")]).await;
        client(&base, CustomAuthType::Bearer, Some("   "))
            .open_chat_stream(&hi(), "m", &GenerationParams::default())
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap()[0], ("/v1/chat/completions".to_string(), None));
    }

    /// The first failure's body is read now, so a server that stalls while
    /// sending it must not hold up Stop.
    #[tokio::test]
    async fn stop_works_while_an_error_body_stalls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            socket.write_all(b"HTTP/1.1 401 X\r\nContent-Length: 100\r\n\r\n").await.unwrap();
            std::future::pending::<()>().await;
            drop(socket);
        });
        let token = Arc::new(crate::llm::provider::CancelToken::new());
        let params = GenerationParams { cancel: Some(Arc::clone(&token)), ..GenerationParams::default() };
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            token.cancel();
        });
        let custom = client(&base, CustomAuthType::None, None);
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            custom.open_chat_stream(&hi(), "m", &params),
        )
        .await;
        assert!(matches!(outcome, Ok(Err(LLMError::Cancelled))), "{:?}", outcome.map(|r| r.map(|resp| resp.status())));
    }

    #[test]
    fn the_log_line_describes_the_auth_without_the_credential() {
        let config = |auth_type, value: Option<&str>| CustomConfig {
            base_url: String::new(),
            auth_type,
            auth_value: value.map(String::from),
            auth_header: None,
        };
        assert_eq!(describe_auth(&config(CustomAuthType::None, Some("secret"))), "auth none");
        assert_eq!(describe_auth(&config(CustomAuthType::Bearer, None)), "auth bearer, no credential (nothing is sent)");
        assert_eq!(describe_auth(&config(CustomAuthType::Bearer, Some("secret"))), "auth bearer, 6-character credential");
        assert_eq!(
            describe_auth(&config(CustomAuthType::ApiKey, Some(" secret "))),
            "auth API key in header 'x-api-key', 6-character credential (spaces around it removed)"
        );
    }

    /// NexQ's own request to Ollama Cloud: without auth, with an unknown
    /// model, and with the right setup. Needs OLLAMA_API_KEY.
    #[tokio::test]
    #[ignore = "calls Ollama Cloud; needs OLLAMA_API_KEY"]
    async fn live_ollama_cloud_gives_its_real_reason() {
        let key = std::env::var("OLLAMA_API_KEY").expect("OLLAMA_API_KEY");
        let params = GenerationParams { max_tokens: Some(5), ..GenerationParams::default() };
        let base = "https://ollama.com/v1";
        let cases = [
            ("no auth, gemma4:31b-cloud", client(base, CustomAuthType::None, None), "gemma4:31b-cloud"),
            ("API key header, gemma4:31b-cloud", client(base, CustomAuthType::ApiKey, Some(&key)), "gemma4:31b-cloud"),
            ("bearer, no-such-model", client(base, CustomAuthType::Bearer, Some(&key)), "no-such-model"),
            ("bearer, gemma4:31b-cloud", client(base, CustomAuthType::Bearer, Some(&key)), "gemma4:31b-cloud"),
            ("bearer, gemma4:31b", client(base, CustomAuthType::Bearer, Some(&key)), "gemma4:31b"),
        ];
        let mut ok = Vec::new();
        for (label, client, model) in cases {
            match client.open_chat_stream(&hi(), model, &params).await {
                Ok(response) => {
                    println!("{label}: OK {}", response.status());
                    ok.push(label);
                }
                Err(e) => println!("{label}: {e}"),
            }
        }
        assert_eq!(ok, ["bearer, gemma4:31b-cloud", "bearer, gemma4:31b"]);
    }
}
