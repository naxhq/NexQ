//! The data of workspaces as the webview sees it. These mirror the
//! `Workspace*` types in `src/lib/types.ts` field for field (snake_case).

use serde::{Deserialize, Deserializer, Serialize};

/// The id of the workspace that always exists.
pub const GENERAL_ID: &str = "general";

/// What a workspace points to in the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Document,
    Folder,
    Server,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Document => "document",
            ItemKind::Folder => "folder",
            ItemKind::Server => "server",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "document" => Some(ItemKind::Document),
            "folder" => Some(ItemKind::Folder),
            "server" => Some(ItemKind::Server),
            _ => None,
        }
    }
}

/// A workspace row (what the database holds; the webview gets
/// [`WorkspaceSummary`] and [`WorkspaceDetail`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub description: String,
    pub instructions: String,
    pub include_general: bool,
    pub keep_separate: bool,
    pub default_scenario: Option<String>,
    pub recaps_with_ai: bool,
    pub suggest_memory: bool,
    /// Whether the brief starts by itself in this workspace (off by default).
    pub brief_default: bool,
    pub is_default: bool,
    pub pinned: bool,
    pub archived: bool,
    pub sort: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A workspace in the rail: counts and last activity included.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub description: String,
    pub include_general: bool,
    pub keep_separate: bool,
    pub default_scenario: Option<String>,
    pub is_default: bool,
    pub pinned: bool,
    pub archived: bool,
    pub sort: i64,
    pub meeting_count: i64,
    pub chat_count: i64,
    pub item_count: i64,
    /// Unix ms of the newest meeting, chat or edit.
    pub last_activity: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A workspace with everything its settings and Library panel need.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDetail {
    #[serde(flatten)]
    pub summary: WorkspaceSummary,
    pub instructions: String,
    pub recaps_with_ai: bool,
    pub suggest_memory: bool,
    /// The brief starts by itself in this workspace's meetings (the model and
    /// cap are global, in `BriefSettings`). Off by default.
    pub brief_enabled: bool,
    pub items: Vec<WorkspaceItem>,
}

/// One membership of a library item in a workspace, as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub kind: ItemKind,
    pub ref_id: String,
    pub label: Option<String>,
    pub pinned: bool,
    pub index_opt_in: bool,
    pub added_at: i64,
}

/// `LibraryStatus` in `types.ts`: `ready`, `indexing`, `missing`, `off`, `error`.
pub type LibraryStatus = String;

/// One library entry as a workspace sees it (name, health and size resolved).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceItem {
    pub workspace_id: String,
    pub kind: ItemKind,
    pub ref_id: String,
    /// The user's label override.
    pub label: Option<String>,
    /// The resolved display name.
    pub name: String,
    pub pinned: bool,
    pub status: LibraryStatus,
    pub detail: Option<String>,
    pub tokens: Option<i64>,
    /// Folders only: the user allowed indexing the folder text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_opt_in: Option<bool>,
    pub added_at: i64,
}

/// A document, folder or server of the library and where it is used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryItem {
    pub kind: ItemKind,
    pub ref_id: String,
    pub name: String,
    pub status: LibraryStatus,
    pub detail: Option<String>,
    pub tokens: Option<i64>,
    /// Workspaces that point to it.
    pub workspace_ids: Vec<String>,
    /// In no workspace: used nowhere.
    pub unfiled: bool,
}

/// What `create_workspace` takes. A new workspace does not also use General
/// unless asked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateWorkspaceInput {
    /// Optional id chosen by the caller: a UUID v4 nobody uses (never "general");
    /// otherwise one is generated. Anything else is refused.
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub description: String,
    pub instructions: String,
    pub include_general: bool,
    pub keep_separate: bool,
    pub default_scenario: Option<String>,
}

/// A field that may be left alone, set or cleared: absent = leave,
/// `null` = clear, a value = set.
fn clearable<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// What `update_workspace` changes; absent fields stay as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspacePatch {
    pub name: Option<String>,
    #[serde(deserialize_with = "clearable")]
    pub icon: Option<Option<String>>,
    #[serde(deserialize_with = "clearable")]
    pub color: Option<Option<String>>,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub include_general: Option<bool>,
    pub keep_separate: Option<bool>,
    #[serde(deserialize_with = "clearable")]
    pub default_scenario: Option<Option<String>>,
    pub pinned: Option<bool>,
    pub recaps_with_ai: Option<bool>,
    pub suggest_memory: Option<bool>,
    pub brief_enabled: Option<bool>,
}

/// Why a meeting of `delete_workspace_meetings` was not deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedMeeting {
    pub id: String,
    pub reason: String,
}

