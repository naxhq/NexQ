//! Wiring to the running app: builds the engine's dependencies from
//! `AppState`, starts the indexer after startup settles, and the small hooks
//! other commands call when something that should be indexed changes.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::engine::ChatDeps;
use super::hub::{ChatHub, Wake};
use super::provider::WorkspaceIndexProvider;
use crate::ai_runs::{AiRuns, ModelSelection};
use crate::state::AppState;

/// How long after launch the indexer starts (a meeting may start first).
pub const START_DELAY: Duration = Duration::from_secs(20);
/// Chats created and never used are removed after this long.
pub const EMPTY_CHAT_TTL_MS: i64 = 24 * 3600 * 1000;

fn db_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    let db = state.database.as_ref().ok_or_else(|| "Database not initialized".to_string())?;
    let guard = db.lock().map_err(|e| format!("Failed to lock database: {e}"))?;
    Ok(guard.path().to_path_buf())
}

/// The chat engine's dependencies from the running app. Chats need the
/// workspace tables; without them this says so.
pub fn build_deps(app: &AppHandle, state: &AppState) -> Result<Arc<ChatDeps>, String> {
    if !crate::workspace::available() {
        return Err(match crate::workspace::last_error() {
            Some(e) => format!("Workspaces are unavailable. {e}"),
            None => "Workspaces are unavailable in this run".to_string(),
        });
    }
    let hub = state.workspace_chat.clone();
    // the app's one AiRuns (state.ai_runs); only a run without it makes its own
    let ai = match hub.ai_runs() {
        Some(ai) => ai,
        None => {
            let ai = state
                .ai_runs
                .clone()
                .unwrap_or_else(|| Arc::new(AiRuns::new(app.clone(), state.agent_sessions.clone(), state.credentials.clone())));
            hub.set_ai_runs(ai.clone());
            hub.ai_runs().unwrap_or(ai)
        }
    };
    let tools = {
        let (cli, sources) = (state.agent_sessions.clone(), state.personal_sources.clone());
        hub.tools_or(move || {
            Arc::new(super::approval::ApprovalToolPolicy::new(
                cli,
                crate::llm::cli_agent::approval::WorkspaceApprovals::global(),
                sources,
                Arc::new(crate::llm::cli_agent::approval::approval_support),
            ))
        })
    };
    let flag = state.meeting_active.clone();
    let llm = state.llm.clone();
    let (llm2, cli_settings) = (state.llm.clone(), state.cli_settings.clone());
    let app2 = app.clone();
    let recap_runs = Some(ai.clone());
    let recap_openrouter = state.openrouter_cache.clone();
    Ok(Arc::new(ChatDeps {
        db_path: db_path(state)?,
        ai,
        hub,
        sources: state.personal_sources.clone(),
        secret: Arc::new(crate::commands::sources_commands::saved_secret),
        meeting_active: Arc::new(move || flag.load(Ordering::SeqCst)),
        emit: Arc::new(move |event, payload| {
            let _ = app2.emit(event, payload);
        }),
        transcripts: crate::llm::cli_agent::transcripts::global(),
        tools,
        recap_selection: Arc::new(move || {
            // the same rule as notes, the brief and memory: the cheapest good-enough model
            use crate::live_runtime::cheapest::{cheapest, CheapestInput};
            let (provider, model) = {
                let router = llm2.as_ref()?.lock().ok()?;
                (router.active_provider_type()?.as_str().to_string(), router.active_model().to_string())
            };
            let kind = crate::llm::ProviderType::from_str(&provider).ok().and_then(|p| p.cli_agent_kind());
            let fast = kind.map(|k| cli_settings.config(k));
            // the provider's own model list when known (a fetch, when due, runs in the background)
            let available = recap_runs.as_ref().and_then(|r| r.known_models(&provider)).unwrap_or_default();
            if let Some(r) = recap_runs.as_ref().filter(|r| r.models_due(&provider)) {
                let (r, p) = (r.clone(), provider.clone());
                tauri::async_runtime::spawn(async move {
                    r.refresh_models(&p).await;
                });
            }
            let priced = if provider == "openrouter" {
                recap_openrouter
                    .lock()
                    .ok()
                    .and_then(|c| c.as_ref().map(|c| crate::live_runtime::cheapest::priced_from_openrouter(&c.models)))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let c = cheapest(&CheapestInput {
                provider: &provider,
                active_model: &model,
                available: &available,
                cli_fast: fast.as_ref().map(|c| (c.fast_model.as_str(), c.fast_effort.as_str())),
                priced: &priced,
            });
            Some(ModelSelection::new(&c.provider, &c.model, c.effort.as_deref()))
        }),
        default_selection: Arc::new(move || {
            let router = llm.as_ref()?.lock().ok()?;
            let provider = router.active_provider_type()?;
            Some(ModelSelection::new(provider.as_str(), router.active_model(), None))
        }),
    }))
}

/// Starts the indexer (once) and tidies old empty chats.
pub fn ensure_indexer(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !crate::workspace::available() {
        return Ok(());
    }
    let hub = state.workspace_chat.clone();
    let path = db_path(state)?;
    if let Ok(conn) = crate::db::open_writer(&path) {
        let _ = super::store::prune_empty_chats(&conn, EMPTY_CHAT_TTL_MS);
    }
    let provider = Arc::new(WorkspaceIndexProvider { db_path: path.clone(), sources: state.personal_sources.clone() });
    let flag = state.meeting_active.clone();
    let app2 = app.clone();
    let hub2 = hub.clone();
    hub.start_indexer(
        path,
        provider,
        Arc::new(move || flag.load(Ordering::SeqCst)),
        Arc::new(move |p, ws| {
            let workspace_id = ws.or_else(|| hub2.open_workspace()).unwrap_or_else(|| crate::workspace::GENERAL_ID.to_string());
            let _ = app2.emit(
                "workspace_index_progress",
                super::types::IndexProgressEvent {
                    workspace_id,
                    done: p.done,
                    total: p.total,
                    current: if p.current.is_empty() { None } else { Some(p.current.clone()) },
                    skipped: p.skipped,
                },
            );
        }),
        true,
    )
}

/// One line in app setup: the indexer starts once startup has settled.
pub fn attach(app: &AppHandle) {
    let app = app.clone();
    // a change that arrives before the start delay starts the indexer at once
    {
        let state = tauri::Manager::state::<AppState>(&app);
        let app2 = app.clone();
        state.workspace_chat.set_starter(Arc::new(move || {
            let state = tauri::Manager::state::<AppState>(&app2);
            if let Err(e) = ensure_indexer(&app2, &state) {
                log::warn!("Couldn't start the search indexer: {e}");
            }
        }));
    }
    // chats run on the app's one AiRuns
    {
        let state = tauri::Manager::state::<AppState>(&app);
        if let Some(ai) = state.ai_runs.clone() {
            state.workspace_chat.set_ai_runs(ai);
        }
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        let state = tauri::Manager::state::<AppState>(&app);
        if let Err(e) = ensure_indexer(&app, &state) {
            log::warn!("Couldn't start the search indexer: {e}");
        }
    });
}

