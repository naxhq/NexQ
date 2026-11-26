//! Contract fixtures of the chat and search commands and events (see `crate::contract`).
//! A command fixture is the arguments object the webview passes; a command's answer is
//! `<command>_result.json`; an event fixture is the payload.

use serde_json::json;

use super::hub::{ChatCapabilities, ToolOff};
use super::types::*;
use crate::assert_contract;
use crate::contract::{input, read};

fn bar(kind: &str, ref_id: &str, sub_ref: Option<&str>, layer: &str) -> ContextBar {
    ContextBar {
        id: format!("{kind}:{ref_id}"),
        kind: kind.into(),
        ref_id: ref_id.into(),
        sub_ref: sub_ref.map(Into::into),
        layer: layer.into(),
        title: format!("A {kind}"),
        tokens: 120,
        relevance: 0.5,
        pinned: kind == "document",
        included: true,
    }
}

fn report() -> ContextReport {
    ContextReport {
        strategy: "ladder".into(),
        depth: "balanced".into(),
        budget: 6000,
        window: 200_000,
        used: 480,
        bars: vec![
            bar("meeting", "m1", None, "meetings"),
            bar("document", "d1", None, "documents"),
            bar("folder", "f1", Some("notes/plan.md"), "folders"),
            bar("talking_point", "t1", None, "documents"),
            bar("memory", "mem1", None, "instructions"),
            bar("instructions", "workspace", None, "instructions"),
            bar("conversation", "chat", None, "conversation"),
        ],
        omitted: 2,
        notices: vec!["This conversation continues in an earlier session; that session holds its context.".into()],
        estimate: true,
        layers: vec![
            ContextLayerInfo { layer: "meetings".into(), available: 9_400, sources: 3, searched: true },
            ContextLayerInfo { layer: "documents".into(), available: 390, sources: 2, searched: false },
            ContextLayerInfo { layer: "folders".into(), available: 1_200_000, sources: 638, searched: true },
        ],
        depth_budgets: Some(DepthBudgets { lean: 16_000, balanced: 60_000, deep: 120_000 }),
    }
}

fn citation(tag: &str, kind: &str, ref_id: &str, sub_ref: Option<&str>, start_ms: Option<i64>) -> WorkspaceCitation {
    WorkspaceCitation {
        tag: tag.into(),
        kind: kind.into(),
        ref_id: ref_id.into(),
        sub_ref: sub_ref.map(Into::into),
        title: format!("A {kind}"),
        start_ms,
        snippet: "the budget was agreed".into(),
    }
}

fn message(id: i64, role: &str, content: &str, citations: Vec<WorkspaceCitation>, context: Option<ContextReport>) -> WorkspaceMessage {
    let assistant = role == "assistant";
    WorkspaceMessage {
        id,
        chat_id: "c1".into(),
        role: role.into(),
        content: content.into(),
        model: if assistant { Some("claude-sonnet".into()) } else { None },
        citations,
        context,
        input_tokens: if assistant { 900 } else { 0 },
        output_tokens: if assistant { 120 } else { 0 },
        created_at: 1_700_000_000_000,
    }
}

fn chat() -> WorkspaceChat {
    WorkspaceChat {
        id: "c1".into(),
        workspace_id: "w1".into(),
        title: "Budget".into(),
        provider: Some("claude_cli".into()),
        model: Some("sonnet".into()),
        effort: None,
        depth: "balanced".into(),
        include_meetings: true,
        condensed_upto: None,
        message_count: 2,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
    }
}

// ---- events

#[test]
fn event_chat_start() {
    assert_contract!("workspace_chat_start", ChatStartEvent { chat_id: "c1".into(), request_id: "ask-1".into(), model: Some("sonnet".into()) });
}

#[test]
fn event_chat_token() {
    assert_contract!("workspace_chat_token", ChatTokenEvent { chat_id: "c1".into(), request_id: "ask-1".into(), token: "The budget".into() });
}

#[test]
fn event_chat_context() {
    assert_contract!("workspace_chat_context", ChatContextEvent { chat_id: "c1".into(), request_id: "ask-1".into(), report: report() });
}

#[test]
fn event_chat_end() {
    let m = message(5, "assistant", "It was agreed [S1].", vec![citation("S1", "folder", "f1", Some("notes/plan.md"), None)], Some(report()));
    assert_contract!("workspace_chat_end", ChatEndEvent { chat_id: "c1".into(), request_id: "ask-1".into(), message: m, cancelled: false });
}

