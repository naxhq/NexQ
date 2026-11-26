//! The indexer's inputs from the workspace data: documents (their saved
//! text), folders linked to a workspace's Library, talking points marked as AI
//! context. Each call reads the database fresh through its own connection. A
//! read that fails is an error (the pass then leaves the index as it is).

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
    fn conn(&self) -> Result<Connection, String> {
        crate::db::open_reader(&self.db_path).map_err(|e| format!("Couldn't open the database: {e}"))
    }
}

fn read_err(what: &str, e: rusqlite::Error) -> String {
    format!("Couldn't read {what}: {e}")
}

impl IndexProvider for WorkspaceIndexProvider {
    fn documents(&self) -> Result<Vec<DocInput>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.name, t.text FROM context_resources r
                 JOIN document_text t ON t.resource_id = r.id WHERE t.status = 'ready'",
            )
            .map_err(|e| read_err("the documents", e))?;
        let rows = stmt
            .query_map([], |r| Ok(DocInput { id: r.get(0)?, name: r.get(1)?, text: r.get(2)? }))
            .map_err(|e| read_err("the documents", e))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| read_err("the documents", e))
    }

    fn folders(&self) -> Result<Vec<FolderInput>, String> {
        let conn = self.conn()?;
        let linked: std::collections::HashSet<String> = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT ref_id FROM workspace_items WHERE kind = 'folder'")
                .map_err(|e| read_err("the folders", e))?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| read_err("the folders", e))?;
            rows.collect::<Result<_, _>>().map_err(|e| read_err("the folders", e))?
        };
        let cfg = self.sources.read().map_err(|_| "Couldn't read your sources".to_string())?.clone();
        Ok(cfg
            .notes_folders
            .iter()
            .map(|f| FolderInput {
                id: f.id.clone(),
                path: PathBuf::from(&f.path),
                // a folder that is switched off in Settings stays off; one linked to a workspace is used
                index_enabled: f.enabled && linked.contains(&f.id),
            })
            .collect())
    }

    fn talking_points(&self) -> Result<Vec<TalkingPointInput>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare("SELECT id, title, plain_text, in_context FROM talking_points")
            .map_err(|e| read_err("the talking points", e))?;
        let rows = stmt
            .query_map([], |r| {
                // stored as written; what is indexed (and later quoted) has no hidden characters
                let (title, text): (String, String) = (r.get(1)?, r.get(2)?);
                Ok(TalkingPointInput {
                    id: r.get(0)?,
                    title: crate::prompt_data::strip_hidden(&title),
                    plain_text: crate::prompt_data::strip_hidden(&text),
                    in_context: r.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|e| read_err("the talking points", e))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| read_err("the talking points", e))
    }
}
