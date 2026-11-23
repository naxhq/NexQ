//! The per-CLI settings the session manager and the commands share: one
//! model configuration and one model catalog per [`CliAgentKind`], and which
//! kind is active (the provider the user picked) right now.
//!
//! Defaults per kind:
//!
//! - Claude: Haiku (low) for Fast, Sonnet (medium) for Deep, as before.
//! - Antigravity: `gemini-3.8-flash-low` for Fast, `gemini-4-neon-medium` for
//!   Deep (effort lives in the model id, so the effort fields are unused).
//! - Codex: the first model Codex lists, with effort `low` for Fast and
//!   `medium` for Deep. The model names are empty ("first listed"), resolved
//!   when a session starts.
//!
//! A saved model that is no longer in the CLI's catalog (renamed, retired, or
//! never offered to this account) falls back to the first listed model when
//! the session starts, for Antigravity and Codex; Claude passes its aliases
//! through untouched.

use super::manager::ClaudeCliConfig;
use super::models::{effective_effort, effective_effort_in, ModelCatalog, CODEX_EFFORTS};
use super::CliAgentKind;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// What one session of a kind is launched with after the saved configuration
/// met the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    /// The model id to launch with. Empty: the CLI's own default.
    pub model: String,
    /// `None` when the model (or the CLI) takes no effort.
    pub effort: Option<String>,
}

pub struct CliSettings {
    configs: RwLock<HashMap<CliAgentKind, ClaudeCliConfig>>,
    catalogs: HashMap<CliAgentKind, Arc<ModelCatalog>>,
    active: RwLock<CliAgentKind>,
}

impl CliSettings {
    /// Settings over the process-wide catalogs (what the app uses).
    pub fn new() -> Self {
        Self::with_catalogs(ModelCatalog::global_for)
    }

    /// Settings with fresh, private catalogs (tests).
    pub fn isolated() -> Self {
        Self::with_catalogs(|_| Arc::new(ModelCatalog::default()))
    }

    /// Isolated settings whose Claude configuration is `cfg` (tests).
    pub fn isolated_with(cfg: ClaudeCliConfig) -> Arc<Self> {
        let settings = Self::isolated();
        settings.set_config(CliAgentKind::Claude, cfg);
        Arc::new(settings)
    }

    fn with_catalogs(catalog: impl Fn(CliAgentKind) -> Arc<ModelCatalog>) -> Self {
        Self {
            configs: RwLock::new(CliAgentKind::ALL.into_iter().map(|k| (k, ClaudeCliConfig::default_for(k))).collect()),
            catalogs: CliAgentKind::ALL.into_iter().map(|k| (k, catalog(k))).collect(),
            active: RwLock::new(CliAgentKind::Claude),
        }
    }

    pub fn config(&self, kind: CliAgentKind) -> ClaudeCliConfig {
        self.configs.read().map(|c| c.get(&kind).cloned().unwrap_or_default()).unwrap_or_default()
    }

    pub fn set_config(&self, kind: CliAgentKind, config: ClaudeCliConfig) {
        if let Ok(mut configs) = self.configs.write() {
            configs.insert(kind, config);
        }
    }

    pub fn catalog(&self, kind: CliAgentKind) -> Arc<ModelCatalog> {
        self.catalogs.get(&kind).cloned().unwrap_or_else(|| Arc::new(ModelCatalog::default()))
    }

    /// The kind new sessions are started for.
    pub fn active(&self) -> CliAgentKind {
        self.active.read().map(|k| *k).unwrap_or(CliAgentKind::Claude)
    }

    /// Make `kind` the one new sessions start for. True when it changed.
    pub fn set_active(&self, kind: CliAgentKind) -> bool {
        match self.active.write() {
            Ok(mut active) if *active != kind => {
                *active = kind;
                true
            }
            _ => false,
        }
    }

    /// The configuration of the active kind.
    pub fn active_config(&self) -> ClaudeCliConfig {
        self.config(self.active())
    }

    /// The model and effort one session of `kind` launches with for a saved
    /// `(model, effort)`; see the module docs.
    pub fn resolve(&self, kind: CliAgentKind, saved_model: &str, saved_effort: &str) -> ResolvedModel {
        resolve_model(kind, saved_model, saved_effort, &self.catalog(kind))
    }
}

