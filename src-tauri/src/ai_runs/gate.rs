//! `LiveGate`: how a live answer keeps priority over every other AI run.
//!
//! Live code (`begin_generation`) calls [`LiveGate::enter`] and holds the
//! returned [`LiveBusy`] until the answer is done. That is one atomic add and a
//! `notify_waiters` (nobody is waiting in the common case): no lock, no await,
//! no allocation, so a live answer never waits for the gate.
//!
//! `ai_runs` reads it:
//! - a run on a LOCAL server (Ollama, LM Studio, a localhost custom endpoint)
//!   never starts while a live answer is on that server, and is cancelled when
//!   one starts (the server would otherwise queue the live answer behind it);
//! - a Notes or Brief run on an API or a CLI never starts while a live answer
//!   runs, but is not cut once it has started.
//!
//! Which server the live answers use is [`LiveTarget`], set when the provider
//! changes. Unknown (the default) counts as "every local server": the safe
//! side.

use crate::llm::provider::CancelToken;
use crate::llm::ProviderType;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// Which local server the live answers go to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LiveTarget {
    /// Not told yet: every local server is assumed shared with live.
    #[default]
    Unknown,
    /// Live answers do not use a local server (an API or a CLI agent).
    NoLocalServer,
    /// Live answers go to this local server (see [`local_server_id`]).
    Server(String),
}

impl LiveTarget {
    /// The target for live answers served by `provider` at `base_url`.
    pub fn for_provider(provider: &ProviderType, base_url: Option<&str>) -> LiveTarget {
        match local_server_id(provider, base_url) {
            Some(id) => LiveTarget::Server(id),
            None => LiveTarget::NoLocalServer,
        }
    }
}

/// `host:port` of a local server, lower-cased, or `None` for a provider that is
/// not one: Ollama and LM Studio always are, a custom endpoint only when it
/// points at this machine.
pub fn local_server_id(provider: &ProviderType, base_url: Option<&str>) -> Option<String> {
    let base = base_url
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| provider.default_base_url());
    let default_port = match provider {
        ProviderType::Ollama => 11434,
        ProviderType::LmStudio => 1234,
        ProviderType::Custom => 80,
        _ => return None,
    };
    let url = reqwest::Url::parse(base).ok()?;
    let host = url.host_str()?.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || host.ends_with(".localhost")
        || host.starts_with("127.");
    if matches!(provider, ProviderType::Custom) && !loopback {
        return None;
    }
    // A name for this machine is one server whichever way it is spelled.
    let host = if loopback { "localhost".to_string() } else { host };
    Some(format!("{host}:{}", url.port().unwrap_or(default_port)))
}

/// How a wait for the live answers to finish ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateWait {
    Idle,
    Cancelled,
    TimedOut,
}

#[derive(Default)]
pub struct LiveGate {
    busy: AtomicUsize,
    /// Woken when the busy count goes from 0 to 1.
    started: Notify,
    /// Woken when it returns to 0.
    idle: Notify,
    target: Mutex<LiveTarget>,
}

/// While alive, a live answer is running. Dropping it frees the gate.
#[must_use = "the live answer is only marked busy while this is held"]
pub struct LiveBusy(Arc<LiveGate>);

impl Drop for LiveBusy {
    fn drop(&mut self) {
        if self.0.busy.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl LiveGate {
    pub fn new() -> Arc<LiveGate> {
        Arc::new(LiveGate::default())
    }

    /// The app-wide gate (what live code and `AiRuns::new` share).
    pub fn global() -> Arc<LiveGate> {
        static GATE: OnceLock<Arc<LiveGate>> = OnceLock::new();
        GATE.get_or_init(LiveGate::new).clone()
    }

    /// A live answer starts. Cheap: an atomic add and a wake of whoever waits.
    pub fn enter(self: &Arc<Self>) -> LiveBusy {
        if self.busy.fetch_add(1, Ordering::SeqCst) == 0 {
            self.started.notify_waiters();
        }
        LiveBusy(self.clone())
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst) > 0
    }

    pub fn set_target(&self, target: LiveTarget) {
        *self.target.lock().unwrap() = target;
    }

    pub fn target(&self) -> LiveTarget {
        self.target.lock().unwrap().clone()
    }

    /// Does a live answer compete with a run on the local server `server`?
    pub fn shares_server(&self, server: &str) -> bool {
        match &*self.target.lock().unwrap() {
            LiveTarget::Unknown => true,
            LiveTarget::NoLocalServer => false,
            LiveTarget::Server(live) => live == server,
        }
    }

    /// Resolves once no live answer runs (at once when none does), the caller
    /// cancels, or `limit` passes.
    pub async fn wait_idle(&self, cancel: &CancelToken, limit: Duration) -> GateWait {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            // Register before looking, so a drop in between is not missed.
            let idle = self.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if !self.is_busy() {
                return GateWait::Idle;
            }
            tokio::select! {
                _ = idle => {}
                _ = cancel.cancelled() => return GateWait::Cancelled,
                _ = tokio::time::sleep_until(deadline) => return GateWait::TimedOut,
            }
        }
    }

