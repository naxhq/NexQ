//! AiRuns as the model call of the live engines: purpose, session scope,
//! recycling, cancel, usage and the plan-limit mapping.

use crate::ai_runs::{AiPurpose, AiRunError, AiRunRequest, AiRuns, ModelSelection};
use crate::live_common::{LlmCall, LlmError, LlmErrorKind, LlmReply, LlmRequest};
use crate::llm::cli_agent::manager::{SessionKey, SessionScope, Tier};
use crate::llm::provider::CancelToken;
use crate::live_runtime::cheapest::{explicit_label, CheapestChoice};
use crate::live_runtime::state::ModelLabel;
use async_trait::async_trait;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// `LlmSlot::expected` when no generation was read.
pub const NO_GENERATION: u64 = u64::MAX;

/// Which model a runtime asked for (None parts fall back to the app's active one).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Selection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone)]
pub struct LlmSlot {
    pub llm: Arc<dyn LlmCall>,
    pub cancel: Arc<CancelToken>,
    /// The scope generation read before the request was built (`NO_GENERATION`: none).
    pub expected: Arc<AtomicU64>,
}

/// Makes the model call of one runtime. A new slot (new cancel token) is made
/// after a cancel; the old one stays cancelled.
pub trait LlmFactory: Send + Sync {
    fn make(&self, purpose: AiPurpose, meeting_id: &str, selection: &Selection) -> Result<LlmSlot, String>;

    /// What "Automatic" means for this provider (None = the active one): the
    /// cheapest good-enough model, with the label shown before turning anything on.
    fn automatic(&self, _provider: Option<&str>) -> Option<CheapestChoice> {
        None
    }

    /// The model a selection really names, for the state shown to the user.
    fn label(&self, _selection: &Selection) -> Option<ModelLabel> {
        None
    }

    /// What the NEXT run would use, resolved now (the active provider and the model lists
    /// as they are at this moment), or why nothing can run. A run whose answer differs from
    /// the slot's gets a fresh slot first; a pinned model resolves to itself.
    fn resolved(&self, _selection: &Selection) -> Result<String, String> {
        Ok(String::new())
    }

    /// The provider a selection resolves to right now (None: unknown).
    fn provider_of(&self, _selection: &Selection) -> Option<String> {
        None
    }
}

/// Models that run on this computer: Automatic moving from one of these to anything else is shown to the person.
pub fn is_local_provider(provider: &str) -> bool {
    use crate::llm::ProviderType;
    // By the app's own ids, so a misspelt one can't silence the notice.
    matches!(ProviderType::from_str(provider), Ok(ProviderType::Ollama | ProviderType::LmStudio))
}

#[cfg(test)]
mod local_provider_tests {
    #[test]
    fn the_local_providers_are_the_apps_own_ids() {
        for (id, local) in [("ollama", true), ("lm_studio", true), ("lmstudio", false), ("openai", false), ("claude_cli", false), ("custom", false)] {
            assert_eq!(super::is_local_provider(id), local, "{id}");
        }
    }
}

pub fn map_error(e: AiRunError) -> LlmError {
    let code = e.kind();
    let message = e.to_string();
    let kind = match &e {
        AiRunError::RateLimited { plan_limit: Some(_), .. } => LlmErrorKind::PlanLimit,
        AiRunError::Cancelled | AiRunError::Preempted => LlmErrorKind::Cancelled,
        _ => LlmErrorKind::Failed,
    };
    LlmError { kind, message, code }
}

pub struct AiRunsLlm {
    runs: Arc<AiRuns>,
    purpose: AiPurpose,
    meeting_id: String,
    selection: ModelSelection,
    cancel: Arc<CancelToken>,
    expected: Arc<AtomicU64>,
    /// The scope's generation now (the AI run service's, for this meeting and purpose).
    generation: Arc<dyn Fn() -> u64 + Send + Sync>,
}

