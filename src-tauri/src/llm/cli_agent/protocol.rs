//! Claude Code `stream-json` protocol: parsing stdout lines, building stdin
//! messages and classifying error text.

use serde_json::{json, Value};

/// Token/cost accounting and final text for one finished turn.
///
/// With prompt caching most of the prompt is in `cache_read_tokens` /
/// `cache_write_tokens`; `input_tokens` is only the uncached rest. All token
/// counts are per turn. The CLI's `total_cost_usd` is cumulative for its
/// process, so the session turns it into the per-turn `cost_usd`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnResult {
    pub text: String,
    pub is_error: bool,
    /// Uncached prompt tokens (`usage.input_tokens`).
    pub input_tokens: u64,
    /// Output tokens, thinking included (`usage.output_tokens`).
    pub output_tokens: u64,
    /// Prompt tokens read from the cache (`usage.cache_read_input_tokens`).
    pub cache_read_tokens: u64,
    /// Prompt tokens written to the cache (`usage.cache_creation_input_tokens`).
    pub cache_write_tokens: u64,
    /// The part of `output_tokens` spent thinking
    /// (`usage.output_tokens_details.thinking_tokens`).
    pub thinking_tokens: u64,
    /// This turn's cost estimate. Set by the session from `total_cost_usd`
    /// (0 straight out of [`parse_line`]).
    pub cost_usd: f64,
    /// `total_cost_usd` as reported: cumulative for the CLI process.
    pub total_cost_usd: f64,
    /// The CLI's own duration of this turn (`duration_ms`).
    pub duration_ms: u64,
    /// Wall time of the `ask` (set by the manager; 0 elsewhere).
    pub latency_ms: u64,
    /// From the `ask` until its first text arrived (set by the manager).
    pub first_text_ms: Option<u64>,
}

impl TurnResult {
    /// Every prompt token of the turn: uncached, cache reads and cache writes.
    pub fn prompt_tokens(&self) -> u64 {
        self.input_tokens + self.cache_read_tokens + self.cache_write_tokens
    }
}

/// One tool call the model made (a block of an `assistant` line).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolUse {
    /// The block's `id`, which its `tool_result` names.
    pub id: String,
    /// `Read`, `Grep`, `mcp__<key>__<tool>`, ...
    pub name: String,
    pub input: Value,
}

/// How one tool call ended (a `tool_result` block of a `user` line).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub tool_use_id: String,
    /// The call failed or was refused (not allowed, timed out, a server error).
    pub is_error: bool,
}

/// One MCP server in `system/init`: only its name and status (`connected`,
/// `failed`, `needs-auth`, `pending`). No error text, no tool count.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerState {
    pub name: String,
    pub status: String,
}

/// One parsed stdout line.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    /// `tools` lists every tool name (`mcp__<key>__<tool>` for MCP tools).
    Init {
        session_id: String,
        model: String,
        tools: Vec<String>,
        mcp_servers: Vec<McpServerState>,
    },
    /// The `tool_use` blocks of one `assistant` line (the CLI sends one line
    /// per content block).
    ToolUses(Vec<ToolUse>),
    /// The `tool_result` blocks of one `user` line.
    ToolResults(Vec<ToolResult>),
    TextDelta(String),
    /// The model is thinking (extended thinking) before it answers.
    ThinkingDelta,
    TurnComplete(TurnResult),
    /// Any event NexQ does not act on (status, assistant, user, other deltas...).
    Other,
}

