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

/// A folder tree in the temp dir: `<root>/scope`, `<root>/scope2`, `<root>/outside`.
fn tree(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("nexq-approval-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for d in ["scope/sub", "scope2", "outside"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::write(root.join("scope/m1.txt"), "t").unwrap();
    std::fs::write(root.join("scope/sub/m2.txt"), "t").unwrap();
    std::fs::write(root.join("scope2/x.txt"), "t").unwrap();
    std::fs::write(root.join("outside/secret.txt"), "t").unwrap();
    root
}

/// A directory junction (no privilege needed on Windows); `false` when it cannot be made.
fn junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn built_in_reads_are_confined_to_the_scope_folders_and_everything_else_is_denied() {
    let root = tree("builtin");
    let scope = root.join("scope");
    let dirs = vec![scope.clone()];
    let v = |tool: &str, input: Value| builtin_verdict(tool, &input, &dirs);
    let p = |rel: &str| root.join(rel).to_string_lossy().into_owned();
    assert_eq!(v("Read", json!({"file_path": p("scope/m1.txt")})), ToolVerdict::Allow);
    assert_eq!(v("Read", json!({"file_path": p("scope/sub/m2.txt")})), ToolVerdict::Allow);
    assert_eq!(v("Read", json!({"file_path": p("scope/not-yet.txt")})), ToolVerdict::Allow, "resolved through its folder");
    assert_eq!(v("Read", json!({"file_path": p("scope/sub/new/deep.txt")})), ToolVerdict::Allow);
    assert_eq!(v("Grep", json!({"pattern": "x", "path": p("scope")})), ToolVerdict::Allow);
    assert_eq!(v("Glob", json!({"pattern": "*.txt", "path": p("scope/sub")})), ToolVerdict::Allow);
    // The same file spelled with other separators and case (Windows is case-insensitive).
    if cfg!(windows) {
        let odd = p("scope/m1.txt").to_uppercase().replace('\\', "/");
        assert_eq!(v("Read", json!({"file_path": odd})), ToolVerdict::Allow);
    }
    for bad in [
        p("scope/../outside/secret.txt"),          // climbs out
        p("scope2/x.txt"),                         // a sibling that shares the prefix
        p("outside/secret.txt"),
        root.parent().unwrap().join("nexq-approval-nowhere/a.txt").to_string_lossy().into_owned(),
        "relative\\a.txt".into(),
        "..\\a.txt".into(),
        "\\rooted-without-drive.txt".into(),
        "".into(),
    ] {
        assert!(matches!(v("Read", json!({"file_path": bad.clone()})), ToolVerdict::Deny(_)), "{bad}");
    }
    // No path (Grep/Glob would use the cwd), or a pattern that climbs out or names its own root.
    assert!(matches!(v("Grep", json!({"pattern": "x"})), ToolVerdict::Deny(_)));
    assert!(matches!(v("Glob", json!({"pattern": "../*", "path": p("scope")})), ToolVerdict::Deny(_)));
    assert!(matches!(v("Glob", json!({"pattern": "C:\\*", "path": p("scope")})), ToolVerdict::Deny(_)));
    assert!(matches!(v("Glob", json!({"pattern": "/etc/*", "path": p("scope")})), ToolVerdict::Deny(_)));
    // Shell, edit, web and everything unknown: never.
    for t in ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "PowerShell", "Anything"] {
        assert!(matches!(v(t, json!({"file_path": p("scope/m1.txt"), "command": "dir"})), ToolVerdict::Deny(_)), "{t}");
    }
    // A scope folder that does not exist confines nothing: everything is denied.
    let missing = vec![root.join("gone")];
    assert!(matches!(builtin_verdict("Read", &json!({"file_path": p("scope/m1.txt")}), &missing), ToolVerdict::Deny(_)));
    assert!(matches!(builtin_verdict("Read", &json!({"file_path": p("scope/m1.txt")}), &[]), ToolVerdict::Deny(_)));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_junction_or_link_that_leads_out_of_the_scope_does_not_count_as_inside() {
    let root = tree("link");
    let scope = root.join("scope");
    if !junction(&scope.join("exit"), &root.join("outside")) {
        eprintln!("(no junction support here: skipped)");
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let dirs = vec![scope.clone()];
    let via = scope.join("exit").join("secret.txt").to_string_lossy().into_owned();
    assert!(matches!(builtin_verdict("Read", &json!({"file_path": via}), &dirs), ToolVerdict::Deny(_)), "through the junction");
    let new_via = scope.join("exit").join("new.txt").to_string_lossy().into_owned();
    assert!(matches!(builtin_verdict("Read", &json!({"file_path": new_via}), &dirs), ToolVerdict::Deny(_)), "a new file beyond it");
    let root_via = scope.join("exit").to_string_lossy().into_owned();
    assert!(matches!(builtin_verdict("Grep", &json!({"pattern": "x", "path": root_via}), &dirs), ToolVerdict::Deny(_)));
    // And a scope folder that is itself a junction is judged by where it really is.
    let inside_link = vec![scope.join("exit")];
    let real = root.join("outside").join("secret.txt").to_string_lossy().into_owned();
    assert_eq!(builtin_verdict("Read", &json!({"file_path": real}), &inside_link), ToolVerdict::Allow);
    // Remove the junction itself (not its target) before the tree.
    let _ = std::fs::remove_dir(scope.join("exit"));
    let _ = std::fs::remove_dir_all(&root);
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
    let real = tree("policy");
    let with_scope = ApprovalPolicy { scope_dirs: vec![real.join("scope")], ..policy.clone() };
    assert_eq!(
        with_scope.verdict_for_name("Read", &json!({"file_path": real.join("scope/m1.txt").to_string_lossy()})),
        ToolVerdict::Allow
    );
    let _ = std::fs::remove_dir_all(&real);
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
    use crate::llm::cli_agent::acp::permission::parse_request;
    use crate::llm::cli_agent::codex::protocol::ServerRequest;

    /// One chat: `kb_search` runs, `send_mail` asks, `off` is not allowed.
    fn chat() -> ApprovalPolicy {
        ApprovalPolicy::from_servers(
            &[server("mira", &[("kb_search", true, Some(true), None), ("send_mail", true, None, None), ("off", false, Some(true), None)])],
            vec![PathBuf::from("D:\\scope")],
        )
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

    /// A chat on Codex or Antigravity never asks: the launch removes every tool
    /// that would, so these CLIs' own rules (unchanged) see only auto-run tools.
    fn only_auto_run(kind: CliAgentKind) -> SourcesLaunch {
        let src = SourcesLaunch {
            allowed_tools: vec!["mcp__mira__kb_search".into(), "mcp__mira__send_mail".into(), "mcp__mira__note".into()],
            ..Default::default()
        };
        let approvals = ChatApprovals { can_ask: true, chat_id: "c".into(), broker: Arc::new(WorkspaceApprovals::new()), policy: Arc::new(chat()) };
        launch_sources(kind, Some(&src), Some(&approvals)).unwrap()
    }

    #[test]
    fn codex_and_antigravity_chats_get_no_tool_that_would_ask() {
        for kind in [CliAgentKind::Codex, CliAgentKind::Antigravity] {
            let l = only_auto_run(kind);
            assert_eq!(l.allowed_tools, vec!["mcp__mira__kb_search"], "{kind:?}");
            assert!(l.disallowed_tools.contains(&"mcp__mira__send_mail".to_string()), "{kind:?}");
            assert!(l.disallowed_tools.contains(&"mcp__mira__note".to_string()), "no hint: asks, so off");
            assert!(matches!(approval_support(kind), ApprovalSupport::Unsupported(r) if r.contains("off")));
        }
        // Claude keeps the full list for its own launch (the asking tools are left out of
        // --allowedTools by build_args and handed to the host).
        assert_eq!(only_auto_run(CliAgentKind::Claude).allowed_tools.len(), 3);
    }

    #[test]
    fn codex_and_acp_rules_built_from_that_launch_deny_everything_else() {
        use crate::llm::cli_agent::acp::permission::{decide as acp_decide, McpToolRule, PermissionPolicy};
        use crate::llm::cli_agent::codex::policy::{decide as codex_decide, CodexPolicy, Verdict};
        let mut codex = CodexPolicy::default();
        codex.allowed_tools.insert("mcp__mira__kb_search".into());
        let kind = json!({"codex_approval_kind": "mcp_tool_call"});
        let msg = |t: &str| format!("Allow the mira MCP server to run tool \"{t}\"?");
        for tool in ["send_mail", "note", "off", "Send_Mail", "kb_search ", ""] {
            assert!(matches!(codex_decide(&elicitation("mira", &msg(tool), kind.clone()), &codex), Verdict::Deny(_)), "{tool:?}");
        }
        assert!(matches!(codex_decide(&elicitation("mira", &msg("kb_search"), kind.clone()), &codex), Verdict::Allow));
        let acp = PermissionPolicy::new(vec![McpToolRule::tool("mira", "kb_search")], vec![]);
        let req = |name: &str| acp_request("c1", name);
        for name in ["mcp_mira_send_mail", "mcp_mira_note", "MCP_MIRA_KB_SEARCH", "", "run_command"] {
            let r = req(name);
            assert!(!acp_decide(&r, &acp).is_allow(&r), "{name:?}");
        }
        let r = req("mcp_mira_kb_search");
        assert!(acp_decide(&r, &acp).is_allow(&r));
    }
}