#[async_trait]
impl LlmCall for AiRunsLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        let scope = match self.purpose {
            AiPurpose::Notes => Some(SessionScope::Notes(self.meeting_id.clone())),
            AiPurpose::Brief => Some(SessionScope::Brief(self.meeting_id.clone())),
            _ => None,
        };
        let build = |expected: u64| {
            let mut run = AiRunRequest::new(self.purpose, self.selection.clone(), &req.system, &req.user);
            run.max_output = req.max_output_tokens as u64;
            run.cancel = self.cancel.clone();
            run.session_key = scope.clone().map(|s| SessionKey::plain(s, Tier::Fast));
            // A notes session starts over every 25 runs so its history stays small.
            run.recycle_after = if self.purpose == AiPurpose::Notes { Some(25) } else { None };
            run.expected_generation = Some(expected);
            run
        };
        let expected = match self.expected.load(Ordering::SeqCst) {
            NO_GENERATION => (self.generation)(),
            g => g,
        };
        let mut result = self.runs.run(build(expected), None).await;
        if let Err(AiRunError::Unavailable { message }) = &result {
            if message.contains("changed while this was starting") {
                if self.purpose == AiPurpose::Notes {
                    // notes carry no workspace material: the same request is still right
                    result = self.runs.run(build((self.generation)()), None).await;
                } else {
                    // a brief request was built from the old scope: never retried
                    return Err(LlmError { kind: LlmErrorKind::Cancelled, message: "The scope changed".into(), code: "scope_changed" });
                }
            }
        }
        let out = result.map_err(map_error)?;
        if let Some(limit) = out.plan_limit.as_ref() {
            if matches!(limit.level, crate::llm::cli_agent::protocol::PlanLimitLevel::Hit) && out.text.trim().is_empty() {
                return Err(LlmError { kind: LlmErrorKind::PlanLimit, message: "The plan's usage limit was reached".into(), code: "rate_limited" });
            }
        }
        Ok(LlmReply {
            text: out.text,
            input_tokens: Some(out.usage.prompt_tokens().min(u32::MAX as u64) as u32),
            cached_input_tokens: Some((out.usage.cache_read_tokens + out.usage.cache_write_tokens).min(u32::MAX as u64) as u32),
            output_tokens: Some(out.usage.output_tokens.min(u32::MAX as u64) as u32),
        })
    }
}

/// The app's factory: every call goes through `AiRuns`.
pub struct AiRunsFactory {
    pub runs: Arc<AiRuns>,
    /// "Automatic" for a provider (None = the app's active one); see `cheapest`.
    pub resolver: Arc<dyn Fn(Option<&str>) -> Option<CheapestChoice> + Send + Sync>,
}

impl AiRunsFactory {
    fn selection_of(&self, sel: &Selection) -> Result<ModelSelection, String> {
        let provider = sel.provider.as_deref().filter(|p| !p.is_empty());
        let model = sel.model.as_deref().filter(|m| !m.is_empty());
        let effort = sel.effort.as_deref().filter(|e| !e.is_empty());
        match (provider, model) {
            (Some(p), Some(m)) => Ok(ModelSelection::new(p, m, effort)),
            _ => {
                let c = (self.resolver)(provider).ok_or_else(|| "No AI provider is set up".to_string())?;
                let model = model.map(str::to_string).unwrap_or(c.model);
                Ok(ModelSelection::new(&c.provider, &model, effort.or(c.effort.as_deref())))
            }
        }
    }
}

impl LlmFactory for AiRunsFactory {
    fn make(&self, purpose: AiPurpose, meeting_id: &str, sel: &Selection) -> Result<LlmSlot, String> {
        let selection = self.selection_of(sel)?;
        let cancel = Arc::new(CancelToken::new());
        let expected = Arc::new(AtomicU64::new(NO_GENERATION));
        let (runs, id) = (self.runs.clone(), meeting_id.to_string());
        let generation: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || {
            let scope = if purpose == AiPurpose::Brief { SessionScope::Brief(id.clone()) } else { SessionScope::Notes(id.clone()) };
            runs.generation(&SessionKey::plain(scope, Tier::Fast))
        });
        let llm = AiRunsLlm { runs: self.runs.clone(), purpose, meeting_id: meeting_id.to_string(), selection, cancel: cancel.clone(), expected: expected.clone(), generation };
        Ok(LlmSlot { llm: Arc::new(llm), cancel, expected })
    }

    fn automatic(&self, provider: Option<&str>) -> Option<CheapestChoice> {
        (self.resolver)(provider)
    }

    fn provider_of(&self, sel: &Selection) -> Option<String> {
        self.selection_of(sel).ok().map(|s| s.provider)
    }

    fn resolved(&self, sel: &Selection) -> Result<String, String> {
        let s = self.selection_of(sel)?;
        Ok(format!("{}|{}|{}", s.provider, s.model, s.effort.as_deref().unwrap_or("")))
    }

    fn label(&self, sel: &Selection) -> Option<ModelLabel> {
        let s = self.selection_of(sel).ok()?;
        let named = sel.model.as_deref().is_some_and(|m| !m.is_empty()) && sel.provider.as_deref().is_some_and(|p| !p.is_empty());
        let label = if named { explicit_label(&s.provider, &s.model) } else { (self.resolver)(sel.provider.as_deref().filter(|p| !p.is_empty()))?.label };
        Some(ModelLabel { provider: s.provider, model: s.model, label })
    }
}

