use super::*;
use crate::sources::config::McpTool;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn facts(allowed: bool, read_only: Option<bool>, destructive: Option<bool>) -> ToolFacts {
    ToolFacts { allowed, read_only, destructive }
}

fn server(key: &str, tools: &[(&str, bool, Option<bool>, Option<bool>)]) -> McpServer {
    McpServer {
        id: key.into(),
        key: key.into(),
        enabled: true,
        tools: tools
            .iter()
            .map(|(n, allowed, ro, d)| McpTool {
                name: (*n).into(),
                full_name: format!("mcp__{key}__{n}"),
                allowed: *allowed,
                read_only_hint: *ro,
                destructive_hint: *d,
            })
            .collect(),
        ..Default::default()
    }
}

// ---- the pure policy ------------------------------------------------------

#[test]
fn a_tool_runs_by_itself_only_when_allowed_read_only_and_not_write_like() {
    // allowed + read-only + read-like name: runs.
    assert_eq!(mcp_verdict(&facts(true, Some(true), None), "kb_search"), ToolVerdict::Allow);
    assert_eq!(mcp_verdict(&facts(true, Some(true), Some(false)), "get_note"), ToolVerdict::Allow);
    // Read-only mark present but the name says write: asks.
    assert_eq!(mcp_verdict(&facts(true, Some(true), None), "send_mail"), ToolVerdict::Ask);
    assert_eq!(mcp_verdict(&facts(true, Some(true), None), "deleteNote"), ToolVerdict::Ask);
    // No mark, or marked not read-only: asks, however harmless the name.
    assert_eq!(mcp_verdict(&facts(true, None, None), "kb_search"), ToolVerdict::Ask);
    assert_eq!(mcp_verdict(&facts(true, Some(false), None), "kb_search"), ToolVerdict::Ask);
    // Destructive wins over read-only.
    assert_eq!(mcp_verdict(&facts(true, Some(true), Some(true)), "kb_search"), ToolVerdict::Ask);
    // Not allowed by the user: denied, whatever the server says.
    for ro in [Some(true), Some(false), None] {
        assert!(matches!(mcp_verdict(&facts(false, ro, None), "kb_search"), ToolVerdict::Deny(_)));
    }
}

#[test]
fn write_like_names() {
    for w in ["send_mail", "sendMail", "send-mail", "create_event", "delete_note", "update_task", "run_query", "execute_sql",
              "set_status", "add_comment", "mark_read", "post_message", "upload_file", "remove_item", "save_draft", "reply_all"] {
        assert!(is_write_like(w), "{w}");
    }
    for r in ["kb_search", "kb_read", "get_note", "list_notes", "read_note", "search_notes", "get_settings", "describe_table", "whoami", "fetch_page"] {
        assert!(!is_write_like(r), "{r}");
    }
}

#[test]
fn built_in_reads_are_confined_to_the_scope_folders_and_everything_else_is_denied() {
    let dirs = vec![PathBuf::from("D:\\NexQ\\chat-transcripts\\1-abc")];
    let v = |tool: &str, input: Value| builtin_verdict(tool, &input, &dirs);
    assert_eq!(v("Read", json!({"file_path": "D:\\NexQ\\chat-transcripts\\1-abc\\m1.txt"})), ToolVerdict::Allow);
    assert_eq!(v("Read", json!({"file_path": "d:/nexq/CHAT-TRANSCRIPTS/1-abc/sub/m1.txt"})), ToolVerdict::Allow, "separators and case");
    assert_eq!(v("Grep", json!({"pattern": "x", "path": "D:\\NexQ\\chat-transcripts\\1-abc"})), ToolVerdict::Allow);
    assert_eq!(v("Glob", json!({"pattern": "*.txt", "path": "D:\\NexQ\\chat-transcripts\\1-abc"})), ToolVerdict::Allow);
    for bad in [
        "D:\\NexQ\\chat-transcripts\\1-abc\\..\\other\\a.txt",
        "D:\\NexQ\\chat-transcripts\\1-abcd\\a.txt",
        "D:\\Users\\me\\.ssh\\id_rsa",
        "C:\\Windows\\win.ini",
        "relative\\a.txt",
        "..\\a.txt",
        "",
    ] {
        assert!(matches!(v("Read", json!({"file_path": bad})), ToolVerdict::Deny(_)), "{bad}");
    }
    // No path (Grep/Glob would use the cwd), or a pattern that climbs out.
    assert!(matches!(v("Grep", json!({"pattern": "x"})), ToolVerdict::Deny(_)));
    assert!(matches!(v("Glob", json!({"pattern": "../*", "path": "D:\\NexQ\\chat-transcripts\\1-abc"})), ToolVerdict::Deny(_)));
    assert!(matches!(v("Glob", json!({"pattern": "C:\\*", "path": "D:\\NexQ\\chat-transcripts\\1-abc"})), ToolVerdict::Deny(_)));
    // Shell, edit, web and everything unknown: never.
    for t in ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "PowerShell", "Anything"] {
        assert!(matches!(v(t, json!({"file_path": "D:\\NexQ\\chat-transcripts\\1-abc\\a", "command": "dir"})), ToolVerdict::Deny(_)), "{t}");
    }
}