impl Default for CliSettings {
    fn default() -> Self {
        Self::new()
    }
}

/// See [`CliSettings::resolve`]. Pure, over `catalog`.
pub fn resolve_model(kind: CliAgentKind, saved_model: &str, saved_effort: &str, catalog: &ModelCatalog) -> ResolvedModel {
    match kind {
        CliAgentKind::Claude => ResolvedModel {
            model: saved_model.to_string(),
            effort: effective_effort(catalog.find(saved_model).as_ref(), saved_effort),
        },
        // The effort is part of the model id: there is nothing to pass.
        CliAgentKind::Antigravity => ResolvedModel { model: usable_model(saved_model, catalog), effort: None },
        CliAgentKind::Codex => {
            let model = usable_model(saved_model, catalog);
            let effort = effective_effort_in(catalog.find(&model).as_ref(), saved_effort, &CODEX_EFFORTS);
            ResolvedModel { model, effort }
        }
    }
}

/// `saved` when the catalog lists it, else the first listed model; with no
/// catalog yet, `saved` as it is (empty stays empty: the CLI's own default).
fn usable_model(saved: &str, catalog: &ModelCatalog) -> String {
    match catalog.get().filter(|models| !models.is_empty()) {
        None => saved.to_string(),
        Some(models) => {
            if !saved.is_empty() && catalog.find(saved).is_some() {
                saved.to_string()
            } else {
                models[0].value.clone()
            }
        }
    }
}