/// The model call an engine holds: the current slot can be cancelled and
/// replaced (scope change, stop) without rebuilding the engine.
pub struct SwapLlm {
    slot: Mutex<LlmSlot>,
    factory: Arc<dyn LlmFactory>,
    purpose: AiPurpose,
    meeting_id: String,
    selection: Mutex<Selection>,
    /// What the slot was made for (`LlmFactory::resolved`): compared before every call.
    slot_key: Mutex<String>,
    /// Stops this engine for good (a memory run whose consent ended): fires whatever call is in flight.
    stop: Arc<CancelToken>,
    /// The provider Automatic resolved to when last looked at, and a move from local to online not yet dismissed.
    provider_seen: Mutex<Option<String>>,
    moved: Mutex<Option<(String, String)>>,
    /// The cancel tokens of the calls in flight: `cancel` fires them whatever slot has been swapped in since.
    in_flight: Mutex<Vec<Arc<CancelToken>>>,
    /// Bumped by every cancel; a call that is still not back `CANCEL_GRACE` later is dropped.
    abort_epoch: AtomicU64,
    abort_notify: tokio::sync::Notify,
}

/// How long a call may take to answer a cancel before it is dropped and counted as cancelled.
pub const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

impl SwapLlm {
    pub fn new(factory: Arc<dyn LlmFactory>, purpose: AiPurpose, meeting_id: &str, selection: Selection) -> Result<Arc<SwapLlm>, String> {
        let slot = factory.make(purpose, meeting_id, &selection)?;
        let key = factory.resolved(&selection).unwrap_or_default();
        let seen = factory.provider_of(&selection);
        Ok(Arc::new(SwapLlm { slot: Mutex::new(slot), factory, purpose, meeting_id: meeting_id.to_string(), selection: Mutex::new(selection), slot_key: Mutex::new(key), stop: Arc::new(CancelToken::new()), provider_seen: Mutex::new(seen), moved: Mutex::new(None), in_flight: Mutex::new(Vec::new()), abort_epoch: AtomicU64::new(0), abort_notify: tokio::sync::Notify::new() }))
    }

    /// Cancels what is running and makes a fresh slot for the next call.
    pub fn cancel_and_renew(&self) {
        self.fire_in_flight();
        let mut g = self.slot.lock().unwrap();
        g.cancel.cancel();
        let sel = self.selection.lock().unwrap().clone();
        if let Ok(s) = self.factory.make(self.purpose, &self.meeting_id, &sel) {
            *g = s;
            *self.slot_key.lock().unwrap() = self.factory.resolved(&sel).unwrap_or_default();
        }
    }

    /// A new model for the next call. A call in flight finishes on the old one.
    pub fn reselect(&self, selection: Selection) -> Result<(), String> {
        let slot = self.factory.make(self.purpose, &self.meeting_id, &selection)?;
        *self.slot_key.lock().unwrap() = self.factory.resolved(&selection).unwrap_or_default();
        *self.selection.lock().unwrap() = selection;
        *self.slot.lock().unwrap() = slot;
        Ok(())
    }

    /// Registered by runs that can be cancelled from outside; it outlives the slot swaps.
    pub fn stop_token(&self) -> Arc<CancelToken> {
        self.stop.clone()
    }

    /// Automatic (no provider named) that moved from a local model to an online provider since it was
    /// last dismissed. Looked at whenever the state is built, so it shows before the next run.
    pub fn moved_online(&self) -> Option<(String, String)> {
        let sel = self.selection.lock().unwrap().clone();
        if sel.provider.as_deref().is_some_and(|p| !p.is_empty()) {
            return None;
        }
        if let Some(now) = self.factory.provider_of(&sel) {
            let mut seen = self.provider_seen.lock().unwrap();
            match seen.as_ref() {
                Some(prev) if *prev != now => {
                    let mut moved = self.moved.lock().unwrap();
                    *moved = if is_local_provider(prev) && !is_local_provider(&now) { Some((prev.clone(), now.clone())) } else { None };
                    *seen = Some(now);
                }
                None => *seen = Some(now),
                _ => {}
            }
        }
        self.moved.lock().unwrap().clone()
    }