// ── hooks ────────────────────────────────────────────────────────────────────

/// A meeting ended (its transcript is saved): index it.
pub fn meeting_ended(hub: &ChatHub, meeting_id: &str) {
    hub.wake(Wake::Meeting(meeting_id.to_string()));
}

/// Recaps (when the workspace turned "Prepare recaps with AI" on): runs once the
/// index holds the workspace's meetings, never during a meeting, at most
/// `ops::MAX_RECAPS` per call, on the cheapest model, through the AI gate.
/// A newer call replaces one still waiting or running.
fn spawn_recaps(app: &AppHandle, state: &AppState, workspace_id: String, settle: Duration, only: Option<String>) {
    let hub = state.workspace_chat.clone();
    let Ok(deps) = build_deps(app, state) else { return };
    let token = Arc::new(crate::llm::provider::CancelToken::new());
    hub.set_recap_cancel(Some(token.clone()));
    tauri::async_runtime::spawn(async move {
        // the meeting that just ended is still being saved and indexed
        tokio::time::sleep(settle).await;
        let made = super::ops::recaps_when_ready_for(&deps, &workspace_id, token, only.as_deref()).await;
        if made > 0 {
            (deps.emit)("workspaces_changed", serde_json::json!({ "workspace_id": workspace_id }));
        }
    });
}

