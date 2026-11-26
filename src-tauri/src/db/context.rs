use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::DatabaseError;

// ── Data structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextResource {
    pub id: String,
    pub name: String,
    pub file_type: String,
    pub file_path: String,
    pub size_bytes: i64,
    pub token_count: i64,
    pub preview: String,
    pub loaded_at: String,
}

// ── CRUD operations ──────────────────────────────────────────────────────────

/// Insert a new context resource record.
pub fn add_context_resource(
    conn: &Connection,
    resource: &ContextResource,
) -> Result<(), DatabaseError> {
    conn.execute(
        "INSERT INTO context_resources (id, name, file_type, file_path, size_bytes, token_count, preview, loaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            resource.id,
            resource.name,
            resource.file_type,
            resource.file_path,
            resource.size_bytes,
            resource.token_count,
            resource.preview,
            resource.loaded_at,
        ],
    )?;

    Ok(())
}

/// Changes what an edited note shows: its name, size, token count and preview.
pub fn update_context_resource_text(conn: &Connection, resource: &ContextResource) -> Result<(), DatabaseError> {
    conn.execute(
        "UPDATE context_resources SET name = ?2, size_bytes = ?3, token_count = ?4, preview = ?5 WHERE id = ?1",
        params![resource.id, resource.name, resource.size_bytes, resource.token_count, resource.preview],
    )?;
    Ok(())
}

/// Get a single context resource by ID.
pub fn get_context_resource(
    conn: &Connection,
    id: &str,
) -> Result<ContextResource, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_type, file_path, size_bytes, token_count, preview, loaded_at
         FROM context_resources WHERE id = ?1",
    )?;

    stmt.query_row(params![id], |row| {
        Ok(ContextResource {
            id: row.get(0)?,
            name: row.get(1)?,
            file_type: row.get(2)?,
            file_path: row.get(3)?,
            size_bytes: row.get(4)?,
            token_count: row.get(5)?,
            preview: row.get(6)?,
            loaded_at: row.get(7)?,
        })
    })
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            DatabaseError::NotFound(format!("Context resource {} not found", id))
        }
        other => DatabaseError::Query(other.to_string()),
    })
}

/// List all context resources, ordered by most recently loaded.
pub fn list_context_resources(conn: &Connection) -> Result<Vec<ContextResource>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_type, file_path, size_bytes, token_count, preview, loaded_at
         FROM context_resources
         ORDER BY loaded_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ContextResource {
            id: row.get(0)?,
            name: row.get(1)?,
            file_type: row.get(2)?,
            file_path: row.get(3)?,
            size_bytes: row.get(4)?,
            token_count: row.get(5)?,
            preview: row.get(6)?,
            loaded_at: row.get(7)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Delete a context resource by ID.
pub fn delete_context_resource(conn: &Connection, id: &str) -> Result<(), DatabaseError> {
    let rows = conn.execute("DELETE FROM context_resources WHERE id = ?1", params![id])?;
    if rows == 0 {
        return Err(DatabaseError::NotFound(format!(
            "Context resource {} not found",
            id
        )));
    }
    Ok(())
}