    /// The person saw it: the line goes away until the next move.
    pub fn dismiss_moved(&self) {
        *self.moved.lock().unwrap() = None;
    }

    pub fn selection(&self) -> Selection {
        self.selection.lock().unwrap().clone()
    }

    pub fn label(&self) -> Option<ModelLabel> {
        self.factory.label(&self.selection())
    }

    pub fn cancel(&self) {
        self.slot.lock().unwrap().cancel.cancel();
        self.fire_in_flight();
    }

    /// Cancels every call in flight through its own token (a swapped slot has a new one) and starts
    /// the grace period after which a call that ignores it is dropped.
    fn fire_in_flight(&self) {
        for t in self.in_flight.lock().unwrap().iter() {
            t.cancel();
        }
        self.abort_epoch.fetch_add(1, Ordering::SeqCst);
        self.abort_notify.notify_waiters();
    }

    /// The generation read before building the next request (None: read it at call time).
    pub fn set_expected(&self, generation: Option<u64>) {
        self.slot.lock().unwrap().expected.store(generation.unwrap_or(NO_GENERATION), Ordering::SeqCst);
    }
}

#[async_trait]
impl LlmCall for SwapLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        if self.stop.is_cancelled() || self.slot.lock().unwrap().cancel.is_cancelled() {
            return Err(LlmError::cancelled());
        }
        // The provider and model are resolved before EVERY run: a changed active provider or a
        // model list that landed since the last run applies now, also after errors. A pinned
        // model resolves to itself. Nothing usable means this run stops with the reason, never a fallback.
        let sel = self.selection.lock().unwrap().clone();
        let key = self.factory.resolved(&sel).map_err(|message| LlmError { kind: LlmErrorKind::Failed, message, code: "no_provider" })?;
        let (llm, cancel) = {
            let mut g = self.slot.lock().unwrap();
            let mut k = self.slot_key.lock().unwrap();
            if *k != key {
                let fresh = self
                    .factory
                    .make(self.purpose, &self.meeting_id, &sel)
                    .map_err(|message| LlmError { kind: LlmErrorKind::Failed, message, code: "no_provider" })?;
                fresh.expected.store(g.expected.load(Ordering::SeqCst), Ordering::SeqCst);
                *g = fresh;
                *k = key;
            }
            (g.llm.clone(), g.cancel.clone())
        };
        // The call is held by its own token and by a hard bound: after a cancel it has CANCEL_GRACE to
        // answer, then it is dropped and counted as cancelled (a provider that ignores cancel cannot hold the actor).
        let epoch0 = self.abort_epoch.load(Ordering::SeqCst);
        self.in_flight.lock().unwrap().push(cancel.clone());
        let result = tokio::select! {
            r = llm.call(req) => r,
            _ = self.stop.cancelled() => {
                cancel.cancel();
                Err(LlmError::cancelled())
            }
            _ = async {
                loop {
                    let notified = self.abort_notify.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if self.abort_epoch.load(Ordering::SeqCst) != epoch0 {
                        break;
                    }
                    notified.await;
                }
                tokio::time::sleep(CANCEL_GRACE).await;
            } => {
                cancel.cancel();
                Err(LlmError::cancelled())
            }
        };
        self.in_flight.lock().unwrap().retain(|t| !Arc::ptr_eq(t, &cancel));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::protocol::{PlanLimit, PlanLimitLevel};

    #[test]
    fn errors_map_to_the_engines_kinds() {
        let hit = PlanLimit { level: PlanLimitLevel::Hit, resets_at: None, window: None, used: None };
        let e = map_error(AiRunError::RateLimited { message: "limit".into(), plan_limit: Some(hit) });
        assert_eq!((e.kind, e.code), (LlmErrorKind::PlanLimit, "rate_limited"));
        let e = map_error(AiRunError::RateLimited { message: "429".into(), plan_limit: None });
        assert_eq!((e.kind, e.code), (LlmErrorKind::Failed, "rate_limited"));
        assert_eq!(map_error(AiRunError::Preempted).kind, LlmErrorKind::Cancelled);
        assert_eq!(map_error(AiRunError::Cancelled).kind, LlmErrorKind::Cancelled);
        let e = map_error(AiRunError::NoKey { provider: "x".into(), message: "no key".into() });
        assert_eq!((e.kind, e.code, e.message.as_str()), (LlmErrorKind::Failed, "no_key", "no key"));
        assert_eq!(map_error(AiRunError::TooLong { needed: 5, window: 3 }).code, "too_long");
    }
}