    /// Resolves once a live answer runs (at once when one does).
    pub async fn live_started(&self) {
        loop {
            let started = self.started.notified();
            tokio::pin!(started);
            started.as_mut().enable();
            if self.is_busy() {
                return;
            }
            started.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_server_ids() {
        let id = |p: ProviderType, u: Option<&str>| local_server_id(&p, u);
        assert_eq!(id(ProviderType::Ollama, None).as_deref(), Some("localhost:11434"));
        assert_eq!(id(ProviderType::Ollama, Some("http://127.0.0.1:11434")).as_deref(), Some("localhost:11434"));
        assert_eq!(id(ProviderType::LmStudio, None).as_deref(), Some("localhost:1234"));
        assert_eq!(id(ProviderType::Ollama, Some("http://gpu-box:11434")).as_deref(), Some("gpu-box:11434"));
        assert_eq!(id(ProviderType::Custom, Some("http://localhost:8080/v1")).as_deref(), Some("localhost:8080"));
        assert_eq!(id(ProviderType::Custom, Some("https://api.example.com/v1")), None);
        assert_eq!(id(ProviderType::Custom, None), None);
        for p in [ProviderType::Openai, ProviderType::Anthropic, ProviderType::ClaudeCli, ProviderType::Gemini] {
            assert_eq!(id(p, None), None);
        }
    }

    #[tokio::test]
    async fn enter_marks_busy_and_drop_frees_it() {
        let gate = LiveGate::new();
        assert!(!gate.is_busy());
        let a = gate.enter();
        let b = gate.enter();
        assert!(gate.is_busy());
        drop(a);
        assert!(gate.is_busy(), "a second live answer still runs");
        drop(b);
        assert!(!gate.is_busy());
    }

    #[tokio::test]
    async fn wait_idle_returns_at_once_when_free_and_after_the_drop_when_busy() {
        let gate = LiveGate::new();
        let cancel = CancelToken::new();
        assert_eq!(gate.wait_idle(&cancel, Duration::from_secs(5)).await, GateWait::Idle);

        let busy = gate.enter();
        let waiter = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.wait_idle(&CancelToken::new(), Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiter.is_finished());
        drop(busy);
        assert_eq!(waiter.await.unwrap(), GateWait::Idle);
    }

    #[tokio::test]
    async fn wait_idle_stops_on_cancel_and_on_the_limit() {
        let gate = LiveGate::new();
        let _busy = gate.enter();
        assert_eq!(gate.wait_idle(&CancelToken::new(), Duration::from_millis(40)).await, GateWait::TimedOut);
        let cancel = CancelToken::new();
        cancel.cancel();
        assert_eq!(gate.wait_idle(&cancel, Duration::from_secs(5)).await, GateWait::Cancelled);
    }

    #[tokio::test]
    async fn live_started_wakes_a_watcher() {
        let gate = LiveGate::new();
        let watcher = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.live_started().await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!watcher.is_finished());
        let _busy = gate.enter();
        tokio::time::timeout(Duration::from_secs(2), watcher).await.unwrap().unwrap();
        // Already busy: returns at once.
        tokio::time::timeout(Duration::from_millis(200), gate.live_started()).await.unwrap();
    }

    #[test]
    fn the_target_decides_which_server_competes() {
        let gate = LiveGate::new();
        assert!(gate.shares_server("localhost:11434"), "unknown is the safe side");
        gate.set_target(LiveTarget::NoLocalServer);
        assert!(!gate.shares_server("localhost:11434"));
        gate.set_target(LiveTarget::for_provider(&ProviderType::Ollama, None));
        assert!(gate.shares_server("localhost:11434"));
        assert!(!gate.shares_server("localhost:1234"));
    }

    #[test]
    fn entering_takes_no_await_and_stays_cheap() {
        // `enter` is a plain function: callable from sync live code.
        let gate = LiveGate::new();
        let start = std::time::Instant::now();
        for _ in 0..10_000 {
            drop(gate.enter());
        }
        assert!(start.elapsed() < Duration::from_millis(200));
    }
}
