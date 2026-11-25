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
use super::thinking::{self, RequestOptions, ThinkingSetting};

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
    options: RequestOptions,
}

/// How one endpoint attempt ended.
enum Attempt {
    Stream(reqwest::Response),
    /// The server answered with an error: "answered 400 (...)".
    Failed(String),
    /// No answer: "couldn't be reached (...)".
    Unreachable(String),
}

/// The Ollama-native `/api/chat` body (no OpenAI sampling options): `think`
/// from the thinking setting, then the extra JSON merged last (`options`
/// merged key by key; model, messages and stream kept).
pub(crate) fn native_chat_body(
    msgs: &[serde_json::Value],
    model: &str,
    setting: ThinkingSetting,
    extra: Option<&serde_json::Map<String, serde_json::Value>>,
    with_thinking: bool,
) -> (serde_json::Value, bool) {
    let mut body = json!({ "model": model, "messages": msgs, "stream": true });
    let mut sent = false;
    if with_thinking {
        if let Some(think) = thinking::ollama_think(model, setting) {
            body["think"] = think;
            sent = true;
        }
    }
    if let Some(extra) = extra {
        thinking::merge_extra_request(&mut body, extra, true);
    }
    (body, sent)
}

/// The `/chat/completions` body for a custom endpoint (OpenAI-compatible).
/// `with_thinking` false leaves out `reasoning_effort` (the retry after the
/// endpoint refused it). Returns the body and whether it carries thinking.
pub(crate) fn chat_completions_body(
    msgs: &[serde_json::Value],
    model: &str,
    params: &GenerationParams,
    setting: ThinkingSetting,
    extra: Option<&serde_json::Map<String, serde_json::Value>>,
    with_thinking: bool,
) -> (serde_json::Value, bool) {
    let mut body = json!({ "model": model, "messages": msgs, "stream": true });
    if let Some(temp) = params.temperature {
        body["temperature"] = json!(temp);
    }
    if let Some(max_tok) = params.max_tokens {
        body["max_tokens"] = json!(max_tok);
    }
    let sent = with_thinking && thinking::apply_openai_compat(&mut body, "custom", model, setting);
    if let Some(extra) = extra {
        thinking::merge_extra_request(&mut body, extra, false);
    }
    (body, sent)
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
            options: RequestOptions::default(),
        }
    }

    /// Applies the user's thinking setting and extra request JSON.
    pub fn with_options(mut self, options: RequestOptions) -> Self {
        self.options = options;
        self
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
        let setting = thinking::resolve(params, self.options.thinking);
        let extra = self.options.extra_request();
        let first = match self
            .attempt("/chat/completions", "custom", model, params, setting, |with_thinking| {
                chat_completions_body(msgs, model, params, setting, extra.as_ref(), with_thinking)
            })
            .await?
        {
            Attempt::Stream(resp) => return Ok(resp),
            Attempt::Failed(text) | Attempt::Unreachable(text) => text,
        };
        log::warn!("CustomLLM: /chat/completions failed; trying /api/chat");

        let (second, unreachable) = match self
            .attempt("/api/chat", "custom:/api/chat", model, params, setting, |with_thinking| {
                native_chat_body(msgs, model, setting, extra.as_ref(), with_thinking)
            })
            .await?
        {
            Attempt::Stream(resp) => return Ok(resp),
            Attempt::Failed(text) => (text, false),
            Attempt::Unreachable(text) => (text, true),
        };
        let message = format!("Custom endpoint request failed: /chat/completions {}; /api/chat {}", first, second);
        Err(if unreachable { LLMError::ConnectionFailed(message) } else { LLMError::ProviderError(message) })
    }

    /// One endpoint of the custom server. `build(with_thinking)` makes the body
    /// and says whether it carries the thinking parameter. A 400 that refuses
    /// that parameter is retried once without it and remembered for this
    /// server (`label` + base URL) and model.
    async fn attempt(
        &self,
        path: &str,
        label: &str,
        model: &str,
        params: &GenerationParams,
        setting: ThinkingSetting,
        build: impl Fn(bool) -> (serde_json::Value, bool),
    ) -> Result<Attempt, LLMError> {
        let endpoint = self.config.base_url.as_str();
        let mut with_thinking = thinking::should_send(label, endpoint, model, setting);
        loop {
            let (body, sent) = build(with_thinking);
            match self.post_json(path, &body, params).await? {
                Ok(resp) if resp.status().is_success() => return Ok(Attempt::Stream(resp)),
                Ok(resp) => {
                    let status = resp.status();
                    let text = cancellable(params, resp.text()).await?.unwrap_or_default();
                    if sent && thinking::rejects_thinking_param(status.as_u16(), &text) {
                        log::warn!("CustomLLM: {}{} rejected the thinking parameter; retrying without it", model, path);
                        thinking::remember_unsupported(label, endpoint, model);
                        with_thinking = false;
                        continue;
                    }
                    return Ok(Attempt::Failed(Self::failure_text(status, &text)));
                }
                Err(e) => return Ok(Attempt::Unreachable(format!("couldn't be reached ({})", e))),
            }
        }
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
        Self::failure_text(status, &resp.text().await.unwrap_or_default())
    }

    fn failure_text(status: reqwest::StatusCode, body: &str) -> String {
        let detail = error_detail(body);
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

/// A 401 or 403: the server answered but won't take the request as sent.
fn auth_refused(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403)
}