impl ClaudeCliConfig {
    /// The default configuration of one CLI agent (see the module docs).
    pub fn default_for(kind: CliAgentKind) -> Self {
        match kind {
            CliAgentKind::Claude => Self::default(),
            CliAgentKind::Antigravity => Self {
                fast_model: "gemini-3.8-flash-low".into(),
                fast_effort: "low".into(),
                deep_model: "gemini-4-neon-medium".into(),
                deep_effort: "medium".into(),
                fast_thinking: false,
                deep_thinking: false,
                ..Self::default()
            },
            CliAgentKind::Codex => Self {
                fast_model: String::new(),
                fast_effort: "low".into(),
                deep_model: String::new(),
                deep_effort: "medium".into(),
                fast_thinking: false,
                deep_thinking: false,
                ..Self::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::models::ClaudeModelInfo;

    fn info(value: &str, levels: &[&str]) -> ClaudeModelInfo {
        ClaudeModelInfo {
            value: value.into(),
            resolved_model: value.into(),
            display_name: value.into(),
            description: String::new(),
            supports_effort: !levels.is_empty(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            default_effort: None,
        }
    }

    #[test]
    fn defaults_per_kind() {
        let claude = ClaudeCliConfig::default_for(CliAgentKind::Claude);
        assert_eq!((claude.fast_model.as_str(), claude.deep_model.as_str()), ("haiku", "sonnet"));
        assert_eq!(claude, ClaudeCliConfig::default());
        let agy = ClaudeCliConfig::default_for(CliAgentKind::Antigravity);
        assert_eq!((agy.fast_model.as_str(), agy.deep_model.as_str()), ("gemini-3.8-flash-low", "gemini-4-neon-medium"));
        let codex = ClaudeCliConfig::default_for(CliAgentKind::Codex);
        assert_eq!((codex.fast_model.as_str(), codex.fast_effort.as_str()), ("", "low"));
        assert_eq!((codex.deep_model.as_str(), codex.deep_effort.as_str()), ("", "medium"));
        for kind in CliAgentKind::ALL {
            let c = ClaudeCliConfig::default_for(kind);
            assert_eq!(c.fallback_provider, None);
        }
    }

    #[test]
    fn each_kind_has_its_own_config_and_catalog() {
        let s = CliSettings::isolated();
        let mut c = s.config(CliAgentKind::Codex);
        c.fast_model = "gpt-6.2-sol".into();
        s.set_config(CliAgentKind::Codex, c);
        assert_eq!(s.config(CliAgentKind::Codex).fast_model, "gpt-6.2-sol");
        assert_eq!(s.config(CliAgentKind::Claude).fast_model, "haiku");
        s.catalog(CliAgentKind::Codex).set(vec![info("gpt-6.2-sol", &["low"])]);
        assert!(s.catalog(CliAgentKind::Claude).get().is_none());
        assert!(s.catalog(CliAgentKind::Codex).get().is_some());
        assert!(!Arc::ptr_eq(&s.catalog(CliAgentKind::Claude), &s.catalog(CliAgentKind::Antigravity)));
    }

    #[test]
    fn the_active_kind_changes_once() {
        let s = CliSettings::isolated();
        assert_eq!(s.active(), CliAgentKind::Claude);
        assert!(!s.set_active(CliAgentKind::Claude));
        assert!(s.set_active(CliAgentKind::Codex));
        assert_eq!(s.active(), CliAgentKind::Codex);
        assert_eq!(s.active_config(), ClaudeCliConfig::default_for(CliAgentKind::Codex));
    }

    #[test]
    fn a_saved_model_that_is_gone_falls_back_to_the_first_listed_one() {
        let catalog = ModelCatalog::default();
        catalog.set(vec![info("gemini-4-neon-high", &[]), info("gemini-3.8-flash-low", &[])]);
        // Listed: kept.
        let kept = resolve_model(CliAgentKind::Antigravity, "gemini-3.8-flash-low", "low", &catalog);
        assert_eq!(kept, ResolvedModel { model: "gemini-3.8-flash-low".into(), effort: None });
        // The deep default is not listed: the first listed model.
        let fell = resolve_model(CliAgentKind::Antigravity, "gemini-4-neon-medium", "medium", &catalog);
        assert_eq!(fell.model, "gemini-4-neon-high");
        // Empty saved model ("first listed", Codex's default).
        let codex = ModelCatalog::default();
        codex.set(vec![info("gpt-6.2-sol", &["low", "medium", "high", "xhigh", "max", "ultra"]), info("gpt-6-luna", &["low"])]);
        let fast = resolve_model(CliAgentKind::Codex, "", "low", &codex);
        assert_eq!(fast, ResolvedModel { model: "gpt-6.2-sol".into(), effort: Some("low".into()) });
        let deep = resolve_model(CliAgentKind::Codex, "", "medium", &codex);
        assert_eq!(deep, ResolvedModel { model: "gpt-6.2-sol".into(), effort: Some("medium".into()) });
        // A retired Codex model: first listed, effort kept when it takes it.
        let gone = resolve_model(CliAgentKind::Codex, "gpt-old", "ultra", &codex);
        assert_eq!(gone, ResolvedModel { model: "gpt-6.2-sol".into(), effort: Some("ultra".into()) });
    }

    #[test]
    fn without_a_catalog_the_saved_model_is_used_as_it_is() {
        let catalog = ModelCatalog::default();
        let agy = resolve_model(CliAgentKind::Antigravity, "gemini-4-neon-medium", "medium", &catalog);
        assert_eq!(agy.model, "gemini-4-neon-medium");
        // Codex: empty = the account's own default model; effort passed on.
        let codex = resolve_model(CliAgentKind::Codex, "", "low", &catalog);
        assert_eq!(codex, ResolvedModel { model: String::new(), effort: Some("low".into()) });
        // An empty list is no catalog either.
        catalog.set(vec![]);
        assert_eq!(resolve_model(CliAgentKind::Codex, "x", "low", &catalog).model, "x");
    }

    #[test]
    fn codex_effort_is_clamped_to_the_model_and_antigravity_has_none() {
        let catalog = ModelCatalog::default();
        catalog.set(vec![info("luna", &["low", "medium", "high", "xhigh", "max"])]);
        // `ultra` is not offered by this model: the closest level.
        let r = resolve_model(CliAgentKind::Codex, "luna", "ultra", &catalog);
        assert_eq!(r.effort.as_deref(), Some("max"));
        let r = resolve_model(CliAgentKind::Antigravity, "luna", "high", &catalog);
        assert_eq!(r.effort, None);
        // Claude keeps its own rules (a model without effort support gets none).
        let claude = ModelCatalog::default();
        claude.set(vec![info("haiku", &[])]);
        assert_eq!(resolve_model(CliAgentKind::Claude, "haiku", "low", &claude).effort, None);
        assert_eq!(resolve_model(CliAgentKind::Claude, "sonnet", "low", &claude).effort.as_deref(), Some("low"));
    }
}
