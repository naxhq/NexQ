//! The scope of a request as the running app resolves it: from the database
//! behind `AppState`, with the talking points a prompt may carry. Used by
//! everything that assembles context for an answer.

use crate::llm::cli_agent::manager::SessionScope;
use crate::sources::config::PersonalSourcesConfig;
use crate::db::workspace_migrations::TablesState;
use crate::state::AppState;

use super::scope::{scope_for, scope_for_home, EffectiveScope, ScopeOwner};
use super::store;
use super::talking_points::{context_texts, PointText};

/// A scope with the plain text of its context-flagged talking points.
#[derive(Debug, Clone, Default)]
pub struct ScopedContext {
    pub scope: EffectiveScope,
    pub points: Vec<PointText>,
}

impl ScopedContext {
    /// No filtering (workspaces unavailable).
    pub fn unrestricted() -> Self {
        Self { scope: EffectiveScope::unrestricted(), points: Vec::new() }
    }

    /// Nothing at all: used when the scope could not be worked out, so that a
    /// failure never lets material through.
    pub fn nothing() -> Self {
        Self { scope: EffectiveScope { home: super::GENERAL_ID.to_string(), ..Default::default() }, points: Vec::new() }
    }
}

/// Whose scope to resolve for a request.
enum Who<'a> {
    Meeting(&'a str),
    DefaultWorkspace,
}

/// What to do for a request, from whether workspaces are available and what is
/// known about their tables.
#[derive(Debug, PartialEq)]
pub(crate) enum Policy {
    /// Resolve the scope.
    Normal,
    /// The workspace tables are confirmed absent: as before workspaces existed.
    Unrestricted,
    /// The tables exist or can't be told: no workspace material at all.
    FailClosed,
}

pub(crate) fn policy(available: bool, tables: TablesState) -> Policy {
    match (available, tables) {
        (true, _) => Policy::Normal,
        (false, TablesState::Absent) => Policy::Unrestricted,
        (false, TablesState::Present | TablesState::Unknown) => Policy::FailClosed,
    }
}

/// The text shown when a request can't use a workspace's material.
pub const MATERIAL_UNAVAILABLE: &str = "NexQ couldn't read this workspace's material, so answers don't use it";

/// Event `workspace_material_unavailable` `{ meeting_id: string | null, message: string }`.
#[derive(serde::Serialize, Clone)]
pub struct MaterialUnavailable {
    pub meeting_id: Option<String>,
    pub message: &'static str,
}

/// Nothing is used, and the user is told, once per meeting.
/// The event payload, built in one place so the contract test sees the real thing.
pub fn unavailable_payload(meeting: Option<&str>) -> MaterialUnavailable {
    MaterialUnavailable { meeting_id: meeting.map(str::to_string), message: MATERIAL_UNAVAILABLE }
}

fn fail_closed(state: &AppState, meeting: Option<&str>, why: &str) -> ScopedContext {
    log::warn!("Workspace material is not used: {why}");
    let key = meeting.unwrap_or("default").to_string();
    let first = state.material_warned.lock().map(|mut w| w.insert(key)).unwrap_or(false);
    if first {
        if let Some(app) = state.app_handle.get() {
            use tauri::Emitter;
            let _ = app.emit(
                "workspace_material_unavailable",
                unavailable_payload(meeting),
            );
        }
    }
    ScopedContext::nothing()
}

fn resolve(state: &AppState, who: Who<'_>) -> ScopedContext {
    let meeting = match &who {
        Who::Meeting(id) => Some(*id),
        Who::DefaultWorkspace => None,
    };
    match policy(super::available(), crate::db::workspace_migrations::tables_state()) {
        Policy::Unrestricted => return ScopedContext::unrestricted(),
        Policy::FailClosed => return fail_closed(state, meeting, "the workspaces could not be set up or read"),
        Policy::Normal => {}
    }
    // No database: nothing can be filed anywhere, so there is no material to use.
    let Some(db) = state.database.as_ref() else {
        return fail_closed(state, meeting, "there is no database");
    };
    let Ok(guard) = db.lock() else {
        return fail_closed(state, meeting, "the database is locked");
    };
    let conn = guard.connection();
    let scope = match who {
        Who::Meeting(id) => scope_for(conn, ScopeOwner::Meeting(id)),
        Who::DefaultWorkspace => scope_for_home(conn, &store::default_workspace_id(conn), &[]),
    };
    match scope.and_then(|scope| context_texts(conn, meeting, &scope).map(|points| ScopedContext { scope, points })) {
        Ok(ctx) => ctx,
        Err(e) => fail_closed(state, meeting, &format!("the scope could not be read ({e})")),
    }
}