#[test]
fn the_policy_decides_by_the_agents_tool_name() {
    let policy = ApprovalPolicy::from_servers(
        &[
            server("mira", &[("kb_search", true, Some(true), None), ("send_mail", true, Some(true), None), ("kb_read", false, Some(true), None), ("note", true, None, None)]),
            server("a_b", &[("x", true, Some(true), Some(false))]),
        ],
        vec![PathBuf::from("D:\\scope")],
    );
    let v = |name: &str| policy.verdict_for_name(name, &json!({}));
    assert_eq!(v("mcp__mira__kb_search"), ToolVerdict::Allow);
    assert_eq!(v("mcp__mira__send_mail"), ToolVerdict::Ask);
    assert_eq!(v("mcp__mira__note"), ToolVerdict::Ask, "no hint: ask");
    assert!(matches!(v("mcp__mira__kb_read"), ToolVerdict::Deny(_)), "not allowed by the user");
    assert!(matches!(v("mcp__mira__unknown_tool"), ToolVerdict::Deny(_)));
    assert!(matches!(v("mcp__other__kb_search"), ToolVerdict::Deny(_)));
    assert_eq!(v("mcp_a_b_x"), ToolVerdict::Allow, "the other spelling of a name");
    assert!(matches!(v("Bash"), ToolVerdict::Deny(_)));
    assert_eq!(
        policy.verdict_for_name("Read", &json!({"file_path": "D:\\scope\\a.txt"})),
        ToolVerdict::Allow
    );
    assert_eq!(policy.auto_run_tools(), vec!["mcp__a_b__x", "mcp__mira__kb_search"]);
    assert_eq!(policy.ask_tools(), vec!["mcp__mira__note", "mcp__mira__send_mail"]);
}

#[test]
fn a_cli_that_cannot_ask_gets_the_asking_tools_switched_off_up_front() {
    let policy = ApprovalPolicy::from_servers(
        &[server("mira", &[("kb_search", true, Some(true), None), ("send_mail", true, None, None)])],
        vec![],
    );
    let launch = || SourcesLaunch {
        allowed_tools: vec!["mcp__mira__kb_search".into(), "mcp__mira__send_mail".into(), "Read".into()],
        ..Default::default()
    };
    let mut ok = launch();
    policy.adjust_launch(&mut ok, &ApprovalSupport::Supported);
    assert_eq!(ok, launch(), "with support the launch is left as it is");
    let mut off = launch();
    policy.adjust_launch(&mut off, &ApprovalSupport::Unsupported("old".into()));
    assert_eq!(off.allowed_tools, vec!["mcp__mira__kb_search", "Read"]);
    assert_eq!(off.disallowed_tools, vec!["mcp__mira__send_mail"]);
}

#[test]
fn claude_support_follows_the_version_that_was_checked() {
    assert_eq!(claude_support_for_version(Some((2, 1, 328))), ApprovalSupport::Supported);
    assert_eq!(claude_support_for_version(Some((2, 1, 330))), ApprovalSupport::Supported);
    assert_eq!(claude_support_for_version(Some((3, 0, 0))), ApprovalSupport::Supported);
    assert!(matches!(claude_support_for_version(Some((2, 1, 327))), ApprovalSupport::Unsupported(r) if r.contains("2.1.328")));
    assert!(matches!(claude_support_for_version(None), ApprovalSupport::Unsupported(_)));
}