/// A meeting ended: its workspace gets its missing recaps (the new meeting first).
pub fn recaps_after_meeting(app: &AppHandle, state: &AppState, meeting_id: &str) {
    let ws = state.database.as_ref().and_then(|db| {
        let db = db.lock().ok()?;
        db.connection().query_row("SELECT workspace_id FROM meetings WHERE id = ?1", [meeting_id], |r| r.get::<_, Option<String>>(0)).ok().flatten()
    });
    if let Some(ws) = ws {
        spawn_recaps(app, state, ws, Duration::from_secs(5), Some(meeting_id.to_string()));
    }
}

/// "Try again": forget the failed recaps of any workspace and run them the way opening does.
pub fn retry_recaps(app: &AppHandle, state: &AppState, workspace_id: &str) {
    if let Ok(conn) = db_path(state).and_then(|p| crate::db::open_writer(&p).map_err(|e| e.to_string())) {
        crate::workspace_search::cards::clear_recap_failures_of(&conn, workspace_id);
    }
    if !state.meeting_active.load(Ordering::SeqCst) {
        spawn_recaps(app, state, workspace_id.to_string(), Duration::ZERO, None);
    }
}

/// A workspace was opened (library or chat): up to `MAX_RECAPS` missing recaps, once per opening.
pub fn workspace_opened(app: &AppHandle, state: &AppState, workspace_id: &str) {
    let hub = &state.workspace_chat;
    let changed = hub.open_workspace().as_deref() != Some(workspace_id);
    hub.set_open_workspace(Some(workspace_id.to_string()));
    if changed && !state.meeting_active.load(Ordering::SeqCst) {
        spawn_recaps(app, state, workspace_id.to_string(), Duration::ZERO, None);
    }
}

/// A meeting was deleted: drop it from the index (the delete itself already
/// removed its rows; this stops a pass in flight from keeping them).
pub fn meeting_deleted(hub: &ChatHub, meeting_id: &str) {
    hub.wake(Wake::RemoveMeeting(meeting_id.to_string()));
}

/// A document, talking point, folder or opt-in changed: scan again soon.
pub fn material_changed(hub: &ChatHub) {
    hub.wake(Wake::Rescan);
}

/// A document was added, changed or removed: only documents are looked at.
pub fn documents_changed(hub: &ChatHub) {
    hub.wake(Wake::Documents);
}

/// A talking point was saved or deleted: only talking points are looked at.
pub fn talking_points_changed(hub: &ChatHub) {
    hub.wake(Wake::Points);
}

/// A folder was opted in: it is indexed now.
pub fn folder_opted_in(hub: &ChatHub, folder_id: &str) {
    hub.wake(Wake::Folder(folder_id.to_string()));
}

/// A folder item changed or was removed: when no workspace opts it in any
/// more, its passages are deleted right now (not at the next pass).
pub fn folder_opt_out_check(state: &AppState, is_folder: bool, folder_id: &str) {
    if !is_folder || !crate::workspace::available() {
        return;
    }
    let Ok(path) = db_path(state) else { return };
    let Ok(conn) = crate::db::open_writer(&path) else { return };
    let still: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace_items WHERE kind = 'folder' AND ref_id = ?1 AND index_opt_in = 1", [folder_id], |r| r.get(0))
        .unwrap_or(1);
    if still == 0 {
        let _ = crate::workspace_search::indexer::remove_folder_index(&conn, folder_id);
        folder_unindexed(&state.workspace_chat, folder_id);
    } else {
        folder_opted_in(&state.workspace_chat, folder_id);
    }
}

/// A folder was opted out of or removed: its passages go at once.
pub fn folder_unindexed(hub: &ChatHub, folder_id: &str) {
    hub.wake(Wake::RemoveFolder(folder_id.to_string()));
}