/// The scope and context talking points of one meeting.
pub fn for_meeting(state: &AppState, meeting_id: &str) -> ScopedContext {
    resolve(state, Who::Meeting(meeting_id))
}

/// The scope of work that belongs to no meeting: the default workspace's.
pub fn for_default(state: &AppState) -> ScopedContext {
    resolve(state, Who::DefaultWorkspace)
}

/// The scope of the running meeting, else the default workspace's.
pub fn for_live_or_default(state: &AppState) -> ScopedContext {
    let live = state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()));
    match live {
        Some(id) => for_meeting(state, &id),
        None => for_default(state),
    }
}

/// The scope of a session: a live or past meeting's own, else the default's.
pub fn for_session_scope(state: &AppState, scope: &SessionScope) -> ScopedContext {
    match scope {
        SessionScope::Live(id) | SessionScope::Past(id) => for_meeting(state, id),
        _ => for_default(state),
    }
}

/// The scope of a request that may name a past meeting (else the running one).
pub fn for_request(state: &AppState, past_meeting_id: Option<&str>) -> ScopedContext {
    match past_meeting_id.filter(|id| !id.is_empty()) {
        Some(id) => for_meeting(state, id),
        None => for_live_or_default(state),
    }
}

/// The saved sources cut down to what a scope may use: a folder or server
/// outside it is left out, and one that is switched off stays off. The launch
/// is then built from this exactly as before.
pub fn scoped_sources(cfg: &PersonalSourcesConfig, scope: &EffectiveScope) -> PersonalSourcesConfig {
    if scope.unrestricted {
        return cfg.clone();
    }
    PersonalSourcesConfig {
        notes_folders: cfg.notes_folders.iter().filter(|f| scope.allows_folder(&f.id)).cloned().collect(),
        mcp_servers: cfg.mcp_servers.iter().filter(|s| scope.allows_server(&s.id)).cloned().collect(),
        mcp_notice_seen: cfg.mcp_notice_seen,
    }
}

/// What a with-sources session was launched for: the sources the scope may use
/// (see `PersonalSourcesConfig::launch_fingerprint`) and the scope itself, so a
/// change of either restarts it.
pub fn launch_fingerprint(cfg: &PersonalSourcesConfig, scope: &EffectiveScope) -> String {
    format!("{}|{}", scoped_sources(cfg, scope).launch_fingerprint(), scope.fingerprint())
}

/// The saved sources a request's scope may use.
pub fn sources_for(state: &AppState, scope: &EffectiveScope) -> Result<PersonalSourcesConfig, String> {
    let cfg = state
        .personal_sources
        .read()
        .map_err(|_| "Couldn't read your sources".to_string())?
        .clone();
    Ok(scoped_sources(&cfg, scope))
}

