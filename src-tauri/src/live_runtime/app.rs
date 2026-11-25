//! The app's side of the runtimes: Tauri events, the AI run service, the
//! database behind `AppState`, the running meeting and the live-answer gate.

use crate::ai_runs::{AiRuns, ModelSelection};
use crate::live_common::SystemClock;
use crate::live_runtime::db::LiveDb;
use crate::live_runtime::llm::AiRunsFactory;
use crate::live_runtime::{Deps, Emitter, LiveRuntimes};
use crate::state::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter as _};

struct TauriEmitter(AppHandle);

impl Emitter for TauriEmitter {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// The seam to the AI run service's scope generation (`AiRuns::generation`).
/// Until that lands here it reports one constant generation; the brief then
/// relies on its own scope check, which is also what clears the sheet.
pub fn generation_seam(_runs: &Arc<AiRuns>) -> Arc<dyn Fn(&str) -> u64 + Send + Sync> {
    Arc::new(|_scope: &str| 0)
}

/// Builds the runtimes from the state before it is handed to Tauri.
pub fn build(app: &AppHandle, state: &AppState) -> Option<Arc<LiveRuntimes>> {
    let database = state.database.clone()?;
    let runs = state.ai_runs.clone()?;
    let live = state.live_meeting.clone();
    let llm = state.llm.clone();
    let default_selection: Arc<dyn Fn() -> Option<ModelSelection> + Send + Sync> = Arc::new(move || {
        let router = llm.as_ref()?.lock().ok()?;
        let provider = router.active_provider_type()?.as_str().to_string();
        Some(ModelSelection::new(&provider, router.active_model(), None))
    });
    let factory = Arc::new(AiRunsFactory { runs: runs.clone(), default_selection });
    let gate = runs.gate().clone();
    let close_runs = runs.clone();
    let live_id = live.clone();
    let deps = Deps {
        db: LiveDb::new(Arc::new(database) as Arc<dyn crate::live_runtime::db::ConnProvider>),
        emitter: Arc::new(TauriEmitter(app.clone())),
        factory,
        clock: Arc::new(SystemClock),
        busy: Arc::new(move || gate.is_busy()),
        live_meeting: Arc::new(move || live_id.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()))),
        generation: generation_seam(&runs),
        close_sessions: Arc::new(move |id: String| {
            let runs = close_runs.clone();
            tauri::async_runtime::spawn(async move { runs.close_meeting(&id).await });
        }),
        tick: Duration::from_secs(1),
        scope_check: Duration::from_secs(2),
        final_timeout: Duration::from_secs(20),
    };
    let _ = Mutex::new(());
    Some(LiveRuntimes::new(deps))
}
