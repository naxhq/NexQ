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
}

impl SwapLlm {
    pub fn new(factory: Arc<dyn LlmFactory>, purpose: AiPurpose, meeting_id: &str, selection: Selection) -> Result<Arc<SwapLlm>, String> {
        let slot = factory.make(purpose, meeting_id, &selection)?;
        Ok(Arc::new(SwapLlm { slot: Mutex::new(slot), factory, purpose, meeting_id: meeting_id.to_string(), selection: Mutex::new(selection) }))
    }

    /// Cancels what is running and makes a fresh slot for the next call.
    pub fn cancel_and_renew(&self) {
        let mut g = self.slot.lock().unwrap();
        g.cancel.cancel();
        let sel = self.selection.lock().unwrap().clone();
        if let Ok(s) = self.factory.make(self.purpose, &self.meeting_id, &sel) {
            *g = s;
        }
    }

    /// A new model for the next call. A call in flight finishes on the old one.
    pub fn reselect(&self, selection: Selection) -> Result<(), String> {
        let slot = self.factory.make(self.purpose, &self.meeting_id, &selection)?;
        *self.selection.lock().unwrap() = selection;
        *self.slot.lock().unwrap() = slot;
        Ok(())
    }

    pub fn selection(&self) -> Selection {
        self.selection.lock().unwrap().clone()
    }

    pub fn label(&self) -> Option<ModelLabel> {
        self.factory.label(&self.selection())
    }

    pub fn cancel(&self) {
        self.slot.lock().unwrap().cancel.cancel();
    }

    /// The generation read before building the next request (None: read it at call time).
    pub fn set_expected(&self, generation: Option<u64>) {
        self.slot.lock().unwrap().expected.store(generation.unwrap_or(NO_GENERATION), Ordering::SeqCst);
    }
}

#[async_trait]
impl LlmCall for SwapLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        let (llm, cancel) = {
            let g = self.slot.lock().unwrap();
            (g.llm.clone(), g.cancel.clone())
        };
        if cancel.is_cancelled() {
            return Err(LlmError::cancelled());
        }
        llm.call(req).await
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