/// What Test Connection says when the server refused it.
fn refusal_message(status: reqwest::StatusCode) -> String {
    format!(
        "the server refused the request (HTTP {}). Cloud APIs usually need Auth Type Bearer Token.",
        status.as_u16()
    )
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
        // The first 401/403 any probe gets: reported if nothing succeeds.
        let mut refused: Option<reqwest::StatusCode> = None;

        // Try /models first (OpenAI-compat), then /api/tags (Ollama-compat),
        // then a plain GET to the base URL.
        for path in ["/models", "/api/tags", ""] {
            let url = format!("{}{}", self.config.base_url, path);
            if let Ok(resp) = self.apply_auth(self.client.get(&url)).send().await {
                // The plain base URL is often a public page: its 200 doesn't
                // count once an API path refused the key.
                if resp.status().is_success() && (!path.is_empty() || refused.is_none()) {
                    return Ok(true);
                }
                if refused.is_none() && auth_refused(resp.status()) {
                    refused = Some(resp.status());
                }
            }
        }

        match refused {
            Some(status) => Err(LLMError::AuthError(refusal_message(status))),
            None => Ok(false),
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
        let start = Instant::now();

        thinking::apply_prompt_hint(&mut messages, model, thinking::resolve(&params, self.options.thinking));

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
                emit_error(&app_handle, &params, &super::provider::error_text(&e));
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
            ..Default::default()
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

    #[test]
    fn only_401_and_403_count_as_a_refusal() {
        use reqwest::StatusCode;
        assert!(auth_refused(StatusCode::UNAUTHORIZED));
        assert!(auth_refused(StatusCode::FORBIDDEN));
        assert!(!auth_refused(StatusCode::NOT_FOUND));
        assert!(!auth_refused(StatusCode::INTERNAL_SERVER_ERROR));
        let message = refusal_message(StatusCode::UNAUTHORIZED);
        assert!(message.contains("refused the request (HTTP 401)"), "{message}");
        assert!(message.contains("Bearer Token"), "{message}");
    }

    #[tokio::test]
    async fn test_connection_says_the_server_refused_it_on_401() {
        let (base, _) = server(vec![("/v1/models", 401, r#"{"error":"unauthorized"}"#)]).await;
        match client(&base, CustomAuthType::None, None).test_connection().await {
            Err(LLMError::AuthError(message)) => {
                assert!(message.contains("refused the request (HTTP 401)"), "{message}");
                assert!(message.contains("Bearer Token"), "{message}");
            }
            other => panic!("expected an auth error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_connection_with_a_working_models_endpoint_is_ok() {
        let (base, _) = server(vec![("/v1/models", 200, r#"{"data":[]}"#)]).await;
        assert!(client(&base, CustomAuthType::Bearer, Some("k")).test_connection().await.unwrap());
    }

    #[tokio::test]
    async fn a_public_base_url_does_not_hide_a_refused_key() {
        let (base, _) = server(vec![("/v1/models", 401, "{}"), ("/v1", 200, "<html></html>")]).await;
        assert!(matches!(
            client(&base, CustomAuthType::None, None).test_connection().await,
            Err(LLMError::AuthError(_))
        ));
    }

    #[tokio::test]
    async fn a_working_ollama_path_still_passes_after_a_refusal() {
        let (base, _) = server(vec![("/v1/models", 401, "{}"), ("/v1/api/tags", 200, r#"{"models":[]}"#)]).await;
        assert!(client(&base, CustomAuthType::None, None).test_connection().await.unwrap());
    }

    #[tokio::test]
    async fn test_connection_without_a_refusal_stays_a_plain_false() {
        let (base, _) = server(vec![]).await;
        assert!(!client(&base, CustomAuthType::None, None).test_connection().await.unwrap());
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
    fn thinking_client(base: &str, thinking: ThinkingSetting) -> CustomClient {
        client(base, CustomAuthType::None, None).with_options(RequestOptions { thinking, extra_json: None })
    }

    #[test]
    fn custom_body_matches_openai_compatible_mapping() {
        let msgs = hi();
        let params = GenerationParams { temperature: Some(0.2), ..Default::default() };
        let body = |s, extra: Option<&str>, with| {
            let extra = thinking::parse_extra_request(extra);
            chat_completions_body(&msgs, "m", &params, s, extra.as_ref(), with)
        };
        let (b, sent) = body(ThinkingSetting::Auto, None, true);
        assert!(!sent);
        assert!(b.get("reasoning_effort").is_none());
        assert_eq!(b["temperature"], 0.2);
        assert_eq!(body(ThinkingSetting::Off, None, true).0["reasoning_effort"], "none");
        assert_eq!(body(ThinkingSetting::Low, None, true).0["reasoning_effort"], "low");
        assert_eq!(body(ThinkingSetting::High, None, true).0["reasoning_effort"], "high");
        assert!(body(ThinkingSetting::High, None, false).0.get("reasoning_effort").is_none());
        let (b, _) = body(ThinkingSetting::Auto, Some(r#"{"model":"evil","top_p":0.4}"#), true);
        assert_eq!(b["model"], "m");
        assert_eq!(b["top_p"], 0.4);
    }

    #[tokio::test]
    async fn a_refused_thinking_parameter_is_retried_once_then_remembered() {
        let (base, seen) = server(vec![(
            "/v1/chat/completions",
            400,
            r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#,
        )])
        .await;
        let c = thinking_client(&base, ThinkingSetting::Off);
        let count = || seen.lock().unwrap().iter().filter(|(p, _)| p == "/v1/chat/completions").count();

        let _ = c.open_chat_stream(&hi(), "retry-custom-model", &GenerationParams::default()).await;
        assert_eq!(count(), 2, "one try with the parameter, one without");
        assert!(thinking::is_known_unsupported("custom", &base, "retry-custom-model"));

        // The next request does not try the parameter again.
        let _ = c.open_chat_stream(&hi(), "retry-custom-model", &GenerationParams::default()).await;
        assert_eq!(count(), 3);
    }

    #[test]
    fn native_body_maps_thinking_and_merges_extra_json() {
        let msgs = hi();
        let build = |s, extra: Option<&str>, with| {
            let extra = thinking::parse_extra_request(extra);
            native_chat_body(&msgs, "m", s, extra.as_ref(), with)
        };
        let (b, sent) = build(ThinkingSetting::Auto, None, true);
        assert!(!sent);
        assert_eq!(b, json!({ "model": "m", "messages": msgs, "stream": true }), "Auto is the old body");
        assert_eq!(build(ThinkingSetting::Off, None, true).0["think"], false);
        assert_eq!(build(ThinkingSetting::High, None, true).0["think"], true);
        assert!(build(ThinkingSetting::Off, None, false).0.get("think").is_none());
        let (b, _) = build(
            ThinkingSetting::Auto,
            Some(r#"{"model":"evil","stream":false,"messages":[],"options":{"num_ctx":4096}}"#),
            true,
        );
        assert_eq!((b["model"].as_str(), b["stream"].as_bool()), (Some("m"), Some(true)));
        assert_eq!(b["messages"], json!(msgs));
        assert_eq!(b["options"]["num_ctx"], 4096);
    }

    /// A server whose /v1/chat/completions is missing (404) but whose native
    /// /v1/api/chat refuses `think` with a 400: the fallback retries without it.
    #[tokio::test]
    async fn the_api_chat_fallback_retries_without_a_refused_think_parameter() {
        let (base, seen) = server(vec![(
            "/v1/api/chat",
            400,
            r#"{"error":"\"m\" does not support thinking"}"#,
        )])
        .await;
        let c = thinking_client(&base, ThinkingSetting::Off);
        let count = || seen.lock().unwrap().iter().filter(|(p, _)| p == "/v1/api/chat").count();
        let _ = c.open_chat_stream(&hi(), "native-retry-model", &GenerationParams::default()).await;
        assert_eq!(count(), 2, "one try with think, one without");
        assert!(thinking::is_known_unsupported("custom:/api/chat", &base, "native-retry-model"));
        // The other endpoint's memory is separate: /chat/completions never rejected anything.
        assert!(!thinking::is_known_unsupported("custom", &base, "native-retry-model"));
        let _ = c.open_chat_stream(&hi(), "native-retry-model", &GenerationParams::default()).await;
        assert_eq!(count(), 3, "remembered: no more retry");
    }

    #[tokio::test]
    async fn a_new_base_url_is_not_treated_as_rejecting() {
        let (old_base, _) =
            server(vec![("/v1/chat/completions", 400, r#"{"error":"unknown field reasoning_effort"}"#)]).await;
        let c = thinking_client(&old_base, ThinkingSetting::Off);
        let _ = c.open_chat_stream(&hi(), "shared-model", &GenerationParams::default()).await;
        assert!(thinking::is_known_unsupported("custom", &old_base, "shared-model"));

        let (new_base, seen) = server(vec![("/v1/chat/completions", 200, "data: [DONE]\n\n")]).await;
        let c = thinking_client(&new_base, ThinkingSetting::Off);
        c.open_chat_stream(&hi(), "shared-model", &GenerationParams::default()).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(!thinking::is_known_unsupported("custom", &new_base, "shared-model"));
        assert!(thinking::should_send("custom", &new_base, "shared-model", ThinkingSetting::Off));
    }

    #[tokio::test]
    async fn auto_never_retries() {
        let (base, seen) = server(vec![("/v1/chat/completions", 400, r#"{"error":"reasoning_effort bad"}"#)]).await;
        let c = thinking_client(&base, ThinkingSetting::Auto);
        let _ = c.open_chat_stream(&hi(), "auto-custom-model", &GenerationParams::default()).await;
        let n = seen.lock().unwrap().iter().filter(|(p, _)| p == "/v1/chat/completions").count();
        assert_eq!(n, 1);
    }

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