/// Parse one stdout line of `--output-format stream-json`.
/// Valid JSON of an unrecognised shape and blank lines yield `Other`; invalid
/// (e.g. truncated) JSON is an error the caller should log and skip.
pub fn parse_line(line: &str) -> Result<AgentEvent, String> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(AgentEvent::Other);
    }
    let v: Value = serde_json::from_str(line)
        .map_err(|e| format!("invalid stream-json line: {e}"))?;
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let sub = v.get("subtype").and_then(Value::as_str).unwrap_or("");
    match (kind, sub) {
        ("system", "init") => Ok(AgentEvent::Init {
            session_id: str_field(&v, "session_id"),
            model: str_field(&v, "model"),
            tools: v["tools"]
                .as_array()
                .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            mcp_servers: v["mcp_servers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|s| McpServerState {
                            name: str_field(s, "name"),
                            status: str_field(s, "status"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }),
        ("assistant", _) => {
            let uses: Vec<ToolUse> = v["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "tool_use")
                        .map(|b| ToolUse {
                            id: str_field(b, "id"),
                            name: str_field(b, "name"),
                            input: b.get("input").cloned().unwrap_or(Value::Null),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(if uses.is_empty() { AgentEvent::Other } else { AgentEvent::ToolUses(uses) })
        }
        ("user", _) => {
            let results: Vec<ToolResult> = v["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "tool_result")
                        .map(|b| ToolResult {
                            tool_use_id: str_field(b, "tool_use_id"),
                            is_error: b["is_error"].as_bool().unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(if results.is_empty() { AgentEvent::Other } else { AgentEvent::ToolResults(results) })
        }
        ("stream_event", _) => {
            let delta = &v["event"]["delta"];
            if v["event"]["type"] == "content_block_delta" {
                if delta["type"] == "text_delta" {
                    if let Some(t) = delta["text"].as_str() {
                        return Ok(AgentEvent::TextDelta(t.to_string()));
                    }
                } else if delta["type"] == "thinking_delta" {
                    return Ok(AgentEvent::ThinkingDelta);
                }
            }
            Ok(AgentEvent::Other)
        }
        ("result", _) => {
            let usage = &v["usage"];
            let count = |field: &Value| field.as_u64().unwrap_or(0);
            Ok(AgentEvent::TurnComplete(TurnResult {
                text: result_text(&v),
                is_error: v["is_error"].as_bool().unwrap_or(false),
                input_tokens: count(&usage["input_tokens"]),
                output_tokens: count(&usage["output_tokens"]),
                cache_read_tokens: count(&usage["cache_read_input_tokens"]),
                cache_write_tokens: count(&usage["cache_creation_input_tokens"]),
                thinking_tokens: count(&usage["output_tokens_details"]["thinking_tokens"]),
                total_cost_usd: v["total_cost_usd"].as_f64().unwrap_or(0.0),
                duration_ms: count(&v["duration_ms"]),
                ..Default::default()
            }))
        }
        _ => Ok(AgentEvent::Other),
    }
}

/// `result` text, or for error results that carry none (e.g. subtypes
/// `error_during_execution`, `error_max_turns`) the joined `errors` array,
/// falling back to the subtype so the failure stays classifiable.
fn result_text(v: &Value) -> String {
    if let Some(t) = v.get("result").and_then(Value::as_str) {
        return t.to_string();
    }
    if !v["is_error"].as_bool().unwrap_or(false) {
        return String::new();
    }
    let errors: Vec<String> = v["errors"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if errors.is_empty() {
        str_field(v, "subtype")
    } else {
        errors.join("; ")
    }
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// One image sent with a question (pasted into Ask). Mirrors the TypeScript
/// `ImageAttachment` in `src/lib/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ImageAttachment {
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: String,
    /// Base64 of the file, without a `data:` prefix.
    pub data: String,
}

/// Most images one question can carry. Keep in step with `MAX_IMAGES` in
/// `src/lib/imageAttachments.ts`.
pub const MAX_IMAGES: usize = 3;
/// Longest base64 body accepted for one image: the API's 5 MB limit
/// (5_242_880). The frontend downsizes pasted images well below it
/// (`src/lib/imageAttachments.ts`); this is the safety net.
pub const MAX_IMAGE_BASE64_LEN: usize = 5_242_880;
/// Image types the Claude API takes. Keep in step with `ALLOWED_IMAGE_TYPES`
/// in `src/lib/imageAttachments.ts`.
pub const ALLOWED_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Checks the images pasted into Ask before anything is sent: the frontend
/// checks the same limits, but the backend never trusts it.
pub fn validate_images(images: &[ImageAttachment]) -> Result<(), String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("You can attach up to {MAX_IMAGES} images"));
    }
    for image in images {
        if !ALLOWED_IMAGE_TYPES.contains(&image.media_type.as_str()) {
            return Err("Only PNG, JPEG, GIF and WebP images can be attached".to_string());
        }
        if image.data.is_empty() {
            return Err("An attached image is empty".to_string());
        }
        if image.data.len() > MAX_IMAGE_BASE64_LEN {
            return Err("An attached image is larger than 5 MB".to_string());
        }
    }
    Ok(())
}

/// Build one stdin JSON line (no trailing newline). With `query == false` the
/// message is appended to the session context without triggering a model call.
pub fn user_message(text: &str, query: bool) -> String {
    user_message_with_images(text, query, &[])
}

/// [`user_message`] with images. Without images `content` stays a plain string;
/// with them it is a list of blocks: the images first, then the text.
pub fn user_message_with_images(text: &str, query: bool, images: &[ImageAttachment]) -> String {
    let content = if images.is_empty() {
        Value::String(text.to_string())
    } else {
        let mut blocks: Vec<Value> = images
            .iter()
            .map(|image| {
                json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                })
            })
            .collect();
        blocks.push(json!({ "type": "text", "text": text }));
        Value::Array(blocks)
    };
    let mut msg = json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null,
    });
    if !query {
        msg["shouldQuery"] = Value::Bool(false);
    }
    msg.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentErrorKind {
    NotInstalled,
    NotLoggedIn,
    RateLimited,
    /// The conversation no longer fits the model's context window.
    ContextOverflow,
    Crashed,
    Other,
}

impl AgentErrorKind {
    /// Stable snake_case name, mirrored by the frontend (`error_kind`).
    pub fn as_str(self) -> &'static str {
        match self {
            AgentErrorKind::NotInstalled => "not_installed",
            AgentErrorKind::NotLoggedIn => "not_logged_in",
            AgentErrorKind::RateLimited => "rate_limited",
            AgentErrorKind::ContextOverflow => "context_overflow",
            AgentErrorKind::Crashed => "crashed",
            AgentErrorKind::Other => "other",
        }
    }
}

/// Map error text (a failed result, stderr, or spawn error) to a coarse kind.
pub fn classify_error(text: &str) -> AgentErrorKind {
    let t = text.to_lowercase();
    if t.contains("not logged in") || t.contains("/login") || t.contains("please log in") {
        AgentErrorKind::NotLoggedIn
    } else if t.contains("rate limit")
        || t.contains("usage limit")
        || (t.contains("limit reached") && !t.contains("context"))
        || t.contains("too many requests")
        || t.contains("per minute")
    {
        // Before the context patterns: "too many tokens per minute" is a rate limit.
        AgentErrorKind::RateLimited
    } else if t.contains("prompt is too long")
        || t.contains("input is too long")
        || t.contains("context length")
        || t.contains("context window")
        || t.contains("context limit")
        || t.contains("maximum context")
        || t.contains("too many tokens")
    {
        AgentErrorKind::ContextOverflow
    } else if t.contains("not installed")
        || t.contains("program not found")
        || t.contains("cannot find the file")
        || t.contains("(os error 2)")
    {
        AgentErrorKind::NotInstalled
    } else if t.contains("exited") || t.contains("crashed") || t.contains("broken pipe") {
        AgentErrorKind::Crashed
    } else {
        AgentErrorKind::Other
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn parse_init() {
        let l = r#"{"type":"system","subtype":"init","session_id":"s","model":"claude-haiku-4-5-20251001","tools":[],"mcp_servers":[]}"#;
        assert_eq!(
            parse_line(l).unwrap(),
            AgentEvent::Init {
                session_id: "s".into(),
                model: "claude-haiku-4-5-20251001".into(),
                tools: vec![],
                mcp_servers: vec![],
            }
        );
    }

    #[test]
    fn parse_init_lists_tools_and_mcp_servers() {
        let AgentEvent::Init { tools, mcp_servers, .. } =
            parse_line(include_str!("testdata/init_with_mcp.json")).unwrap()
        else {
            panic!("not an init");
        };
        assert!(!tools.is_empty());
        assert!(tools.iter().any(|t| t.starts_with("mcp__My-Server__")), "{tools:?}");
        assert_eq!(
            mcp_servers,
            vec![McpServerState { name: "My-Server".into(), status: "connected".into() }]
        );
    }

    #[test]
    fn parse_init_with_a_failed_server() {
        let AgentEvent::Init { mcp_servers, .. } =
            parse_line(include_str!("testdata/init_mcp_failed.json")).unwrap()
        else {
            panic!("not an init");
        };
        assert_eq!(mcp_servers[0].status, "failed");
        assert_eq!(mcp_servers[0].name, "broken");
    }

    #[test]
    fn parse_assistant_tool_use() {
        let AgentEvent::ToolUses(uses) =
            parse_line(include_str!("testdata/assistant_tool_use.json")).unwrap()
        else {
            panic!("not tool uses");
        };
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].id, "toolu_PLACEHOLDER");
        assert_eq!(uses[0].name, "mcp__My-Server__get_note");
        assert_eq!(uses[0].input["name"], "x");
    }

    #[test]
    fn parse_tool_results_with_their_outcome() {
        let ok = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"x"}]}}"#;
        assert_eq!(
            parse_line(ok).unwrap(),
            AgentEvent::ToolResults(vec![ToolResult { tool_use_id: "toolu_1".into(), is_error: false }])
        );
        let denied = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"denied","is_error":true,"tool_use_id":"toolu_2"}]}}"#;
        assert_eq!(
            parse_line(denied).unwrap(),
            AgentEvent::ToolResults(vec![ToolResult { tool_use_id: "toolu_2".into(), is_error: true }])
        );
        // A plain user message is nothing to act on.
        let text = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(parse_line(text).unwrap(), AgentEvent::Other);
    }

    #[test]
    fn parse_assistant_text_only_is_other() {
        let l = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(parse_line(l).unwrap(), AgentEvent::Other);
    }

    #[test]
    fn parse_text_delta() {
        let l = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#;
        assert_eq!(parse_line(l).unwrap(), AgentEvent::TextDelta("Hel".into()));
    }

    #[test]
    fn parse_result() {
        let l = r#"{"type":"result","subtype":"success","is_error":false,"result":"OK","total_cost_usd":0.0012,"duration_ms":900,"usage":{"input_tokens":612,"output_tokens":20,"cache_read_input_tokens":0}}"#;
        assert_eq!(
            parse_line(l).unwrap(),
            AgentEvent::TurnComplete(TurnResult {
                text: "OK".into(),
                is_error: false,
                input_tokens: 612,
                output_tokens: 20,
                cache_read_tokens: 0,
                total_cost_usd: 0.0012,
                duration_ms: 900,
                ..Default::default()
            })
        );
    }

    /// A real `result` line of CLI 2.1.288 (Haiku, prompt caching, thinking).
    pub(crate) const REAL_RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":4199,"duration_api_ms":10703,"num_turns":1,"result":"What share of them enroll?","session_id":"s","total_cost_usd":0.01933,"usage":{"input_tokens":10,"cache_creation_input_tokens":4190,"cache_read_input_tokens":0,"output_tokens":189,"output_tokens_details":{"thinking_tokens":151},"server_tool_use":{"web_search_requests":0},"service_tier":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":7250,"outputTokens":740,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.01933}}}"#;

    #[test]
    fn parse_real_result_counts_cache_writes_and_thinking() {
        match parse_line(REAL_RESULT).unwrap() {
            AgentEvent::TurnComplete(r) => {
                assert_eq!(r.input_tokens, 10);
                assert_eq!(r.cache_write_tokens, 4190);
                assert_eq!(r.cache_read_tokens, 0);
                assert_eq!(r.prompt_tokens(), 4200);
                assert_eq!(r.output_tokens, 189);
                assert_eq!(r.thinking_tokens, 151);
                // Cumulative per process (the session derives the turn's
                // cost); the cumulative `modelUsage` is ignored.
                assert_eq!(r.total_cost_usd, 0.01933);
                assert_eq!(r.cost_usd, 0.0);
                assert_eq!(r.duration_ms, 4199);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parse_thinking_delta() {
        let l = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user wants"}},"session_id":"s"}"#;
        assert_eq!(parse_line(l).unwrap(), AgentEvent::ThinkingDelta);
        let sig = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"x"}}}"#;
        assert_eq!(parse_line(sig).unwrap(), AgentEvent::Other);
        let tokens = r#"{"type":"system","subtype":"thinking_tokens","tokens":151}"#;
        assert_eq!(parse_line(tokens).unwrap(), AgentEvent::Other);
    }

    #[test]
    fn parse_unknown_is_other() {
        assert_eq!(parse_line(r#"{"type":"system","subtype":"status"}"#).unwrap(), AgentEvent::Other);
        assert_eq!(parse_line(r#"{"type":"assistant","message":{}}"#).unwrap(), AgentEvent::Other);
        let non_text = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta"}}}"#;
        assert_eq!(parse_line(non_text).unwrap(), AgentEvent::Other);
        assert!(parse_line("not json").is_err());
    }

    #[test]
    fn user_message_query_false_has_should_query() {
        let v: Value = serde_json::from_str(&user_message("x", false)).unwrap();
        assert_eq!(v["shouldQuery"], false);
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"], "x");
        assert!(!user_message("x", false).contains('\n'));
        let q: Value = serde_json::from_str(&user_message("x", true)).unwrap();
        assert!(q.get("shouldQuery").is_none());
    }

    #[test]
    fn user_message_with_images_sends_image_blocks_before_the_text() {
        let images = [
            ImageAttachment { media_type: "image/png".into(), data: "AAAA".into() },
            ImageAttachment { media_type: "image/jpeg".into(), data: "BBBB".into() },
        ];
        let line = user_message_with_images("What is this?", true, &images);
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        let blocks = v["message"]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["type"], "base64");
        assert_eq!(blocks[0]["source"]["media_type"], "image/png");
        assert_eq!(blocks[0]["source"]["data"], "AAAA");
        assert_eq!(blocks[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(blocks[2], json!({ "type": "text", "text": "What is this?" }));
        assert!(v.get("shouldQuery").is_none());
    }

    #[test]
    fn validate_images_enforces_count_type_and_size() {
        let png = |data: &str| ImageAttachment { media_type: "image/png".into(), data: data.into() };
        assert!(validate_images(&[]).is_ok());
        assert!(validate_images(&[png("AAAA"), png("AAAA"), png("AAAA")]).is_ok());
        assert!(validate_images(&[png("A"), png("A"), png("A"), png("A")])
            .unwrap_err()
            .contains("up to 3"));
        let bmp = ImageAttachment { media_type: "image/bmp".into(), data: "AAAA".into() };
        assert!(validate_images(&[bmp]).unwrap_err().contains("PNG, JPEG"));
        let svg = ImageAttachment { media_type: "image/svg+xml".into(), data: "AAAA".into() };
        assert!(validate_images(&[svg]).is_err());
        assert!(validate_images(&[png("")]).unwrap_err().contains("empty"));
        let at_limit = "A".repeat(MAX_IMAGE_BASE64_LEN);
        assert!(validate_images(&[png(&at_limit)]).is_ok());
        let over = "A".repeat(MAX_IMAGE_BASE64_LEN + 1);
        assert!(validate_images(&[png(&over)]).unwrap_err().contains("5 MB"));
    }

    #[test]
    fn user_message_without_images_is_unchanged() {
        let plain = user_message_with_images("x", true, &[]);
        assert_eq!(plain, user_message("x", true));
        let v: Value = serde_json::from_str(&plain).unwrap();
        assert_eq!(v["message"]["content"], "x");
    }

    #[test]
    fn parse_blank_whitespace_and_truncated() {
        assert_eq!(parse_line("").unwrap(), AgentEvent::Other);
        assert_eq!(parse_line("  
").unwrap(), AgentEvent::Other);
        assert!(parse_line(r#"{"type":"stream_event","event":{"type":"content_blo"#).is_err());
    }

    #[test]
    fn parse_error_result_without_result_field() {
        let l = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["API Error: Rate limit reached","retry later"]}"#;
        match parse_line(l).unwrap() {
            AgentEvent::TurnComplete(r) => {
                assert!(r.is_error);
                assert_eq!(r.text, "API Error: Rate limit reached; retry later");
                assert_eq!(classify_error(&r.text), AgentErrorKind::RateLimited);
            }
            other => panic!("unexpected {other:?}"),
        }
        let bare = r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        match parse_line(bare).unwrap() {
            AgentEvent::TurnComplete(r) => assert_eq!(r.text, "error_max_turns"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn classify_os_error_2_precisely() {
        assert_eq!(
            classify_error("program not found: The system cannot find the file specified. (os error 2)"),
            AgentErrorKind::NotInstalled
        );
        assert_eq!(classify_error("The directory name is invalid. (os error 267)"), AgentErrorKind::Other);
        assert_eq!(classify_error("Access is denied. (os error 5)"), AgentErrorKind::Other);
        assert_eq!(classify_error("pipe error (os error 232)"), AgentErrorKind::Other);
    }

    #[test]
    fn classify_not_logged_in() {
        assert_eq!(classify_error("Not logged in · Please run /login"), AgentErrorKind::NotLoggedIn);
    }

    #[test]
    fn error_kind_names_are_snake_case() {
        assert_eq!(AgentErrorKind::RateLimited.as_str(), "rate_limited");
        assert_eq!(AgentErrorKind::NotLoggedIn.as_str(), "not_logged_in");
        assert_eq!(AgentErrorKind::NotInstalled.as_str(), "not_installed");
        assert_eq!(AgentErrorKind::ContextOverflow.as_str(), "context_overflow");
        assert_eq!(AgentErrorKind::Crashed.as_str(), "crashed");
        assert_eq!(AgentErrorKind::Other.as_str(), "other");
    }

    #[test]
    fn classify_rate_limit() {
        assert_eq!(classify_error("You hit the Rate Limit"), AgentErrorKind::RateLimited);
        assert_eq!(classify_error("5-hour usage limit reached"), AgentErrorKind::RateLimited);
        assert_eq!(classify_error("boom"), AgentErrorKind::Other);
    }

    #[test]
    fn classify_context_overflow() {
        for text in [
            "Prompt is too long",
            "input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000",
            "This model's maximum context length is 200000 tokens",
            "Context window exceeded",
            "Context limit reached",
        ] {
            assert_eq!(classify_error(text), AgentErrorKind::ContextOverflow, "{text}");
        }
        for text in [
            "Too many tokens per minute",
            "rate limit exceeded: too many tokens",
            "429 Too Many Requests",
        ] {
            assert_eq!(classify_error(text), AgentErrorKind::RateLimited, "{text}");
        }
    }
}
