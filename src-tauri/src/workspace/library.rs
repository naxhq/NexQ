//! The library: documents, folders and MCP servers, each once. Workspaces
//! point to them. This turns what the app holds (loaded documents, the
//! saved sources) and the memberships into what the webview lists.

use std::collections::HashMap;
use std::path::Path;

use crate::context::ContextResource;
use crate::sources::config::PersonalSourcesConfig;

use super::types::*;

/// What the library holds right now.
#[derive(Debug, Clone, Default)]
pub struct LibrarySnapshot {
    pub items: Vec<LibraryEntry>,
}

/// One library item as the app holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryEntry {
    pub kind: ItemKind,
    pub ref_id: String,
    pub label: String,
    pub detail: Option<String>,
    pub status: String,
    pub tokens: Option<i64>,
}

impl LibrarySnapshot {
    /// The loaded documents and the saved folders and servers.
    pub fn from_app(resources: &[ContextResource], sources: &PersonalSourcesConfig) -> Self {
        let mut items = Vec::new();
        for r in resources {
            items.push(LibraryEntry {
                kind: ItemKind::Document,
                ref_id: r.id.clone(),
                label: r.name.clone(),
                detail: Some(r.file_type.clone()),
                status: match r.status.as_str() {
                    "loading" => "indexing".to_string(),
                    other => other.to_string(),
                },
                tokens: Some(r.token_count as i64),
            });
        }
        for f in &sources.notes_folders {
            let status = if !f.enabled {
                "off"
            } else if !Path::new(&f.path).is_dir() {
                "missing"
            } else {
                "ready"
            };
            items.push(LibraryEntry {
                kind: ItemKind::Folder,
                ref_id: f.id.clone(),
                label: f.label.clone(),
                detail: Some(f.path.clone()),
                status: status.to_string(),
                tokens: None,
            });
        }
        for s in &sources.mcp_servers {
            let status = if !s.enabled {
                "off"
            } else if s.needs_sign_in {
                "error"
            } else {
                "ready"
            };
            let kind = match s.transport {
                crate::sources::config::McpTransport::Stdio { .. } => "stdio",
                crate::sources::config::McpTransport::Http { .. } => "http",
            };
            items.push(LibraryEntry {
                kind: ItemKind::Server,
                ref_id: s.id.clone(),
                label: s.label.clone(),
                detail: if s.needs_sign_in { Some("Needs sign-in".to_string()) } else { Some(kind.to_string()) },
                status: status.to_string(),
                tokens: None,
            });
        }
        Self { items }
    }

    fn find(&self, kind: ItemKind, ref_id: &str) -> Option<&LibraryEntry> {
        self.items.iter().find(|e| e.kind == kind && e.ref_id == ref_id)
    }
}

/// A workspace's items with the library item each points to resolved. An item
/// the library no longer holds shows as missing.
pub fn resolve_items(workspace_id: &str, items: &[ItemRow], library: &LibrarySnapshot) -> Vec<WorkspaceItem> {
    items
        .iter()
        .map(|item| {
            let entry = library.find(item.kind, &item.ref_id);
            WorkspaceItem {
                workspace_id: workspace_id.to_string(),
                kind: item.kind,
                ref_id: item.ref_id.clone(),
                label: item.label.clone(),
                name: entry.map(|e| e.label.clone()).or_else(|| item.label.clone()).unwrap_or_else(|| item.ref_id.clone()),
                pinned: item.pinned,
                status: entry.map(|e| e.status.clone()).unwrap_or_else(|| "missing".to_string()),
                detail: entry.and_then(|e| e.detail.clone()),
                tokens: entry.and_then(|e| e.tokens),
                index_opt_in: (item.kind == ItemKind::Folder).then_some(item.index_opt_in),
                added_at: item.added_at,
            }
        })
        .collect()
}

/// The whole library with the workspaces that use each item; one that no
/// workspace uses has an empty list and is unfiled (used nowhere).
pub fn library_items(memberships: &HashMap<(ItemKind, String), Vec<String>>, library: &LibrarySnapshot) -> Vec<LibraryItem> {
    library
        .items
        .iter()
        .map(|e| {
            let workspace_ids = memberships.get(&(e.kind, e.ref_id.clone())).cloned().unwrap_or_default();
            LibraryItem {
                kind: e.kind,
                ref_id: e.ref_id.clone(),
                name: e.label.clone(),
                detail: e.detail.clone(),
                status: e.status.clone(),
                tokens: e.tokens,
                unfiled: workspace_ids.is_empty(),
                workspace_ids,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{McpServer, NotesFolder};

    fn resource(id: &str, status: &str) -> ContextResource {
        ContextResource {
            id: id.into(),
            name: format!("{id}.txt"),
            file_type: "txt".into(),
            file_path: String::new(),
            size_bytes: 1,
            token_count: 10,
            preview: String::new(),
            loaded_at: String::new(),
            status: status.into(),
        }
    }

    #[test]
    fn the_library_lists_everything_with_status_and_the_workspaces_using_it() {
        let sources = PersonalSourcesConfig {
            notes_folders: vec![NotesFolder { id: "f1".into(), label: "Vault".into(), path: "Z:/does/not/exist".into(), enabled: true }],
            mcp_servers: vec![McpServer { id: "s1".into(), key: "s1".into(), label: "Tools".into(), enabled: false, ..Default::default() }],
            ..Default::default()
        };
        let lib = LibrarySnapshot::from_app(&[resource("d1", "ready"), resource("d2", "missing")], &sources);
        let mut members = HashMap::new();
        members.insert((ItemKind::Document, "d1".to_string()), vec!["general".to_string()]);
        let items = library_items(&members, &lib);
        assert_eq!(items.len(), 4);
        let status = |id: &str| items.iter().find(|i| i.ref_id == id).unwrap().status.clone();
        assert_eq!((status("d1").as_str(), status("d2").as_str(), status("f1").as_str(), status("s1").as_str()), ("ready", "missing", "missing", "off"));
        assert_eq!(items.iter().find(|i| i.ref_id == "d1").unwrap().workspace_ids, vec!["general"]);
        assert!(items.iter().find(|i| i.ref_id == "d2").unwrap().unfiled);
    }

    #[test]
    fn a_membership_of_a_vanished_item_shows_as_missing_with_its_own_label() {
        let lib = LibrarySnapshot::default();
        let item = ItemRow { kind: ItemKind::Folder, ref_id: "gone".into(), label: Some("Old notes".into()), pinned: false, index_opt_in: true, added_at: 1 };
        let resolved = resolve_items("w", &[item], &lib);
        assert_eq!((resolved[0].name.as_str(), resolved[0].status.as_str()), ("Old notes", "missing"));
        assert_eq!(resolved[0].index_opt_in, Some(true));
    }
}