#[test]
fn event_chat_error() {
    assert_contract!(
        "workspace_chat_error",
        ChatErrorEvent {
            chat_id: "c1".into(),
            request_id: "ask-1".into(),
            error: super::guard::STOPPED_MOVED.into(),
            error_kind: "access_changed".into(),
            error_detail: Some("moved".into()),
        }
    );
}

/// What the engine really emits goes through the same types: run an answer and read its events back.
#[test]
fn the_emitted_events_read_back_into_the_contract_types() {
    use crate::contract::read;
    let _: ChatStartEvent = serde_json::from_value(read("workspace_chat_start")).unwrap();
    let _: ChatTokenEvent = serde_json::from_value(read("workspace_chat_token")).unwrap();
    let _: ChatContextEvent = serde_json::from_value(read("workspace_chat_context")).unwrap();
    let _: ChatEndEvent = serde_json::from_value(read("workspace_chat_end")).unwrap();
    let _: ChatErrorEvent = serde_json::from_value(read("workspace_chat_error")).unwrap();
}

#[test]
fn event_index_progress() {
    let e = IndexProgressEvent { workspace_id: "w1".into(), done: 3, total: 10, current: Some("notes/plan.md".into()), skipped: 1 };
    assert_contract!("workspace_index_progress", e);
}

// ---- command results

#[test]
fn result_list_workspace_messages_with_every_citation_kind() {
    let cites = vec![
        citation("S1", "transcript", "m1", None, Some(61_000)),
        citation("S2", "document", "d1", None, None),
        citation("S3", "folder", "f1", Some("notes/plan.md"), None),
        citation("S4", "talking_point", "t1", None, None),
    ];
    let list = vec![
        message(4, "user", "What was agreed?", vec![], None),
        message(5, "assistant", "It was agreed [S1][S2][S3][S4].", cites, Some(report())),
    ];
    assert_contract!("list_workspace_messages_result", list);
}

#[test]
fn result_get_index_status() {
    let s = IndexStatus {
        workspace_id: "w1".into(),
        state: "indexing".into(),
        done: 3,
        total: 10,
        passages: 120,
        skipped: vec![SkippedFile { folder_id: "f1".into(), path: "big.pdf".into(), reason: "Too large to read".into() }],
        last_indexed_at: Some(1_700_000_000_000),
        ai_recaps: 2,
        ai_recaps_failed: RecapFailures { count: 1, reason: Some("The model did not answer in time".into()) },
    };
    assert_contract!("get_index_status_result", s);
}

#[test]
fn result_preview_chat_context() {
    assert_contract!("preview_chat_context_result", report());
}

#[test]
fn result_get_context_budget() {
    assert_contract!("get_context_budget_result", ContextBudget { depth: "balanced".into(), budget: 60_000, window: 200_000 });
}

#[test]
fn result_chat_crud() {
    assert_contract!("list_workspace_chats_result", vec![chat()]);
    assert_contract!("create_workspace_chat_result", chat());
}

#[test]
fn result_meeting_recap() {
    let r = MeetingRecap { text: "Budget talk. The budget was agreed at 5k.".into(), model: None, created_at: 1_700_000_000_000 };
    assert_contract!("get_meeting_recap_result", Some(r));
    assert_contract!("get_meeting_recap_none_result", Option::<MeetingRecap>::None);
}

#[test]
fn result_workspace_meeting_rows_say_whether_they_have_a_recap() {
    let row = crate::db::meetings::MeetingSummary {
        id: "m1".into(),
        title: "Planning".into(),
        start_time: "2026-03-05T10:00:00Z".into(),
        end_time: Some("2026-03-05T10:30:00Z".into()),
        duration_seconds: Some(1800),
        segment_count: 12,
        has_summary: false,
        audio_mode: "online".into(),
        ai_scenario: "team_meeting".into(),
        workspace_id: "w1".into(),
        has_recap: true,
    };
    assert_contract!("list_workspace_meetings_result", crate::workspace::types::WorkspaceMeetingPage { meetings: vec![row], total: 1 });
}

