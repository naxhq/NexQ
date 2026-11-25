//! The app's side of the runtimes: Tauri events, the AI run service, the
//! database behind `AppState`, the running meeting and the live-answer gate.

use crate::ai_runs::AiRuns;
use crate::live_common::SystemClock;
use crate::live_runtime::db::LiveDb;
use crate::live_runtime::cheapest::{cheapest, CheapestChoice, CheapestInput};
use crate::live_runtime::llm::AiRunsFactory;
use crate::live_runtime::{Deps, Emitter, LiveRuntimes};
use crate::llm::cli_agent::manager::{SessionKey, SessionScope, Tier};
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

/// The AI run service's scope generation (`AiRuns::generation`) of a meeting's
/// notes or brief session scope; it moves whenever the meeting's sessions restart.
pub fn generation_seam(runs: &Arc<AiRuns>) -> Arc<dyn Fn(&str, bool) -> u64 + Send + Sync> {
    let runs = runs.clone();
    Arc::new(move |meeting: &str, brief: bool| {
        let scope = if brief { SessionScope::Brief(meeting.to_string()) } else { SessionScope::Notes(meeting.to_string()) };
        runs.generation(&SessionKey::plain(scope, Tier::Fast))
    })
}

/// Builds the runtimes from the state before it is handed to Tauri.
pub fn build(app: &AppHandle, state: &AppState) -> Option<Arc<LiveRuntimes>> {
    let database = state.database.clone()?;
    let runs = state.ai_runs.clone()?;
    let live = state.live_meeting.clone();
    let llm = state.llm.clone();
    // "Automatic" is the cheapest good-enough model (see `cheapest`): the same
    // rule for notes, brief, memory and recaps.
    let cli_settings = state.cli_settings.clone();
    let openrouter = state.openrouter_cache.clone();
    let resolver: Arc<dyn Fn(Option<&str>) -> Option<CheapestChoice> + Send + Sync> = Arc::new(move |provider: Option<&str>| {
        let (active_provider, active_model) = {
            let router = llm.as_ref()?.lock().ok()?;
            (router.active_provider_type()?.as_str().to_string(), router.active_model().to_string())
        };
        let provider = provider.map(str::to_string).unwrap_or_else(|| active_provider.clone());
        let active_model = if provider == active_provider { active_model } else { String::new() };
        let available: Vec<String> = if provider == "openrouter" {
            openrouter.lock().ok().and_then(|c| c.as_ref().map(|c| c.models.iter().map(|m| m.id.clone()).collect())).unwrap_or_default()
        } else {
            Vec::new()
        };
        let kind = crate::llm::ProviderType::from_str(&provider).ok().and_then(|p| p.cli_agent_kind());
        let fast = kind.map(|k| cli_settings.config(k));
        Some(cheapest(&CheapestInput {
            provider: &provider,
            active_model: &active_model,
            available: &available,
            cli_fast: fast.as_ref().map(|c| (c.fast_model.as_str(), c.fast_effort.as_str())),
        }))
    });
    let factory = Arc::new(AiRunsFactory { runs: runs.clone(), resolver });
    let gate = runs.gate().clone();
    let close_runs = runs.clone();
    let live_id = live.clone();
    let deps = Deps {
        db: LiveDb::new(Arc::new(database) as Arc<dyn crate::live_runtime::db::ConnProvider>).with_reader(state.readers.clone()),
        emitter: Arc::new(TauriEmitter(app.clone())),
        factory,
        clock: Arc::new(SystemClock),
        busy: Arc::new(move || gate.is_busy()),
        live_meeting: Arc::new(move || live_id.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()))),
        generation: generation_seam(&runs),
        deleted: Arc::new(Mutex::new(std::collections::HashSet::new())),
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
