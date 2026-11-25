//! AiRuns as the model call of the live engines: purpose, session scope,
//! recycling, cancel, usage and the plan-limit mapping.

use crate::ai_runs::{AiPurpose, AiRunError, AiRunRequest, AiRuns, ModelSelection};
use crate::live_common::{LlmCall, LlmError, LlmErrorKind, LlmReply, LlmRequest};
use crate::llm::cli_agent::manager::{SessionKey, SessionScope, Tier};
use crate::llm::provider::CancelToken;
use async_trait::async_trait;
use std::sync::{Arc, Mutex};

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
}

/// Makes the model call of one runtime. A new slot (new cancel token) is made
/// after a cancel; the old one stays cancelled.
pub trait LlmFactory: Send + Sync {
    fn make(&self, purpose: AiPurpose, meeting_id: &str, selection: &Selection) -> Result<LlmSlot, String>;
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
}

#[async_trait]
impl LlmCall for AiRunsLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        let mut run = AiRunRequest::new(self.purpose, self.selection.clone(), &req.system, &req.user);
        run.max_output = req.max_output_tokens as u64;
        run.cancel = self.cancel.clone();
        let scope = match self.purpose {
            AiPurpose::Notes => Some(SessionScope::Notes(self.meeting_id.clone())),
            AiPurpose::Brief => Some(SessionScope::Brief(self.meeting_id.clone())),
            _ => None,
        };
        run.session_key = scope.map(|s| SessionKey::plain(s, Tier::Fast));
        // A notes session starts over every 25 runs so its history stays small.
        run.recycle_after = if self.purpose == AiPurpose::Notes { Some(25) } else { None };
        let out = self.runs.run(run, None).await.map_err(map_error)?;
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
    /// What to use when the settings name no provider (the app's active one).
    pub default_selection: Arc<dyn Fn() -> Option<ModelSelection> + Send + Sync>,
}

impl LlmFactory for AiRunsFactory {
    fn make(&self, purpose: AiPurpose, meeting_id: &str, sel: &Selection) -> Result<LlmSlot, String> {
        let selection = match sel.provider.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => ModelSelection::new(p, sel.model.as_deref().unwrap_or(""), sel.effort.as_deref()),
            None => {
                let mut d = (self.default_selection)().ok_or_else(|| "No AI provider is set up".to_string())?;
                if let Some(m) = sel.model.as_deref().filter(|m| !m.is_empty()) {
                    d.model = m.to_string();
                }
                if sel.effort.is_some() {
                    d.effort = sel.effort.clone();
                }
                d
            }
        };
        let cancel = Arc::new(CancelToken::new());
        let llm = AiRunsLlm { runs: self.runs.clone(), purpose, meeting_id: meeting_id.to_string(), selection, cancel: cancel.clone() };
        Ok(LlmSlot { llm: Arc::new(llm), cancel })
    }
}

/// The model call an engine holds: the current slot can be cancelled and
/// replaced (scope change, stop) without rebuilding the engine.
pub struct SwapLlm {
    slot: Mutex<LlmSlot>,
    factory: Arc<dyn LlmFactory>,
    purpose: AiPurpose,
    meeting_id: String,
    selection: Selection,
}

impl SwapLlm {
    pub fn new(factory: Arc<dyn LlmFactory>, purpose: AiPurpose, meeting_id: &str, selection: Selection) -> Result<Arc<SwapLlm>, String> {
        let slot = factory.make(purpose, meeting_id, &selection)?;
        Ok(Arc::new(SwapLlm { slot: Mutex::new(slot), factory, purpose, meeting_id: meeting_id.to_string(), selection }))
    }

    /// Cancels what is running and makes a fresh slot for the next call.
    pub fn cancel_and_renew(&self) {
        let mut g = self.slot.lock().unwrap();
        g.cancel.cancel();
        if let Ok(s) = self.factory.make(self.purpose, &self.meeting_id, &self.selection) {
            *g = s;
        }
    }

    pub fn cancel(&self) {
        self.slot.lock().unwrap().cancel.cancel();
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
