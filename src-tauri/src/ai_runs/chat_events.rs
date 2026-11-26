//! The chat events that come out of the AI service rather than the chat
//! engine: tool activity lines (`workspace_chat_activity`) and the tool
//! questions (`workspace_chat_approval*`, see `llm::cli_agent::approval`).
//!
//! Both are keyed by the `request_id` the chat store holds for the answer it
//! is waiting for. A CLI knows nothing of that id, so `wire` hands the broker
//! and the activity sink one way to find it: `request_of(chat_id)`, the chat
//! hub's running answer. A tool event for a chat with no running answer is
//! dropped (a late event of a stopped answer must not reach the next one).

use super::AiRuns;
use crate::llm::cli_agent::approval::WorkspaceApprovals;
use crate::sources::activity::SourceActivity;
use std::sync::Arc;

/// Event name of a chat's tool activity line.
pub const ACTIVITY_EVENT: &str = "workspace_chat_activity";

/// The wire payload of `automatic_model_updated`: a provider's model list arrived, so
/// what "Automatic" means for it may have changed (ask `get_automatic_model` again).
pub fn models_updated_payload(provider: &str) -> serde_json::Value {
    serde_json::json!({ "provider": provider })
}

/// The wire payload of `workspace_chat_activity` (what the store's `activity` handler reads).
pub fn activity_payload(chat_id: &str, request_id: &str, activity: &SourceActivity) -> serde_json::Value {
    serde_json::json!({
        "chat_id": chat_id,
        "request_id": request_id,
        "activity": serde_json::to_value(activity).unwrap_or_default(),
    })
}

/// Connect the broker and the AI service to the chat's running answers and to
/// `emit` (the app's event emitter).
pub fn wire(
    runs: &Arc<AiRuns>,
    broker: &Arc<WorkspaceApprovals>,
    request_of: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    emit: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>,
) {
    let told = emit.clone();
    runs.set_models_updated(Arc::new(move |provider| {
        told(super::models::UPDATED_EVENT, models_updated_payload(provider));
    }));
    let resolve = request_of.clone();
    broker.set_ask_resolver(Arc::new(move |chat| resolve(chat)));
    runs.set_chat_activity(Arc::new(move |chat, activity| {
        if let Some(request_id) = request_of(chat) {
            emit(ACTIVITY_EVENT, activity_payload(chat, &request_id, &activity));
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::activity::{SourceActivity, SourceChip, SourceKind};

    #[test]
    fn event_workspace_chat_activity() {
        let activity = SourceActivity {
            kind: SourceKind::Tool,
            label: "Notes: set_flag".into(),
            chip: Some(SourceChip { kind: SourceKind::Tool, label: "Notes: set_flag".into(), path: None }),
            chip_only: false,
        };
        crate::assert_contract!("workspace_chat_activity", activity_payload("c1", "ask-1", &activity));
    }

    #[test]
    fn activity_lines_are_short_and_carry_no_private_path() {
        use super::super::chat_safe;
        let long = "x".repeat(500);
        let line = chat_safe(SourceActivity {
            kind: SourceKind::Notes,
            label: long.clone(),
            chip: Some(SourceChip { kind: SourceKind::Notes, label: long, path: Some("C:\\Users\\me\\AppData\\chat-transcripts\\1-abc\\m.txt".into()) }),
            chip_only: false,
        });
        assert!(line.label.chars().count() <= 80 && line.label.ends_with('…'));
        let chip = line.chip.unwrap();
        assert!(chip.path.is_none() && chip.label.chars().count() <= 80);
    }
}