#[test]
fn shown_arguments_hide_secrets_by_key_name_and_are_shown_whole() {
    let args = json!({"query": "falcon", "api_key": "sk-123", "nested": {"Authorization": "Bearer x", "ok": 1, "list": [{"password": "p"}]}});
    let text = display_args(&args).unwrap();
    assert!(text.contains("falcon") && text.contains("\"ok\": 1"));
    assert!(!text.contains("sk-123") && !text.contains("Bearer x") && !text.contains("\"p\""));
    assert_eq!(text.matches(HIDDEN).count(), 3);
    assert!(HIDDEN.contains("looks like a key"));
    // Long but readable arguments are shown whole.
    let long = json!({"body": "x".repeat(50_000)});
    assert!(display_args(&long).unwrap().contains(&"x".repeat(50_000)));
    assert!(display_args(&json!({"body": "x".repeat(MAX_ARGS_BYTES + 1)})).is_none());
    // Only known secret names are hidden; nothing else.
    for secret in ["X-Api-Key", "accessToken", "refresh_token", "password", "Authorization", "client_secret", "api_key", "apiKey", "private_key", "Cookie"] {
        assert!(is_secret_key(secret), "{secret}");
    }
    for plain in ["query", "max_tokens", "author", "keyword", "key", "token_count", "monkey", "session_id", "title", "authorName"] {
        assert!(!is_secret_key(plain), "{plain}");
    }
}

#[test]
fn invisible_and_direction_override_characters_are_written_out() {
    let text = display_args(&json!({"path": "a\u{202E}txt.exe", "n": "x\u{200B}y", "bom": "\u{FEFF}z", "ok": "plain é 漢"})).unwrap();
    assert!(text.contains("a\\u{202E}txt.exe") && text.contains("x\\u{200B}y") && text.contains("\\u{FEFF}z"), "{text}");
    assert!(!text.contains('\u{202E}') && !text.contains('\u{200B}') && !text.contains('\u{FEFF}'));
    assert!(text.contains("plain é 漢"), "ordinary text is untouched");
    assert!(!display_args(&json!({"k\u{202E}ey": 1})).unwrap().contains('\u{202E}'), "keys too");
}

#[tokio::test]
async fn a_call_too_long_to_show_is_refused_with_a_reason_and_never_asked() {
    let (b, seen) = broker(Duration::from_secs(5));
    let mut r = request("c1", "r1");
    r.args = json!({"body": "x".repeat(MAX_ARGS_BYTES + 1)});
    assert!(!b.ask(r).await);
    assert!(questions(&seen).is_empty());
    let notes = seen.lock().unwrap();
    assert!(matches!(&notes[0], ApprovalNotice::Refused { reason, tool, .. } if reason.contains("100 KB") && tool == "send_mail"));
    assert_eq!(b.pending("c1"), 0);
}

// ---- the broker -----------------------------------------------------------

type Seen = Arc<Mutex<Vec<ApprovalNotice>>>;

fn broker(timeout: Duration) -> (Arc<WorkspaceApprovals>, Seen) {
    let b = Arc::new(WorkspaceApprovals::new().with_timeout(timeout));
    let seen: Seen = Arc::default();
    let target = seen.clone();
    b.set_emitter(Arc::new(move |n| target.lock().unwrap().push(n)));
    (b, seen)
}

fn request(chat: &str, rid: &str) -> ApprovalRequest {
    ApprovalRequest {
        chat_id: chat.into(),
        request_id: rid.into(),
        server: "mira".into(),
        tool: "send_mail".into(),
        args: json!({"to": "a@b.c", "token": "SECRET"}),
    }
}

