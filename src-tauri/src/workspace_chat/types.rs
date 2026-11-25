//! Types of the workspace chat: they mirror `src/lib/types.ts` (snake_case).

use serde::{Deserialize, Deserializer, Serialize};

fn clearable<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceChat {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub depth: String,
    pub include_meetings: bool,
    pub condensed_upto: Option<i64>,
    pub message_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `null` clears a selection, a missing key leaves it alone.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceChatPatch {
    pub title: Option<String>,
    #[serde(deserialize_with = "clearable")]
    pub provider: Option<Option<String>>,
    #[serde(deserialize_with = "clearable")]
    pub model: Option<Option<String>>,
    #[serde(deserialize_with = "clearable")]
    pub effort: Option<Option<String>>,
    pub depth: Option<String>,
    pub include_meetings: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceCitation {
    /// "S1" without brackets.
    pub tag: String,
    pub kind: String,
    pub ref_id: String,
    pub sub_ref: Option<String>,
    pub title: String,
    pub start_ms: Option<i64>,
    pub snippet: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ContextBar {
    pub id: String,
    /// What the UI needs to open the item: its kind (meeting, document, folder,
    /// talking_point, memory, instructions, conversation), its id and, for a
    /// file of a folder, the path inside the folder.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub ref_id: String,
    #[serde(default)]
    pub sub_ref: Option<String>,
    pub layer: String,
    pub title: String,
    pub tokens: usize,
    pub relevance: f32,
    pub pinned: bool,
    pub included: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextReport {
    pub strategy: String,
    pub depth: String,
    pub budget: usize,
    pub window: usize,
    pub used: usize,
    pub bars: Vec<ContextBar>,
    pub omitted: usize,
    pub notices: Vec<String>,
    pub estimate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceMessage {
    pub id: i64,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub citations: Vec<WorkspaceCitation>,
    pub context: Option<ContextReport>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub created_at: i64,
}

/// `list_chat_meeting_prefs`: the explicit choice for one meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingPref {
    pub meeting_id: String,
    pub included: bool,
}

/// `list_chat_item_prefs`: a pinned or excluded item of one chat. `kind` is
/// meeting, document, folder or talking_point; `pref` is "pin" or "exclude".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemPref {
    pub kind: String,
    pub ref_id: String,
    pub pref: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkippedFile {
    /// The folder the file is in (the library row to open).
    #[serde(default)]
    pub folder_id: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexStatus {
    pub workspace_id: String,
    /// idle, indexing or paused.
    pub state: String,
    pub done: usize,
    pub total: usize,
    pub passages: i64,
    pub skipped: Vec<SkippedFile>,
    pub last_indexed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexProgressEvent {
    pub workspace_id: String,
    pub done: usize,
    pub total: usize,
    pub current: Option<String>,
    pub skipped: usize,
}
