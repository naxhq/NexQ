//! Workspace search: passages, FTS5 index, folder crawler, background indexer,
//! meeting cards and the context ladder (spec sections 2 v10, 4 and 12).
//!
//! Everything here is independent of the workspaces data layer: the caller
//! passes the scope as a plain [`SearchScope`] and the indexer reads its
//! inputs through [`indexer::IndexProvider`]. Search and indexing use their
//! own SQLite connections (WAL, busy timeout), never the shared locked one.
#![allow(dead_code)]

pub mod cards;
pub mod cjk;
pub mod context_plan;
pub mod crawler;
pub mod indexer;
pub mod migrate;
pub mod passages;
pub mod search;
pub mod store;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_bench;
#[cfg(test)]
mod tests_eval;

use serde::{Deserialize, Serialize};

pub use cards::{build_card, card_key, Card, CardInput, CardOrigin};
pub use context_plan::{
    build_context, validate_citations, Citation, ContextEnv, ContextInput, ContextPlan, Depth,
    Strategy,
};
pub use crawler::{crawl_folder, CrawlOptions, CrawlResult, SkippedFile};
pub use indexer::{
    open_search_connection, FolderInput, IndexProgress, IndexProvider, IndexerService,
};
pub use migrate::migrate_search;
pub use search::{search, search_with, SearchOptions};

/// What a passage was cut from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassageKind {
    Transcript,
    Document,
    Folder,
    TalkingPoint,
}

impl PassageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            PassageKind::Transcript => "transcript",
            PassageKind::Document => "document",
            PassageKind::Folder => "folder",
            PassageKind::TalkingPoint => "talking_point",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "transcript" => Some(Self::Transcript),
            "document" => Some(Self::Document),
            "folder" => Some(Self::Folder),
            "talking_point" => Some(Self::TalkingPoint),
            _ => None,
        }
    }
}

/// Which meetings a search may see. Meetings come from the home workspace
/// only (spec section 12); the caller decides what that means.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum MeetingScope {
    /// No meetings at all (the safe default).
    #[default]
    None,
    /// An explicit set of meeting ids.
    Ids(Vec<String>),
    /// Every meeting whose `meetings.workspace_id` equals this id (needs the
    /// v9 column; the explicit list is the safer, column-free form).
    HomeWorkspace(String),
}

/// The effective scope of one search or one chat question. Anything not
/// listed here can never appear in a result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchScope {
    pub meetings: MeetingScope,
    pub document_ids: Vec<String>,
    pub folder_ids: Vec<String>,
    pub talking_point_ids: Vec<String>,
    /// Meetings the user switched off for this chat: removed from `meetings`
    /// even when listed or matched by the workspace predicate.
    pub excluded_meeting_ids: Vec<String>,
}

impl SearchScope {
    pub fn with_meetings<S: Into<String>>(ids: impl IntoIterator<Item = S>) -> Self {
        SearchScope {
            meetings: MeetingScope::Ids(ids.into_iter().map(Into::into).collect()),
            ..Default::default()
        }
    }
    pub fn is_empty(&self) -> bool {
        matches!(self.meetings, MeetingScope::None)
            && self.document_ids.is_empty()
            && self.folder_ids.is_empty()
            && self.talking_point_ids.is_empty()
    }
}

/// One search hit. Offsets in `match_ranges` are UTF-16 code units inside
/// `snippet` (what JavaScript string indexing uses).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Passage {
    pub id: i64,
    pub kind: String,
    pub ref_id: String,
    pub sub_ref: Option<String>,
    pub title: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub text: String,
    pub tokens: usize,
    pub occurred_at: Option<i64>,
    /// Final rank score (relevance times recency), 0..~1.25.
    pub score: f32,
    /// Absolute lexical relevance 0..1 before recency (used by the floor).
    pub relevance: f32,
    pub snippet: String,
    pub match_ranges: Vec<(u32, u32)>,
}

/// Index status of one source, for the settings and library pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceStatus {
    pub kind: String,
    pub ref_id: String,
    pub sub_ref: String,
    pub status: String,
    pub error: Option<String>,
    pub indexed_at: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