/// The custom instructions with the scope's workspace instructions after them.
pub fn instructions_with_workspace(custom: &str, scope: &EffectiveScope) -> String {
    // read as it is shown: hidden characters (older saved text may still have some) are taken out
    let cleaned = crate::prompt_data::strip_hidden(&scope.instructions);
    let workspace = cleaned.trim();
    match (custom.trim().is_empty(), workspace.is_empty()) {
        (_, true) => custom.to_string(),
        (true, false) => format!("Workspace instructions: {workspace}"),
        (false, false) => format!("{}\n\nWorkspace instructions: {workspace}", custom.trim()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{McpServer, NotesFolder};

    fn cfg() -> PersonalSourcesConfig {
        PersonalSourcesConfig {
            notes_folders: vec![
                NotesFolder { id: "fa".into(), label: "A vault".into(), path: "x".into(), enabled: true },
                NotesFolder { id: "fb".into(), label: "B vault".into(), path: "y".into(), enabled: true },
                NotesFolder { id: "off".into(), label: "Off".into(), path: "z".into(), enabled: false },
            ],
            mcp_servers: vec![
                McpServer { id: "sa".into(), key: "sa".into(), label: "A tools".into(), enabled: true, ..Default::default() },
                McpServer { id: "sb".into(), key: "sb".into(), label: "B tools".into(), enabled: true, ..Default::default() },
            ],
            mcp_notice_seen: true,
        }
    }

    #[test]
    fn sources_are_cut_to_the_scope_and_a_globally_off_one_stays_off() {
        let scope = EffectiveScope {
            folder_ids: vec!["fa".into(), "off".into()],
            server_ids: vec!["sa".into()],
            ..Default::default()
        };
        let cut = scoped_sources(&cfg(), &scope);
        let folders: Vec<&str> = cut.notes_folders.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(folders, vec!["A vault", "Off"]);
        assert_eq!(cut.mcp_servers.len(), 1);
        assert_eq!(cut.mcp_servers[0].label, "A tools");
        // "Off" is in the scope but disabled globally: still not enabled.
        assert_eq!(cut.enabled_folders().len(), 1);
        // Nothing in scope: nothing to launch.
        assert!(!scoped_sources(&cfg(), &EffectiveScope::default()).has_enabled());
        // Unrestricted keeps everything.
        assert_eq!(scoped_sources(&cfg(), &EffectiveScope::unrestricted()), cfg());
    }

    #[test]
    fn the_launch_of_a_scoped_config_names_only_the_scopes_sources() {
        use crate::sources::launch::build_sources_launch;
        let dir = std::env::temp_dir().join(format!("nexq-ws-launch-{}", uuid::Uuid::new_v4()));
        let (a, b) = (dir.join("CANARY_FOLDER_A"), dir.join("CANARY_FOLDER_B"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let cfg = PersonalSourcesConfig {
            notes_folders: vec![
                NotesFolder { id: "fa".into(), label: "A vault".into(), path: a.to_string_lossy().into(), enabled: true },
                NotesFolder { id: "fb".into(), label: "B vault".into(), path: b.to_string_lossy().into(), enabled: true },
            ],
            ..Default::default()
        };
        let scope = EffectiveScope { folder_ids: vec!["fa".into()], ..Default::default() };
        let launch = build_sources_launch(&scoped_sources(&cfg, &scope), &|_| None).unwrap().unwrap();
        let text = format!("{:?} {}", launch.add_dirs, launch.system_prompt_addition);
        assert!(text.contains("CANARY_FOLDER_A") && !text.contains("CANARY_FOLDER_B"), "{text}");
        let none = build_sources_launch(&scoped_sources(&cfg, &EffectiveScope::default()), &|_| None).unwrap();
        assert!(none.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unrestricted_only_when_the_workspace_tables_are_confirmed_absent() {
        for tables in [TablesState::Absent, TablesState::Present, TablesState::Unknown] {
            assert_eq!(policy(true, tables), Policy::Normal);
        }
        assert_eq!(policy(false, TablesState::Absent), Policy::Unrestricted, "v9 never ran: as before workspaces");
        assert_eq!(policy(false, TablesState::Present), Policy::FailClosed, "tables exist but unusable: nothing, never everything");
        assert_eq!(policy(false, TablesState::Unknown), Policy::FailClosed, "a failed or missing look is not an absence");
    }

    #[test]
    fn a_state_with_no_database_resolves_to_no_material() {
        // The app still starts without a database; it just has no workspace material.
        let state = AppState::new();
        let ctx = for_meeting(&state, "m");
        assert!(!ctx.scope.unrestricted && ctx.scope.document_ids.is_empty() && ctx.points.is_empty());
    }

    #[test]
    fn a_request_that_cannot_resolve_gets_no_material_and_is_told_once_per_meeting() {
        // An app state whose database is gone behind a poisoned lock is not easy to build;
        // the single decision point is `fail_closed`, which never returns material.
        let state = AppState::new();
        let first = fail_closed(&state, Some("m1"), "test");
        assert!(!first.scope.unrestricted && first.scope.document_ids.is_empty() && first.points.is_empty());
        assert!(state.material_warned.lock().unwrap().contains("m1"));
        fail_closed(&state, Some("m1"), "again");
        fail_closed(&state, None, "default");
        assert_eq!(state.material_warned.lock().unwrap().len(), 2, "one entry per meeting, not per request");
    }

    #[test]
    fn the_launch_fingerprint_changes_with_the_scope() {
        let a = EffectiveScope { home: "a".into(), folder_ids: vec!["fa".into()], ..Default::default() };
        let b = EffectiveScope { home: "b".into(), folder_ids: vec!["fb".into()], ..Default::default() };
        assert_ne!(launch_fingerprint(&cfg(), &a), launch_fingerprint(&cfg(), &b));
        assert_eq!(launch_fingerprint(&cfg(), &a), launch_fingerprint(&cfg(), &a));
    }

    #[test]
    fn workspace_instructions_follow_the_custom_ones() {
        let scope = EffectiveScope { instructions: "CANARY_WS".into(), ..Default::default() };
        assert_eq!(instructions_with_workspace("CUSTOM", &scope), "CUSTOM\n\nWorkspace instructions: CANARY_WS");
        assert_eq!(instructions_with_workspace("", &scope), "Workspace instructions: CANARY_WS");
        assert_eq!(instructions_with_workspace("CUSTOM", &EffectiveScope::default()), "CUSTOM");
    }
}