async fn first_question(seen: &Seen) -> ApprovalEvent {
    for _ in 0..200 {
        let found = seen.lock().unwrap().iter().find_map(|n| match n {
            ApprovalNotice::Request(e) => Some(e.clone()),
            _ => None,
        });
        if let Some(e) = found {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no question was asked");
}

fn questions(seen: &Seen) -> Vec<ApprovalEvent> {
    seen.lock().unwrap().iter().filter_map(|n| if let ApprovalNotice::Request(e) = n { Some(e.clone()) } else { None }).collect()
}

#[tokio::test]
async fn a_question_is_shown_and_only_the_answer_command_can_allow_it() {
    let (b, seen) = broker(Duration::from_secs(5));
    let task = tokio::spawn({
        let b = b.clone();
        async move { b.ask(request("c1", "r1")).await }
    });
    let ev = first_question(&seen).await;
    assert_eq!((ev.chat_id.as_str(), ev.request_id.as_str(), ev.server.as_str(), ev.tool.as_str()), ("c1", "r1", "mira", "send_mail"));
    assert!(ev.args.contains("a@b.c") && !ev.args.contains("SECRET") && ev.args.contains(HIDDEN));
    assert!(!ev.truncated);
    assert!(!task.is_finished());
    // Other chats' ids and made-up ids do nothing.
    assert!(!b.answer("not-an-id", true));
    assert!(!task.is_finished());
    assert!(b.answer(&ev.approval_id, true));
    assert!(task.await.unwrap());
    // Idempotent: a second click, or a late one, changes nothing.
    assert!(!b.answer(&ev.approval_id, false));
    assert_eq!(b.pending("c1"), 0);
    assert!(seen.lock().unwrap().iter().any(|n| matches!(n, ApprovalNotice::Closed { reason: "answered", .. })));
}

#[tokio::test]
async fn deny_is_deny_and_a_timeout_refuses() {
    let (b, seen) = broker(Duration::from_secs(5));
    let t = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    let ev = first_question(&seen).await;
    b.answer(&ev.approval_id, false);
    assert!(!t.await.unwrap());

    let (b, seen) = broker(Duration::from_millis(60));
    assert!(!b.ask(request("c1", "r1")).await, "nobody answered");
    assert!(seen.lock().unwrap().iter().any(|n| matches!(n, ApprovalNotice::Closed { reason: "timed_out", .. })));
    assert_eq!(b.pending("c1"), 0);
    // The answer that comes after the timeout is ignored.
    let ev = questions(&seen).remove(0);
    assert!(!b.answer(&ev.approval_id, true));
}

#[tokio::test]
async fn one_question_at_a_time_per_chat_but_chats_do_not_wait_for_each_other() {
    let (b, seen) = broker(Duration::from_secs(5));
    let t1 = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    let first = first_question(&seen).await;
    let t2 = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r2")).await } });
    let other = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c2", "r9")).await } });
    tokio::time::sleep(Duration::from_millis(60)).await;
    let asked: Vec<_> = questions(&seen).iter().map(|e| e.request_id.clone()).collect();
    assert!(asked.contains(&"r1".to_string()) && asked.contains(&"r9".to_string()), "{asked:?}");
    assert!(!asked.contains(&"r2".to_string()), "the second question of c1 waits its turn");
    assert_eq!(b.pending("c1"), 2);
    b.answer(&first.approval_id, true);
    assert!(t1.await.unwrap());
    let second = loop {
        if let Some(e) = questions(&seen).into_iter().find(|e| e.request_id == "r2") {
            break e;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    b.answer(&second.approval_id, false);
    assert!(!t2.await.unwrap());
    let c2 = questions(&seen).into_iter().find(|e| e.request_id == "r9").unwrap();
    b.answer(&c2.approval_id, true);
    assert!(other.await.unwrap());
}

#[tokio::test]
async fn closing_or_cancelling_a_chat_refuses_what_is_open_and_what_is_queued() {
    let (b, seen) = broker(Duration::from_secs(5));
    let t1 = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    first_question(&seen).await;
    let queued = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r2")).await } });
    tokio::time::sleep(Duration::from_millis(30)).await;
    b.deny_chat("c1");
    assert!(!t1.await.unwrap());
    assert!(!queued.await.unwrap(), "a queued question never reaches the user");
    assert_eq!(questions(&seen).len(), 1);
    assert_eq!(b.pending("c1"), 0);
    assert!(seen.lock().unwrap().iter().any(|n| matches!(n, ApprovalNotice::Closed { reason: "cancelled", .. })));
    // Later questions work again.
    let t3 = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r3")).await } });
    let again = loop {
        if let Some(e) = questions(&seen).into_iter().find(|e| e.request_id == "r3") {
            break e;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    b.answer(&again.approval_id, true);
    assert!(t3.await.unwrap());
}

#[tokio::test]
async fn the_cli_withdrawing_a_call_refuses_just_that_question() {
    let (b, seen) = broker(Duration::from_secs(5));
    let t = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    first_question(&seen).await;
    b.deny_request("c1", "other");
    assert!(!t.is_finished());
    b.deny_request("c1", "r1");
    assert!(!t.await.unwrap());
}

#[tokio::test]
async fn no_ui_and_app_exit_both_mean_no() {
    let b = WorkspaceApprovals::new();
    assert!(!b.ask(request("c1", "r1")).await, "nobody to ask");

    let (b, seen) = broker(Duration::from_secs(5));
    let t = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    first_question(&seen).await;
    b.shut_down();
    assert!(!t.await.unwrap());
    assert!(!b.ask(request("c1", "r2")).await, "nothing is asked after exit");
}

#[tokio::test]
async fn a_chat_approval_allows_denies_or_asks_by_the_policy_and_returns_the_exact_input() {
    struct Recorder(Mutex<Vec<ApprovalRequest>>, bool, AtomicUsize);
    #[async_trait]
    impl ApprovalBroker for Recorder {
        async fn ask(&self, req: ApprovalRequest) -> bool {
            self.2.fetch_add(1, Ordering::SeqCst);
            self.0.lock().unwrap().push(req);
            self.1
        }
        fn deny_chat(&self, _: &str) {}
        fn deny_request(&self, _: &str, _: &str) {}
        fn pending(&self, _: &str) -> usize {
            0
        }
    }
    let rec = Arc::new(Recorder(Mutex::default(), true, AtomicUsize::new(0)));
    let policy = ApprovalPolicy::from_servers(
        &[server("mira", &[("kb_search", true, Some(true), None), ("send_mail", true, None, None), ("off", false, Some(true), None)])],
        vec![],
    );
    let chat = ChatApprovals { can_ask: true, chat_id: "c1".into(), broker: rec.clone(), policy: Arc::new(policy) };
    let input = json!({"to": "a@b.c", "body": "hi", "token": "t"});
    assert!(chat.decide("r0", "mcp__mira__kb_search", &json!({})).await, "runs by itself");
    assert!(!chat.decide("r0", "mcp__mira__off", &json!({})).await, "not allowed: denied without asking");
    assert!(!chat.decide("r0", "Bash", &json!({"command": "dir"})).await);
    assert_eq!(rec.2.load(Ordering::SeqCst), 0, "none of those asked");
    assert!(chat.decide("r1", "mcp__mira__send_mail", &input).await);
    let asked = rec.0.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].server.as_str(), asked[0].tool.as_str(), asked[0].request_id.as_str()), ("mira", "send_mail", "r1"));
    // The question carries the real arguments, not the redacted rendering.
    assert_eq!(asked[0].args, input);
}

// ---- default is deny: malformed and odd requests, all three CLIs ----------

mod fail_closed {
    use super::*;
    use crate::llm::cli_agent::acp::permission::{
        decide as acp_decide, hold_kind, parse_request, HoldKind, McpToolRule, Outcome, PermissionPolicy,
    };
    use crate::llm::cli_agent::codex::policy::{decide as codex_decide, CodexPolicy, Verdict};
    use crate::llm::cli_agent::codex::protocol::{tool_params, ServerRequest};

    /// One chat: `kb_search` runs, `send_mail` asks, `off` is not allowed.
    fn chat() -> ApprovalPolicy {
        ApprovalPolicy::from_servers(
            &[server("mira", &[("kb_search", true, Some(true), None), ("send_mail", true, None, None), ("off", false, Some(true), None)])],
            vec![PathBuf::from("D:\\scope")],
        )
    }

    fn codex() -> CodexPolicy {
        let mut p = CodexPolicy::default();
        for t in ["mcp__mira__kb_search", "mcp__mira__send_mail"] {
            p.allowed_tools.insert(t.into());
        }
        p.ask_tools.insert("mcp__mira__send_mail".into());
        p
    }

    fn acp() -> PermissionPolicy {
        PermissionPolicy::new(vec![McpToolRule::tool("mira", "kb_search"), McpToolRule::tool("mira", "send_mail")], vec![])
            .with_ask(vec![McpToolRule::tool("mira", "send_mail")])
    }

    fn elicitation(server: &str, message: &str, meta: Value) -> ServerRequest {
        ServerRequest::McpElicitation { server: server.into(), message: message.into(), meta }
    }

    fn acp_request(call_id: &str, name: &str) -> crate::llm::cli_agent::acp::permission::PermissionRequest {
        parse_request(&json!({
            "toolCall": {"toolCallId": call_id, "name": name, "rawInput": {}},
            "options": [{"optionId": "yes", "kind": "allow_once"}, {"optionId": "no", "kind": "reject_once"}],
        }))
    }

    /// Claude: the tool names a model-driven CLI could send that must never run unasked.
    #[test]
    fn claude_names_that_are_odd_unknown_or_renamed_are_denied() {
        let p = chat();
        for name in [
            "", "mcp__", "mcp__mira__", "mcp__mira__send_mail ", " mcp__mira__kb_search", "MCP__mira__kb_search",
            "mcp__MIRA__kb_search", "mcp__mira__KB_SEARCH", "mcp__mira__kb_search\0", "mcp__mira__renamed_kb_search",
            "mcp__mira__off", "mcp__other__kb_search", "mcp__mira__kb_search__x", "mira__off", "Read\u{200B}", "read", "Bash", "WebFetch",
        ] {
            assert!(matches!(p.verdict_for_name(name, &json!({"file_path": "D:\\scope\\a"})), ToolVerdict::Deny(_)), "{name:?}");
        }
        // The one that asks asks (never runs by itself); the read-only one runs.
        assert_eq!(p.verdict_for_name("mcp__mira__send_mail", &json!({})), ToolVerdict::Ask);
        assert_eq!(p.verdict_for_name("mcp__mira__kb_search", &json!({})), ToolVerdict::Allow);
        // Built-ins with odd inputs.
        for input in [json!(null), json!([]), json!("D:\\scope\\a"), json!({"file_path": 5}), json!({"file_path": ["D:\\scope\\a"]}), json!({})] {
            assert!(matches!(p.verdict_for_name("Read", &input), ToolVerdict::Deny(_)), "{input}");
        }
    }

    #[test]
    fn codex_requests_that_are_malformed_aliased_or_mixed_up_are_never_allowed_unasked() {
        let p = codex();
        let kind = json!({"codex_approval_kind": "mcp_tool_call"});
        let with = |extra: Value| {
            let mut m = kind.clone();
            for (k, v) in extra.as_object().unwrap() {
                m[k] = v.clone();
            }
            m
        };
        let msg = |tool: &str| format!("Allow the mira MCP server to run tool \"{tool}\"?");
        // Must come out as Deny (or at most Ask for the one tool that asks): never Allow.
        let cases: Vec<(ServerRequest, bool)> = vec![
            (elicitation("mira", &msg("send_mail"), json!({})), false),                              // no approval kind
            (elicitation("mira", &msg("send_mail"), json!({"codex_approval_kind": "other"})), false),  // another kind
            (elicitation("mira", &msg("send_mail"), json!(null)), false),                            // unparsable _meta
            (elicitation("", &msg("send_mail"), kind.clone()), false),                               // no server
            (elicitation("Mira", &msg("send_mail"), kind.clone()), false),                           // server alias by case
            (elicitation("mira-label", &msg("send_mail"), kind.clone()), false),                     // a label, not the key
            (elicitation("mira", &msg("Send_Mail"), kind.clone()), false),                           // tool by case
            (elicitation("mira", &msg("send_mail "), kind.clone()), false),                          // padded
            (elicitation("mira", &msg("renamed_mail"), kind.clone()), false),                        // renamed since listing
            (elicitation("mira", "", kind.clone()), false),                                          // names nothing
            (elicitation("mira", "Allow it?", with(json!({"tool_name": 7}))), false),                // wrong type
            (elicitation("mira", &msg("off"), kind.clone()), false),                                 // not allowed
            (elicitation("other", &msg("kb_search"), kind.clone()), false),                          // other server's tool
        ];
        for (req, _) in &cases {
            assert!(matches!(codex_decide(req, &p), Verdict::Deny(_)), "{req:?}");
        }
        // Two names in one request (title says the safe one, message the one that asks): it asks.
        let mixed = elicitation("mira", &msg("send_mail"), with(json!({"tool_title": "kb_search"})));
        assert_eq!(codex_decide(&mixed, &p), Verdict::Ask { tool: "send_mail".into() });
        // Held requests need visible arguments, and a duplicate id is just asked again, never allowed.
        assert_eq!(tool_params(&json!({"codex_approval_kind": "mcp_tool_call"})), None);
        // Everything that is not an MCP tool call is refused outright.
        for other in [
            ServerRequest::UserInput,
            ServerRequest::DynamicToolCall,
            ServerRequest::PermissionsApproval,
            ServerRequest::AuthTokensRefresh,
            ServerRequest::Unknown { method: "x".into() },
        ] {
            assert!(matches!(codex_decide(&other, &p), Verdict::Deny(_)), "{other:?}");
        }
    }

    #[test]
    fn acp_requests_for_a_tool_that_asks_are_never_allowed_by_the_static_rules() {
        let (static_rules, chat) = (acp(), chat());
        // The ask tool, with and without a call id, in every spelling the policy knows.
        for name in ["mcp_mira_send_mail", "mcp__mira__send_mail", "mira__send_mail"] {
            let with_id = acp_request("c1", name);
            assert_eq!(hold_kind(&static_rules, &chat, &with_id), HoldKind::Held { server: "mira".into(), tool: "send_mail".into() });
            // Whatever hold_kind says, the static decision is a rejection.
            for call_id in ["c1", ""] {
                let r = acp_request(call_id, name);
                assert_eq!(acp_decide(&r, &static_rules), Outcome::Selected("no".into()), "{name} id={call_id:?}");
            }
            assert_eq!(hold_kind(&static_rules, &chat, &acp_request("", name)), HoldKind::Refuse, "no call id: refused at once");
        }
        // A tool the chat's own rules do not let ask is refused, never asked or allowed.
        let off_chat = ApprovalPolicy::from_servers(&[server("mira", &[("send_mail", false, None, None)])], vec![]);
        assert_eq!(hold_kind(&static_rules, &off_chat, &acp_request("c1", "mcp_mira_send_mail")), HoldKind::Refuse);
        // Not ours: the read-only tool is the static rules' business, unknown ones are denied by them.
        assert_eq!(hold_kind(&static_rules, &chat, &acp_request("c1", "mcp_mira_kb_search")), HoldKind::NotMine);
        assert_eq!(acp_decide(&acp_request("c1", "mcp_mira_kb_search"), &static_rules), Outcome::Selected("yes".into()));
        for name in ["", "mcp_mira_", "MCP_MIRA_SEND_MAIL", "mcp_mira_Send_Mail", "mcp_other_send_mail", "run_command", "mcp_mira_renamed"] {
            assert_eq!(hold_kind(&static_rules, &chat, &acp_request("c1", name)), HoldKind::NotMine, "{name:?}");
            assert_eq!(acp_decide(&acp_request("c1", name), &static_rules), Outcome::Selected("no".into()), "{name:?}");
        }
        // Malformed params: no options, no tool call at all.
        for params in [json!({}), json!({"toolCall": null}), json!({"toolCall": {"toolCallId": "c"}}), json!(null), json!("x")] {
            let r = parse_request(&params);
            assert!(!acp_decide(&r, &static_rules).is_allow(&r), "{params}");
        }
    }

// ---- redaction, per the threat model ----------------------------------------

#[test]
fn only_short_scalars_under_known_secret_names_are_hidden_and_the_marker_says_what_was_hidden() {
    let long = "z".repeat(MAX_HIDDEN_CHARS + 1);
    let args = json!({
        "password": "hunter2",
        "api_key": 12345,
        "secret": true,
        "token": {"inner": "visible", "refresh_token": "r"},
        "credentials": ["a", "b"],
        "authorization": long,
        "title": "authorization: not a key name",
    });
    let shown = display_args(&args).unwrap();
    assert!(shown.redacted);
    assert!(shown.contains("[hidden: looks like a key, string, 7 chars]"), "{shown}");
    assert!(shown.contains("[hidden: looks like a key, number]") && shown.contains("[hidden: looks like a key, boolean]"));
    assert!(!shown.contains("hunter2") && !shown.contains("12345"));
    // Containers under a secret-looking key are walked, not blanked; long text is shown.
    assert!(shown.contains("\"inner\": \"visible\""));
    assert!(shown.contains(&"z".repeat(MAX_HIDDEN_CHARS + 1)));
    assert!(shown.contains("authorization: not a key name"), "values are never judged, only key names");
    assert!(shown.contains("\"a\"") && shown.contains("\"b\""));
    assert!(!display_args(&json!({"query": "x"})).unwrap().redacted);
}

#[test]
fn control_and_formatting_characters_are_all_written_out() {
    let nasty = "a\u{0007}b\u{0085}c\u{2028}d\u{2066}e\u{E0041}f\u{FE0F}g\u{3164}h\u{0}i";
    let shown = display_args(&json!({"v": nasty})).unwrap();
    assert!(shown.chars().all(|c| c == '\n' || c == ' ' || !c.is_control()), "{shown:?}");
    for code in ["\\u{0085}", "\\u{2028}", "\\u{2066}", "\\u{E0041}", "\\u{FE0F}", "\\u{3164}"] {
        assert!(shown.contains(code), "{code} in {shown:?}");
    }
    assert!(shown.contains("a") && shown.contains("i"));
}

#[tokio::test]
async fn the_question_event_says_when_something_was_redacted() {
    let (b, seen) = broker(Duration::from_secs(5));
    let t = tokio::spawn({ let b = b.clone(); async move { b.ask(request("c1", "r1")).await } });
    let ev = first_question(&seen).await;
    assert!(ev.redacted && !ev.truncated);
    b.answer(&ev.approval_id, false);
    assert!(!t.await.unwrap());
}

// ---- launch enforcement ------------------------------------------------------

#[test]
fn a_chat_that_cannot_ask_never_launches_with_a_tool_that_would() {
    use crate::llm::cli_agent::command::{build_args, SessionConfig};
    let policy = ApprovalPolicy::from_servers(
        &[server("m", &[("kb_search", true, Some(true), None), ("send_mail", true, None, None)])],
        vec![],
    );
    let src = SourcesLaunch {
        add_dirs: vec!["C:\\t".into()],
        allowed_tools: vec!["mcp__m__kb_search".into(), "mcp__m__send_mail".into()],
        ..Default::default()
    };
    let approvals = |can_ask| ChatApprovals {
        can_ask,
        chat_id: "c".into(),
        broker: Arc::new(WorkspaceApprovals::new()),
        policy: Arc::new(policy.clone()),
    };
    // The shared launch helper: what Claude, Codex and Antigravity all go through.
    let off = launch_sources(Some(&src), Some(&approvals(false))).unwrap();
    assert_eq!(off.allowed_tools, vec!["mcp__m__kb_search"]);
    assert_eq!(off.disallowed_tools, vec!["mcp__m__send_mail"]);
    assert_eq!(launch_sources(Some(&src), Some(&approvals(true))).unwrap(), src, "able to ask: unchanged");
    assert_eq!(launch_sources(Some(&src), None).unwrap(), src, "no approvals: unchanged");
    assert!(launch_sources(None, Some(&approvals(false))).is_none());
    // Claude's own args, with no help from the caller.
    let cfg = SessionConfig {
        kind: CliAgentKind::Claude,
        model: "m".into(),
        effort: None,
        system_prompt: String::new(),
        thinking: false,
        sources: Some(src.clone()),
        approvals: Some(approvals(false)),
    };
    let args = build_args(&cfg, Path::new("sp.txt"), None);
    let at = args.iter().position(|a| a == "--disallowedTools").expect("disallowed");
    assert!(args[at + 1..].contains(&"mcp__m__send_mail".to_string()));
    assert!(!args.iter().any(|a| a == "host"), "no host prompts when it cannot ask");
    // Codex and Antigravity launches.
    let codex = crate::llm::cli_agent::spawner::codex_launch(PathBuf::from("codex"), vec![], &cfg);
    assert!(!codex.policy.allowed_tools.contains("mcp__m__send_mail") && codex.ask.is_none());
    let agy = crate::llm::cli_agent::spawner::antigravity_launch(PathBuf::from("agy"), &cfg);
    assert!(agy.ask.is_none());
}
}
