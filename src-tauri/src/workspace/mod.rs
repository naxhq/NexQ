//! Workspaces: named places for meetings, chats and material. The library
//! (documents, folders, MCP servers) exists once; workspaces point to it, and
//! [`scope::scope_for`] decides what each meeting or chat may use.

pub mod documents;
pub mod library;
pub mod memory;
pub mod meetings;
pub mod purge;
pub mod reveal;
pub mod rules;
pub mod runtime;
pub mod scope;
pub mod sources_seed;
pub mod store;
pub mod talking_points;
pub mod types;

#[cfg(test)]
mod property_tests;

pub use crate::db::workspace_migrations::{available, last_error};
pub use scope::{scope_for, EffectiveScope, ScopeOwner};
pub use types::GENERAL_ID;

#[cfg(test)]
pub mod test_support {
    //! Shared helpers for the tests of this module.

    use rusqlite::{params, Connection};

    use super::store;
    use super::types::CreateWorkspaceInput;
    use crate::db::migrations;
    use crate::db::workspace_migrations::{run_steps, STEPS};

    /// An in-memory database as the app has it after all migrations.
    pub fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        run_steps(&conn, None, STEPS).unwrap();
        conn
    }

    /// A new workspace; returns its id.
    pub fn new_ws(conn: &Connection, name: &str, include_general: bool, keep_separate: bool) -> String {
        store::create_workspace(
            conn,
            CreateWorkspaceInput { name: name.into(), include_general, keep_separate, ..Default::default() },
        )
        .unwrap()
        .id
    }

    /// Files a library item in a workspace without checking it exists.
    pub fn file(conn: &Connection, workspace_id: &str, kind: &str, ref_id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO workspace_items (workspace_id, kind, ref_id, added_at) VALUES (?1, ?2, ?3, 0)",
            params![workspace_id, kind, ref_id],
        )
        .unwrap();
    }
}