/// The outcome of `delete_workspace_meetings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeleteMeetingsReport {
    pub deleted: usize,
    pub failed: Vec<FailedMeeting>,
}

/// What `update_workspace_item` changes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ItemPatch {
    #[serde(deserialize_with = "clearable")]
    pub label: Option<Option<String>>,
    pub pinned: Option<bool>,
    pub index_opt_in: Option<bool>,
}

/// What happens to a workspace's meetings, chats and talking points when it
/// is deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMode {
    Move,
    Delete,
}

/// A meeting's home and the workspaces it also uses now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingScope {
    pub meeting_id: String,
    pub home: String,
    /// Borrowed workspaces in use (removed ones are not listed).
    pub borrowed: Vec<String>,
    /// Every workspace whose material the meeting uses: home, borrowed, and
    /// General when the home includes it (from `scope_for`).
    pub effective: Vec<String>,
}

/// A page of a workspace's meetings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMeetingPage {
    pub meetings: Vec<crate::db::meetings::MeetingSummary>,
    pub total: i64,
}

/// A talking point: the user's own formatted note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TalkingPoint {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    /// The TipTap document as JSON text.
    pub doc_json: String,
    pub markdown: String,
    pub plain_text: String,
    pub in_context: bool,
    pub sort: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One block (by stable id) the user has said or ticked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PointSaid {
    pub block_id: String,
    /// `voice` or `manual` (the user's own choice wins).
    pub by: String,
    pub ticked: bool,
}

/// "Said it" state of one note in one meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PointProgress {
    pub meeting_id: String,
    pub point_id: String,
    pub said: Vec<PointSaid>,
}

/// The content a new talking point is created with, in one step. `in_context`
/// ("use as AI context") has no default: a request without it is refused.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalkingContent {
    pub doc_json: Option<String>,
    pub markdown: Option<String>,
    pub plain_text: Option<String>,
    pub in_context: bool,
}

/// What `patch_talking_point` changes: only the fields present.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TalkingPointPatch {
    pub title: Option<String>,
    pub doc_json: Option<String>,
    pub markdown: Option<String>,
    pub plain_text: Option<String>,
    pub in_context: Option<bool>,
}

/// Stable error texts of the talking point and memory commands.
pub const NOT_FOUND: &str = "not_found";
pub const CONFLICT: &str = "conflict";

/// What `create_memory` takes (the id is made here; a deleted one never comes back).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCreate {
    pub workspace_id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub source_meeting: Option<String>,
    pub source_ms: Option<i64>,
    /// `saved` when absent (the user typed it).
    pub status: Option<String>,
    /// A suggestion whose names or numbers are not in the transcript near its source.
    pub unsupported: bool,
}

/// What `update_memory` changes: only the fields present.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryUpdate {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub text: Option<String>,
    pub status: Option<String>,
}

/// A memory kind.
pub const MEMORY_KINDS: [&str; 5] = ["person", "decision", "open_item", "fact", "preference"];
/// A memory status.
pub const MEMORY_STATUSES: [&str; 3] = ["suggested", "saved", "dismissed"];

/// A fact the user approved (or was offered) for a workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub source_meeting: Option<String>,
    pub source_ms: Option<i64>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Suggested from a meeting but not found in its transcript (the UI says so).
    #[serde(default)]
    pub unsupported: bool,
}

/// What `resolve_memory` may change on the way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPatch {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub text: Option<String>,
}

/// Why workspaces may be unavailable in this run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspacesStatus {
    pub available: bool,
    /// The recorded error of a failed upgrade, shown to the user.
    pub error: Option<String>,
}

#[cfg(test)]
mod contract {
    //! The key sets of what the webview receives, written out from
    //! `src/lib/types.ts`. A field added or renamed on one side only fails here.

    use super::*;
    use serde_json::Value;

    fn keys<T: Serialize>(value: &T) -> Vec<String> {
        let Value::Object(map) = serde_json::to_value(value).unwrap() else { panic!("not an object") };
        let mut keys: Vec<String> = map.keys().cloned().collect();
        keys.sort();
        keys
    }

