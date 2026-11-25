//! The real context window of a provider's model, cached.
//!
//! - Providers that list it (Anthropic's `max_input_tokens`, OpenRouter, Gemini,
//!   ...): from the model listing, which is fetched once per provider and kept.
//! - Ollama: `POST /api/show`, whose `model_info` holds `<architecture>.context_length`.
//! - CLI agents: 200k, or 1M for a Claude model asked for with `[1m]`.
//! - Anything that does not say: `None` (callers then do not block on size).
//!
//! Misses are cached for a few minutes so a provider that does not answer is
//! not asked on every run.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// What a CLI agent session is assumed to hold.
pub const CLI_DEFAULT_WINDOW: u64 = 200_000;
/// Claude's long-context models (`opus[1m]`).
pub const CLI_LONG_WINDOW: u64 = 1_000_000;
/// A found window is kept this long.
const HIT_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// A miss is kept this long.
const MISS_TTL: Duration = Duration::from_secs(5 * 60);

/// The window of a CLI agent's `model`.
pub fn cli_window(model: &str) -> u64 {
    if model.to_lowercase().contains("[1m]") {
        CLI_LONG_WINDOW
    } else {
        CLI_DEFAULT_WINDOW
    }
}

/// `<arch>.context_length` from an Ollama `/api/show` body.
pub fn parse_ollama_show(body: &serde_json::Value) -> Option<u64> {
    body.get("model_info")?
        .as_object()?
        .iter()
        .filter(|(key, _)| key.ends_with(".context_length"))
        .filter_map(|(_, value)| value.as_u64())
        .max()
        .filter(|w| *w > 0)
}

/// Round a context request up to a power of two (at least 4096), never above
/// the model's `window`. A stable size keeps a local server from reloading
/// the model each time a prompt is a little longer than the last one.
pub fn bucket_context(needed: u64, window: Option<u64>) -> u64 {
    let bucket = needed.max(4096).next_power_of_two();
    match window {
        Some(w) => bucket.min(w).max(needed.min(w)),
        None => bucket,
    }
}

/// A rough token count: chars/4, or chars/1.5 for text that is mostly CJK
/// (which tokenizes far denser).
pub fn estimate_tokens(text: &str) -> u64 {
    let (mut chars, mut cjk) = (0u64, 0u64);
    for c in text.chars() {
        chars += 1;
        if is_cjk(c) {
            cjk += 1;
        }
    }
    if chars == 0 {
        0
    } else if cjk * 2 > chars {
        (chars as f64 / 1.5).ceil() as u64
    } else {
        chars.div_ceil(4)
    }
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // kana
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified
        | 0xAC00..=0xD7AF // hangul
        | 0xF900..=0xFAFF // compatibility ideographs
    )
}

type Key = (String, String);

#[derive(Default)]
pub struct ModelWindows {
    entries: Mutex<HashMap<Key, (Option<u64>, Instant)>>,
    /// Providers whose listing was fetched, and when.
    listed: Mutex<HashMap<String, Instant>>,
}

impl ModelWindows {
    pub fn new() -> Self {
        Self::default()
    }

    /// The cached answer for `(provider, model)`: `Some(Some(w))` found,
    /// `Some(None)` known to be unknown (recently), `None` not cached.
    pub fn cached(&self, provider: &str, model: &str) -> Option<Option<u64>> {
        let entries = self.entries.lock().unwrap();
        let (window, at) = entries.get(&(provider.to_string(), model.to_string()))?;
        let ttl = if window.is_some() { HIT_TTL } else { MISS_TTL };
        (at.elapsed() < ttl).then_some(*window)
    }

    pub fn store(&self, provider: &str, model: &str, window: Option<u64>) {
        self.entries
            .lock()
            .unwrap()
            .insert((provider.to_string(), model.to_string()), (window, Instant::now()));
    }

    /// Was `provider`'s listing fetched recently?
    pub fn listing_fresh(&self, provider: &str) -> bool {
        self.listed
            .lock()
            .unwrap()
            .get(provider)
            .is_some_and(|at| at.elapsed() < MISS_TTL.max(Duration::from_secs(30 * 60)))
    }

    pub fn mark_listed(&self, provider: &str) {
        self.listed.lock().unwrap().insert(provider.to_string(), Instant::now());
    }

    /// Forget everything (the user changed a key or an endpoint).
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
        self.listed.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ollama_show_gives_the_architectures_context_length() {
        let body = json!({"model_info": {"general.architecture": "llama", "llama.context_length": 131072, "llama.block_count": 32}});
        assert_eq!(parse_ollama_show(&body), Some(131072));
        let qwen = json!({"model_info": {"qwen3.context_length": 40960}});
        assert_eq!(parse_ollama_show(&qwen), Some(40960));
        assert_eq!(parse_ollama_show(&json!({"model_info": {}})), None);
        assert_eq!(parse_ollama_show(&json!({"error": "x"})), None);
    }

    #[test]
    fn cli_windows() {
        assert_eq!(cli_window("sonnet"), CLI_DEFAULT_WINDOW);
        assert_eq!(cli_window("opus[1m]"), CLI_LONG_WINDOW);
        assert_eq!(cli_window(""), CLI_DEFAULT_WINDOW);
    }

    #[test]
    fn buckets_are_stable_powers_of_two_capped_by_the_window() {
        assert_eq!(bucket_context(100, None), 4096);
        assert_eq!(bucket_context(4097, None), 8192);
        assert_eq!(bucket_context(9000, Some(131072)), 16384);
        assert_eq!(bucket_context(9000, Some(10000)), 10000, "never above the model's window");
        assert_eq!(bucket_context(3000, Some(2048)), 2048);
    }

    #[test]
    fn token_estimates_use_a_denser_ratio_for_cjk() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("abcde"), 2);
        let cjk = "会议记录".repeat(3); // 12 chars
        assert_eq!(estimate_tokens(&cjk), 8);
        let mixed = format!("{}{}", "会", "a".repeat(11));
        assert_eq!(estimate_tokens(&mixed), 3, "mostly latin stays at chars/4");
    }

    #[test]
    fn the_cache_remembers_hits_and_misses() {
        let w = ModelWindows::new();
        assert_eq!(w.cached("ollama", "m"), None);
        w.store("ollama", "m", Some(8192));
        w.store("ollama", "none", None);
        assert_eq!(w.cached("ollama", "m"), Some(Some(8192)));
        assert_eq!(w.cached("ollama", "none"), Some(None));
        assert_eq!(w.cached("openai", "m"), None);
        assert!(!w.listing_fresh("openai"));
        w.mark_listed("openai");
        assert!(w.listing_fresh("openai"));
        w.clear();
        assert_eq!(w.cached("ollama", "m"), None);
        assert!(!w.listing_fresh("openai"));
    }
}