#[test]
fn result_prefs_and_capabilities() {
    assert_contract!("list_chat_meeting_prefs_result", vec![MeetingPref { meeting_id: "m1".into(), included: false }]);
    assert_contract!("list_chat_item_prefs_result", vec![ItemPref { kind: "document".into(), ref_id: "d1".into(), pref: "pin".into(), title: "Budget plan".into() }]);
    let caps = ChatCapabilities {
        can_ask: true,
        tools_off: vec![ToolOff { tool: "Bash".into(), reason: "Not allowed in a workspace chat".into() }],
        notes: vec!["Tools that change things ask first.".into()],
    };
    assert_contract!("get_chat_capabilities_result", caps);
}

// ---- command arguments

#[test]
fn command_arguments() {
    assert_contract!("get_index_status", json!({ "id": "w1" }));
    assert_contract!("rescan_workspace", json!({ "id": "w1" }));
    assert_contract!("list_workspace_chats", json!({ "workspaceId": "w1" }));
    assert_contract!("create_workspace_chat", json!({ "workspaceId": "w1" }));
    assert_contract!(
        "update_workspace_chat",
        json!({ "id": "c1", "patch": { "title": "Budget", "provider": null, "model": "sonnet", "depth": "deep", "include_meetings": false } })
    );
    assert_contract!("delete_workspace_chat", json!({ "id": "c1" }));
    assert_contract!("list_workspace_messages", json!({ "chatId": "c1" }));
    assert_contract!("set_chat_meeting_included", json!({ "workspaceId": "w1", "chatId": "c1", "meetingId": "m1", "included": false }));
    assert_contract!("list_chat_meeting_prefs", json!({ "workspaceId": "w1", "chatId": "c1" }));
    assert_contract!("set_chat_item_pref", json!({ "chatId": "c1", "kind": "document", "refId": "d1", "pref": "pin" }));
    assert_contract!("list_chat_item_prefs", json!({ "chatId": "c1" }));
    assert_contract!("preview_chat_context", json!({ "chatId": "c1", "question": "What was agreed?" }));
    assert_contract!("get_context_budget", json!({ "depth": "balanced" }));
    assert_contract!("get_chat_capabilities", json!({ "chatId": "c1" }));
    assert_contract!("ask_workspace", json!({ "chatId": "c1", "question": "What was agreed?", "requestId": "ask-1", "deeper": false }));
    // "Search deeper" asks the same question again with `deeper`; "Leave out of this chat" is pref "exclude".
    assert_contract!("ask_workspace_deeper", json!({ "chatId": "c1", "question": "What was agreed?", "requestId": "ask-2", "deeper": true }));
    assert_contract!("set_chat_item_pref_exclude", json!({ "chatId": "c1", "kind": "meeting", "refId": "m1", "pref": "exclude" }));
    assert_contract!("count_unfiled_meetings", json!({}));
    // the meetings filed in no workspace: the same list command with the scope id "unfiled"
    assert_contract!("list_workspace_meetings_unfiled", json!({ "id": "unfiled", "query": null, "limit": 50, "offset": 0 }));
    assert_contract!("retry_recaps", json!({ "workspaceId": "w1" }));
    assert_contract!("get_meeting_recap", json!({ "meetingId": "m1" }));
    assert_contract!("delete_meeting_recap", json!({ "meetingId": "m1" }));
    assert_contract!("cancel_workspace_request", json!({ "requestId": "ask-1" }));
    assert_contract!("save_answer_to_library", json!({ "messageId": 5, "title": "Budget decision", "text": "We agreed to cap the budget at 40k." }));
}

#[test]
fn arguments_fit_their_rust_types() {
    let patch: WorkspaceChatPatch = input("update_workspace_chat", "patch");
    assert_eq!(patch.provider, Some(None), "null clears the provider");
    assert_eq!(patch.effort, None, "a missing key leaves the effort alone");
}

#[test]
fn results_read_back_into_their_types() {
    let msgs: Vec<WorkspaceMessage> = serde_json::from_value(read("list_workspace_messages_result")).unwrap();
    let kinds: Vec<&str> = msgs[1].citations.iter().map(|c| c.kind.as_str()).collect();
    assert_eq!(kinds, ["transcript", "document", "folder", "talking_point"]);
    let _: IndexStatus = serde_json::from_value(read("get_index_status_result")).unwrap();
    let _: ContextReport = serde_json::from_value(read("preview_chat_context_result")).unwrap();
    let _: ContextBudget = serde_json::from_value(read("get_context_budget_result")).unwrap();
}