    fn expect(list: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    fn summary() -> WorkspaceSummary {
        WorkspaceSummary {
            id: "w".into(),
            name: "n".into(),
            icon: None,
            color: None,
            description: String::new(),
            include_general: false,
            keep_separate: false,
            default_scenario: None,
            is_default: false,
            pinned: false,
            archived: false,
            sort: 0,
            meeting_count: 0,
            chat_count: 0,
            item_count: 0,
            last_activity: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn item(kind: ItemKind) -> WorkspaceItem {
        WorkspaceItem {
            workspace_id: "w".into(),
            kind,
            ref_id: "r".into(),
            label: None,
            name: "n".into(),
            pinned: false,
            status: "ready".into(),
            detail: None,
            tokens: None,
            index_opt_in: (kind == ItemKind::Folder).then_some(false),
            added_at: 0,
        }
    }

    #[test]
    fn summary_detail_and_item_match_types_ts() {
        let base = [
            "id", "name", "icon", "color", "description", "include_general", "keep_separate", "default_scenario",
            "is_default", "pinned", "archived", "sort", "meeting_count", "chat_count", "item_count", "last_activity",
            "created_at", "updated_at",
        ];
        assert_eq!(keys(&summary()), expect(&base));
        let detail = WorkspaceDetail {
            summary: summary(),
            instructions: String::new(),
            recaps_with_ai: false,
            suggest_memory: false,
            brief_enabled: false,
            items: vec![],
        };
        let mut with_detail = base.to_vec();
        with_detail.extend(["instructions", "recaps_with_ai", "suggest_memory", "brief_enabled", "items"]);
        assert_eq!(keys(&detail), expect(&with_detail));
        let item_keys = ["workspace_id", "kind", "ref_id", "label", "name", "pinned", "status", "detail", "tokens", "added_at"];
        assert_eq!(keys(&item(ItemKind::Document)), expect(&item_keys));
        let mut folder = item_keys.to_vec();
        folder.push("index_opt_in");
        assert_eq!(keys(&item(ItemKind::Folder)), expect(&folder));
    }

    #[test]
    fn library_scope_page_point_and_memory_match_types_ts() {
        let lib = LibraryItem {
            kind: ItemKind::Server,
            ref_id: "r".into(),
            name: "n".into(),
            status: "ready".into(),
            detail: None,
            tokens: None,
            workspace_ids: vec![],
            unfiled: true,
        };
        assert_eq!(keys(&lib), expect(&["kind", "ref_id", "name", "status", "detail", "tokens", "workspace_ids", "unfiled"]));
        let scope = MeetingScope { meeting_id: "m".into(), home: "h".into(), borrowed: vec![], effective: vec![] };
        assert_eq!(keys(&scope), expect(&["meeting_id", "home", "borrowed", "effective"]));
        let page = WorkspaceMeetingPage { meetings: vec![], total: 0 };
        assert_eq!(keys(&page), expect(&["meetings", "total"]));
        let point = TalkingPoint {
            id: "p".into(),
            workspace_id: "w".into(),
            title: String::new(),
            doc_json: "{}".into(),
            markdown: String::new(),
            plain_text: String::new(),
            in_context: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(
            keys(&point),
            expect(&["id", "workspace_id", "title", "doc_json", "markdown", "plain_text", "in_context", "sort", "created_at", "updated_at"])
        );
        let said = PointSaid { block_id: "b".into(), by: "voice".into(), ticked: true };
        assert_eq!(keys(&said), expect(&["block_id", "by", "ticked"]));
        let progress = PointProgress { meeting_id: "m".into(), point_id: "p".into(), said: vec![said] };
        assert_eq!(keys(&progress), expect(&["meeting_id", "point_id", "said"]));
        let memory = MemoryItem {
            id: "i".into(),
            workspace_id: "w".into(),
            kind: "fact".into(),
            title: String::new(),
            text: String::new(),
            source_meeting: None,
            source_ms: None,
            status: "saved".into(),
            created_at: 0,
            updated_at: 0,
            unsupported: false,
        };
        assert_eq!(
            keys(&memory),
            expect(&["id", "workspace_id", "kind", "title", "text", "source_meeting", "source_ms", "status", "created_at", "updated_at", "unsupported"])
        );
    }

    #[test]
    fn inputs_accept_what_types_ts_sends() {
        let input: CreateWorkspaceInput = serde_json::from_str(r#"{"name":"A","icon":null,"color":"teal"}"#).unwrap();
        assert!(!input.include_general && !input.keep_separate);
        let patch: WorkspacePatch =
            serde_json::from_str(r#"{"recaps_with_ai":true,"suggest_memory":false,"default_scenario":null}"#).unwrap();
        assert_eq!(patch.recaps_with_ai, Some(true));
        assert_eq!(patch.default_scenario, Some(None));
        let item: ItemPatch = serde_json::from_str(r#"{"label":null,"pinned":true,"index_opt_in":true}"#).unwrap();
        assert_eq!(item.index_opt_in, Some(true));
        let mode: DeleteMode = serde_json::from_str(r#""move""#).unwrap();
        assert_eq!(mode, DeleteMode::Move);
    }
}
