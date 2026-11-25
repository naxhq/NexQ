//! Settings of live notes and the brief. The webview sends patches; the
//! backend merges them atomically, validates, saves and returns the result.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const NOTETAKER_KEY: &str = "live_notetaker_settings";
pub const BRIEF_KEY: &str = "live_brief_settings";
pub const DEFAULT_CAP: u64 = 120_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotetakerSettings {
    pub enabled: bool,
    /// "meeting" (this meeting only) or "every".
    pub scope: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// "automatic" | "manual"
    pub update_mode: String,
    /// "brief" | "standard" | "detailed"
    pub detail: String,
    /// "meeting" follows the meeting language.
    pub language: String,
    pub cap: u64,
    pub colors: bool,
}

impl Default for NotetakerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            scope: "meeting".into(),
            provider: None,
            model: None,
            effort: None,
            update_mode: "automatic".into(),
            detail: "standard".into(),
            language: "meeting".into(),
            cap: DEFAULT_CAP,
            colors: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BriefSettings {
    pub enabled: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cap: u64,
}

impl Default for BriefSettings {
    fn default() -> Self {
        Self { enabled: false, provider: None, model: None, effort: None, cap: DEFAULT_CAP }
    }
}

pub trait Validate {
    fn validate(&mut self) -> Result<(), String>;
}

fn check_cap(cap: &mut u64) {
    *cap = (*cap).clamp(2_000, 5_000_000);
}

impl Validate for NotetakerSettings {
    fn validate(&mut self) -> Result<(), String> {
        check_cap(&mut self.cap);
        if !["meeting", "every"].contains(&self.scope.as_str()) {
            return Err(format!("Unknown scope: {}", self.scope));
        }
        if !["automatic", "manual"].contains(&self.update_mode.as_str()) {
            return Err(format!("Unknown update mode: {}", self.update_mode));
        }
        if !["brief", "standard", "detailed"].contains(&self.detail.as_str()) {
            return Err(format!("Unknown detail level: {}", self.detail));
        }
        if self.language.trim().is_empty() {
            self.language = "meeting".into();
        }
        self.language = self.language.chars().take(40).collect();
        Ok(())
    }
}

impl Validate for BriefSettings {
    fn validate(&mut self) -> Result<(), String> {
        check_cap(&mut self.cap);
        Ok(())
    }
}

/// `current` with the keys of `patch` replaced. Unknown keys are an error
/// (a typo must not silently do nothing); `null` clears an optional field.
pub fn merge<T>(current: &T, patch: &Value) -> Result<T, String>
where
    T: Serialize + for<'de> Deserialize<'de> + Validate,
{
    let mut base = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let (Some(b), Some(p)) = (base.as_object_mut(), patch.as_object()) else {
        return Err("Settings must be an object".into());
    };
    for (k, v) in p {
        if !b.contains_key(k) {
            return Err(format!("Unknown setting: {k}"));
        }
        b.insert(k.clone(), v.clone());
    }
    let mut merged: T = serde_json::from_value(base).map_err(|e| format!("Invalid setting: {e}"))?;
    merged.validate()?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patch_merges_and_validates() {
        let s = NotetakerSettings::default();
        let m = merge(&s, &json!({"enabled": true, "detail": "brief", "provider": "openai", "cap": 10})).unwrap();
        assert!(m.enabled && m.detail == "brief" && m.provider.as_deref() == Some("openai"));
        assert_eq!(m.cap, 2_000, "clamped");
        assert_eq!(m.update_mode, "automatic");
        assert!(merge(&s, &json!({"detail": "huge"})).is_err());
        assert!(merge(&s, &json!({"nope": 1})).is_err());
        let cleared = merge(&m, &json!({"provider": null})).unwrap();
        assert_eq!(cleared.provider, None);
        assert!(merge(&BriefSettings::default(), &json!({"enabled": true})).unwrap().enabled);
    }

    #[test]
    fn old_saved_settings_load_with_defaults() {
        let s: NotetakerSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!((s.cap, s.detail.as_str()), (DEFAULT_CAP, "standard"));
        let b: BriefSettings = serde_json::from_str("{}").unwrap();
        assert!(!b.enabled);
    }
}
