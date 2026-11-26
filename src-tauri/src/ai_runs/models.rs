//! What models a provider offers, kept so "Automatic" (notes, brief, memory,
//! recaps) can name the cheapest real one without a network call on the spot.
//!
//! * One list per provider, fetched through the provider's own `list_models`
//!   with a short timeout, at most once a day, again when the key or the
//!   address changes, and never while a live answer runs.
//! * Reading is instant (`known`): it never fetches. Until a list is known
//!   the caller says "uses the active model".
//! * A failed fetch is not retried for ten minutes, and keeps no list.
//! * Subscriptions, local servers and custom endpoints keep no list: they use
//!   their own tier or the active model.

use crate::llm::ProviderConfig;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A fetched list is trusted this long.
pub const LIST_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// After a failed fetch, wait this long.
pub const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
/// How long a fetch may take.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// The event that tells the UI a provider's list arrived (`{provider}`).
pub const UPDATED_EVENT: &str = "automatic_model_updated";

/// Providers whose list is kept: the ones "Automatic" picks a small model from.
pub fn keeps_list(provider: &str) -> bool {
    matches!(provider, "openai" | "anthropic" | "gemini" | "groq" | "openrouter")
}

/// What identifies the account and endpoint a list was fetched for.
pub fn fingerprint(config: &ProviderConfig) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&config.api_key, &config.base_url, &config.auth_value, &config.auth_header).hash(&mut h);
    h.finish()
}

struct Entry {
    fingerprint: u64,
    models: Option<Vec<String>>,
    at: Instant,
}

#[derive(Default)]
pub struct ModelLists {
    entries: Mutex<HashMap<String, Entry>>,
}

impl ModelLists {
    /// The list for `provider` as of `fingerprint`; `None` when unknown or
    /// fetched for another key or address.
    pub fn known(&self, provider: &str, fingerprint: u64) -> Option<Vec<String>> {
        let entries = self.entries.lock().unwrap();
        entries.get(provider).filter(|e| e.fingerprint == fingerprint).and_then(|e| e.models.clone())
    }

    /// Is a fetch due? True when nothing is known for this key and address, the
    /// list is older than `ttl`, or the last attempt failed `retry` ago.
    pub fn due(&self, provider: &str, fingerprint: u64, ttl: Duration, retry: Duration) -> bool {
        let entries = self.entries.lock().unwrap();
        match entries.get(provider) {
            Some(e) if e.fingerprint == fingerprint => {
                let limit = if e.models.is_some() { ttl } else { retry };
                e.at.elapsed() >= limit
            }
            _ => true,
        }
    }

    pub fn store(&self, provider: &str, fingerprint: u64, models: Option<Vec<String>>) {
        self.entries.lock().unwrap().insert(provider.to_string(), Entry { fingerprint, models, at: Instant::now() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(key: &str, base: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            provider_type: "openai".into(),
            api_key: Some(key.into()),
            base_url: base.map(String::from),
            auth_type: None,
            auth_value: None,
            auth_header: None,
            thinking: Default::default(),
            extra_request_json: None,
        }
    }

    #[test]
    fn a_list_belongs_to_one_key_and_address() {
        let lists = ModelLists::default();
        let (a, b, c) = (fingerprint(&cfg("k1", None)), fingerprint(&cfg("k2", None)), fingerprint(&cfg("k1", Some("http://proxy"))));
        assert!(a != b && a != c);
        assert_eq!(lists.known("openai", a), None);
        lists.store("openai", a, Some(vec!["gpt-5-nano".into()]));
        assert_eq!(lists.known("openai", a), Some(vec!["gpt-5-nano".to_string()]));
        assert_eq!(lists.known("openai", b), None, "another key: not this list");
        assert!(lists.due("openai", b, LIST_TTL, RETRY_AFTER));
        assert!(!lists.due("openai", a, LIST_TTL, RETRY_AFTER));
        assert!(lists.due("openai", a, Duration::ZERO, RETRY_AFTER), "older than the ttl");
    }

    #[test]
    fn a_failed_fetch_keeps_no_list_and_waits_before_trying_again() {
        let lists = ModelLists::default();
        let a = fingerprint(&cfg("k", None));
        lists.store("groq", a, None);
        assert_eq!(lists.known("groq", a), None);
        assert!(!lists.due("groq", a, LIST_TTL, RETRY_AFTER));
        assert!(lists.due("groq", a, LIST_TTL, Duration::ZERO));
    }

    #[test]
    fn only_the_providers_automatic_picks_from_keep_a_list() {
        for p in ["openai", "anthropic", "gemini", "groq", "openrouter"] {
            assert!(keeps_list(p), "{p}");
        }
        for p in ["ollama", "lm_studio", "custom", "claude_cli", "codex_cli", "antigravity_cli", "nope"] {
            assert!(!keeps_list(p), "{p}");
        }
    }
}
