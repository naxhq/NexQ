//! v11: chats, their messages and the "include this meeting" choices. (v10,
//! the search index, lives in `workspace_search::migrate`.)

use rusqlite::Connection;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspace_chats (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    provider        TEXT NULL,
    model           TEXT NULL,
    effort          TEXT NULL,
    depth           TEXT NOT NULL DEFAULT 'balanced',
    include_meetings INTEGER NOT NULL DEFAULT 1,
    condensed       TEXT NULL,
    condensed_upto  INTEGER NULL,
    nonce           TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_chats_ws ON workspace_chats(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS workspace_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        TEXT NOT NULL,
    role           TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content        TEXT NOT NULL,
    model          TEXT NULL,
    citations_json TEXT NOT NULL DEFAULT '[]',
    context_json   TEXT NULL,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_messages_chat ON workspace_messages(chat_id, id);

CREATE TABLE IF NOT EXISTS workspace_chat_item_prefs (
    chat_id TEXT NOT NULL,
    kind    TEXT NOT NULL,
    ref_id  TEXT NOT NULL,
    pref    TEXT NOT NULL CHECK(pref IN ('pin','exclude')),
    PRIMARY KEY (chat_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS workspace_meeting_prefs (
    workspace_id TEXT NOT NULL,
    chat_id      TEXT NOT NULL DEFAULT '',
    meeting_id   TEXT NOT NULL,
    included     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, chat_id, meeting_id)
);
";

/// Creates the chat tables. Idempotent.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
}
