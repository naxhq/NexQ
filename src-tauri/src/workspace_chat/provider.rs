//! The indexer's inputs from the workspace data: documents (their saved
//! text), folders the user opted in to index, talking points marked as AI
//! context. Each call reads the database fresh through its own connection.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use rusqlite::Connection;

use crate::sources::config::PersonalSourcesConfig;
use crate::workspace_search::indexer::{DocInput, FolderInput, IndexProvider, TalkingPointInput};

pub struct WorkspaceIndexProvider {
    pub db_path: PathBuf,
    pub sources: Arc<RwLock<PersonalSourcesConfig>>,
}

impl WorkspaceIndexProvider {
    fn conn(&self) -> Option<Connection> {
        crate::db::open_reader(&self.db_path).ok()
    }
}

impl IndexProvider for WorkspaceIndexProvider {
    fn documents(&self) -> Vec<DocInput> {
        let Some(conn) = self.conn() else { return Vec::new() };
        let Ok(mut stmt) = conn.prepare(
            "SELECT r.id, r.name, t.text FROM context_resources r
             JOIN document_text t ON t.resource_id = r.id WHERE t.status = 'ready'",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| Ok(DocInput { id: r.get(0)?, name: r.get(1)?, text: r.get(2)? }));
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn folders(&self) -> Vec<FolderInput> {
        let Some(conn) = self.conn() else { return Vec::new() };
        let opted: std::collections::HashSet<String> = conn
            .prepare("SELECT DISTINCT ref_id FROM workspace_items WHERE kind = 'folder' AND index_opt_in = 1")
            .ok()
            .map(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(|r| r.ok()).collect()).unwrap_or_default()
            })
            .unwrap_or_default();
        let cfg = self.sources.read().map(|c| c.clone()).unwrap_or_default();
        cfg.notes_folders
            .iter()
            .map(|f| FolderInput {
                id: f.id.clone(),
                path: PathBuf::from(&f.path),
                // a folder that is switched off in Settings stays off
                index_enabled: f.enabled && opted.contains(&f.id),
            })
            .collect()
    }

    fn talking_points(&self) -> Vec<TalkingPointInput> {
        let Some(conn) = self.conn() else { return Vec::new() };
        let Ok(mut stmt) = conn.prepare("SELECT id, title, plain_text, in_context FROM talking_points") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(TalkingPointInput { id: r.get(0)?, title: r.get(1)?, plain_text: r.get(2)?, in_context: r.get::<_, i64>(3)? != 0 })
        });
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }
}
