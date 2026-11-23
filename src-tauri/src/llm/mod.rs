pub mod anthropic;
pub mod cli_agent;
pub mod custom;
pub mod gemini;
pub mod gemini_cache;
pub mod ollama;
pub mod openai_compat;
pub mod openrouter_models;
pub mod provider;
pub mod stream_parser;
pub mod thinking;

use provider::{LLMError, LLMProvider};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// Provider type enum matching the frontend LLMProviderType
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    Ollama,
    LmStudio,
    Openai,
    Anthropic,
    Groq,
    Gemini,
    Openrouter,
    Custom,
    /// The local Claude Code CLI on the user's own subscription login.
    ClaudeCli,
    /// The local Antigravity CLI (`agy`) on the user's Google sign-in.
    AntigravityCli,
    /// The local Codex CLI on the user's ChatGPT sign-in.
    CodexCli,
}

impl ProviderType {
    pub fn from_str(s: &str) -> Result<Self, LLMError> {
        match s {
            "ollama" => Ok(Self::Ollama),
            "lm_studio" => Ok(Self::LmStudio),
            "openai" => Ok(Self::Openai),
            "anthropic" => Ok(Self::Anthropic),
            "groq" => Ok(Self::Groq),
            "gemini" => Ok(Self::Gemini),
            "openrouter" => Ok(Self::Openrouter),
            "custom" => Ok(Self::Custom),
            "claude_cli" => Ok(Self::ClaudeCli),
            "antigravity_cli" => Ok(Self::AntigravityCli),
            "codex_cli" => Ok(Self::CodexCli),
            _ => Err(LLMError::NotConfigured(format!(
                "Unknown provider type: {}",
                s
            ))),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Ollama => "ollama",
            Self::LmStudio => "lm_studio",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Groq => "groq",
            Self::Gemini => "gemini",
            Self::Openrouter => "openrouter",
            Self::Custom => "custom",
            Self::ClaudeCli => "claude_cli",
            Self::AntigravityCli => "antigravity_cli",
            Self::CodexCli => "codex_cli",
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Groq => "Groq",
            Self::Gemini => "Google Gemini",
            Self::Openrouter => "OpenRouter",
            Self::Custom => "Custom",
            Self::ClaudeCli => "Claude (subscription)",
            Self::AntigravityCli => "Antigravity (subscription)",
            Self::CodexCli => "Codex (subscription)",
        }
    }

    pub fn default_base_url(&self) -> &str {
        match self {
            Self::Ollama => "http://localhost:11434",
            Self::LmStudio => "http://localhost:1234/v1",
            Self::Openai => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::Openrouter => "https://openrouter.ai/api/v1",
            Self::Custom | Self::ClaudeCli | Self::AntigravityCli | Self::CodexCli => "",
        }
    }

    pub fn requires_api_key(&self) -> bool {
        matches!(
            self,
            Self::Openai | Self::Anthropic | Self::Groq | Self::Gemini | Self::Openrouter
        )
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio) || self.is_cli_agent()
    }

    /// A provider that drives a local, logged-in coding-agent CLI (Claude,
    /// Antigravity, Codex): long-lived sessions, no API key.
    pub fn is_cli_agent(&self) -> bool {
        self.cli_agent_kind().is_some()
    }

    /// Which CLI agent this provider drives, if it is one.
    pub fn cli_agent_kind(&self) -> Option<cli_agent::CliAgentKind> {
        match self {
            Self::ClaudeCli => Some(cli_agent::CliAgentKind::Claude),
            Self::AntigravityCli => Some(cli_agent::CliAgentKind::Antigravity),
            Self::CodexCli => Some(cli_agent::CliAgentKind::Codex),
            _ => None,
        }
    }
}

/// Provider configuration used when switching providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub auth_type: Option<String>,
    pub auth_value: Option<String>,
    pub auth_header: Option<String>,
    /// How much the model thinks. Saved configs from before this setting lack
    /// it and load as `Auto`: nothing is sent, exactly as before.
    #[serde(default)]
    pub thinking: thinking::ThinkingSetting,
    /// Optional JSON object merged into the request body (Ollama, LM Studio,
    /// custom endpoints and OpenRouter only; ignored elsewhere).
    #[serde(default)]
    pub extra_request_json: Option<String>,
}

impl ProviderConfig {
    /// The request options this config asks for. The extra JSON only applies
    /// to the providers that offer it.
    pub fn request_options(&self) -> thinking::RequestOptions {
        let offers_extra = matches!(
            ProviderType::from_str(&self.provider_type),
            Ok(ProviderType::Ollama | ProviderType::LmStudio | ProviderType::Openrouter | ProviderType::Custom)
        );
        thinking::RequestOptions {
            thinking: self.thinking,
            extra_json: if offers_extra { self.extra_request_json.clone() } else { None },
        }
    }
}

/// Provider info returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    #[serde(rename = "type")]
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub requires_api_key: bool,
    pub is_local: bool,
}

/// Build a provider client from a config without touching any router state.
/// Used for the active provider (`LLMRouter::set_provider`) and for temporary
/// providers (browsing models, connection tests, fallback).
pub fn create_provider(config: &ProviderConfig) -> Result<Box<dyn LLMProvider>, String> {
    let provider_type = ProviderType::from_str(&config.provider_type).map_err(|e| match e {
        LLMError::NotConfigured(msg) => msg,
        other => other.to_string(),
    })?;

    let options = config.request_options();
    let provider: Box<dyn LLMProvider> = match provider_type {
        ProviderType::Ollama => Box::new(
            ollama::OllamaClient::new(config.base_url.as_deref()).with_options(options),
        ),
        ProviderType::LmStudio => Box::new(
            openai_compat::create_lm_studio_client(config.base_url.as_deref()).with_options(options),
        ),
        ProviderType::Openai => {
            let api_key = config
                .api_key
                .as_deref()
                .ok_or_else(|| "OpenAI API key required".to_string())?;
            Box::new(openai_compat::create_openai_client(api_key).with_options(options))
        }
        ProviderType::Anthropic => {
            let api_key = config
                .api_key
                .as_deref()
                .ok_or_else(|| "Anthropic API key required".to_string())?;
            Box::new(
                anthropic::AnthropicClient::new(api_key, config.base_url.as_deref()).with_options(options),
            )
        }
        ProviderType::Groq => {
            let api_key = config
                .api_key
                .as_deref()
                .ok_or_else(|| "Groq API key required".to_string())?;
            Box::new(openai_compat::create_groq_client(api_key).with_options(options))
        }
        ProviderType::Gemini => {
            let api_key = config
                .api_key
                .as_deref()
                .ok_or_else(|| "Gemini API key required".to_string())?;
            Box::new(gemini::GeminiClient::new(api_key, config.base_url.as_deref()).with_options(options))
        }
        ProviderType::Openrouter => {
            let api_key = config
                .api_key
                .as_deref()
                .ok_or_else(|| "OpenRouter API key required".to_string())?;
            Box::new(openai_compat::create_openrouter_client(api_key).with_options(options))
        }
        ProviderType::Custom => {
            let base_url = config
                .base_url
                .clone()
                .ok_or_else(|| "Custom endpoint base URL required".to_string())?;
            let auth_type = match config.auth_type.as_deref() {
                Some("bearer") => custom::CustomAuthType::Bearer,
                Some("api_key") | Some("api-key") => custom::CustomAuthType::ApiKey,
                _ => custom::CustomAuthType::None,
            };
            Box::new(
                custom::CustomClient::new(custom::CustomConfig {
                    base_url,
                    auth_type,
                    auth_value: config.auth_value.clone(),
                    auth_header: config.auth_header.clone(),
                })
                .with_options(options),
            )
        }
        // Needs no config: it reaches the session manager through the
        // `AppHandle` passed to every `stream_completion` call.
        ProviderType::ClaudeCli | ProviderType::AntigravityCli | ProviderType::CodexCli => {
            let kind = provider_type.cli_agent_kind().expect("a CLI agent provider type");
            Box::new(cli_agent::provider::CliAgentProvider::new(kind))
        }
    };

    Ok(provider)
}

/// Routes to active LLM provider, supports hot-switching and cancellation.
pub struct LLMRouter {
    active_provider: Option<Arc<TokioMutex<Box<dyn LLMProvider>>>>,
    active_model: String,
    active_provider_type: Option<ProviderType>,
    cancel_token: Arc<TokioMutex<bool>>,
}

impl LLMRouter {
    pub fn new() -> Self {
        Self {
            active_provider: None,
            active_model: String::new(),
            active_provider_type: None,
            cancel_token: Arc::new(TokioMutex::new(false)),
        }
    }

    /// Set the active provider, creating the appropriate client.
    pub fn set_provider(
        &mut self,
        config: ProviderConfig,
    ) -> Result<(), LLMError> {
        let provider_type = ProviderType::from_str(&config.provider_type)?;
        let provider = create_provider(&config).map_err(LLMError::NotConfigured)?;

        self.active_provider = Some(Arc::new(TokioMutex::new(provider)));
        self.active_provider_type = Some(provider_type);
        Ok(())
    }

    /// Get a reference to the active provider (behind a tokio mutex for async access).
    pub fn get_provider(&self) -> Result<Arc<TokioMutex<Box<dyn LLMProvider>>>, LLMError> {
        self.active_provider
            .clone()
            .ok_or_else(|| LLMError::NotConfigured("No LLM provider configured".to_string()))
    }

    /// Get the active model name.
    pub fn active_model(&self) -> &str {
        &self.active_model
    }

    /// Set the active model.
    pub fn set_active_model(&mut self, model: String) {
        self.active_model = model;
    }

    /// Get the active provider type.
    pub fn active_provider_type(&self) -> Option<&ProviderType> {
        self.active_provider_type.as_ref()
    }

    /// Request cancellation of the current stream.
    pub async fn cancel(&self) {
        let mut cancel = self.cancel_token.lock().await;
        *cancel = true;
    }

    /// Check if cancellation was requested and reset the flag.
    pub async fn check_cancelled(&self) -> bool {
        let mut cancel = self.cancel_token.lock().await;
        let was_cancelled = *cancel;
        if was_cancelled {
            *cancel = false;
        }
        was_cancelled
    }

    /// Get information about all available providers.
    pub fn get_all_providers() -> Vec<ProviderInfo> {
        let all_types = [
            ProviderType::Ollama,
            ProviderType::LmStudio,
            ProviderType::Openai,
            ProviderType::Anthropic,
            ProviderType::Groq,
            ProviderType::Gemini,
            ProviderType::Openrouter,
            ProviderType::Custom,
            ProviderType::ClaudeCli,
            ProviderType::AntigravityCli,
            ProviderType::CodexCli,
        ];

        all_types
            .iter()
            .map(|pt| ProviderInfo {
                provider_type: pt.as_str().to_string(),
                name: pt.display_name().to_string(),
                base_url: pt.default_base_url().to_string(),
                requires_api_key: pt.requires_api_key(),
                is_local: pt.is_local(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider_type: &str, api_key: Option<&str>, base_url: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            provider_type: provider_type.to_string(),
            api_key: api_key.map(String::from),
            base_url: base_url.map(String::from),
            auth_type: None,
            auth_value: None,
            auth_header: None,
            thinking: thinking::ThinkingSetting::Auto,
            extra_request_json: None,
        }
    }

    #[test]
    fn create_provider_does_not_touch_router() {
        let mut router = LLMRouter::new();
        router.set_provider(cfg("ollama", None, None)).unwrap();

        let temp = create_provider(&cfg("openai", Some("sk-test"), None));
        assert!(temp.is_ok());
        assert_eq!(router.active_provider_type(), Some(&ProviderType::Ollama));

        let err = create_provider(&cfg("custom", None, None)).err();
        assert!(err.is_some(), "custom without base_url must fail");
        assert_eq!(router.active_provider_type(), Some(&ProviderType::Ollama));
    }

    #[test]
    fn claude_cli_provider_type_roundtrip() {
        let pt = ProviderType::from_str("claude_cli").unwrap();
        assert_eq!(pt, ProviderType::ClaudeCli);
        assert_eq!(pt.as_str(), "claude_cli");
        assert_eq!(ProviderType::from_str(pt.as_str()).unwrap(), pt);
        assert_eq!(serde_json::to_string(&pt).unwrap(), "\"claude_cli\"");
        assert_eq!(pt.display_name(), "Claude (subscription)");
    }

    #[test]
    fn antigravity_and_codex_provider_types() {
        let cases = [
            ("antigravity_cli", ProviderType::AntigravityCli, "Antigravity (subscription)"),
            ("codex_cli", ProviderType::CodexCli, "Codex (subscription)"),
        ];
        for (id, pt, name) in cases {
            assert_eq!(ProviderType::from_str(id).unwrap(), pt);
            assert_eq!(pt.as_str(), id);
            assert_eq!(pt.display_name(), name);
            assert_eq!(serde_json::to_string(&pt).unwrap(), format!("\"{id}\""));
            assert!(!pt.requires_api_key());
            assert!(pt.is_local());
            assert!(pt.is_cli_agent());
            assert_eq!(pt.default_base_url(), "");
            assert!(create_provider(&cfg(id, None, None)).is_ok());
            assert!(LLMRouter::get_all_providers()
                .iter()
                .any(|p| p.provider_type == id && !p.requires_api_key && p.is_local));
        }
        assert!(ProviderType::ClaudeCli.is_cli_agent());
        for pt in [ProviderType::Ollama, ProviderType::LmStudio, ProviderType::Openai, ProviderType::Custom, ProviderType::Gemini] {
            assert!(!pt.is_cli_agent());
            assert_eq!(pt.cli_agent_kind(), None);
        }
        // Gemini CLI is not a provider here (Google does not allow it on a subscription).
        assert!(ProviderType::from_str("gemini_cli").is_err());
    }

    #[test]
    fn claude_cli_requires_no_key() {
        assert!(!ProviderType::ClaudeCli.requires_api_key());
        assert!(ProviderType::ClaudeCli.is_local());
        assert!(create_provider(&cfg("claude_cli", None, None)).is_ok());
        assert!(LLMRouter::get_all_providers()
            .iter()
            .any(|p| p.provider_type == "claude_cli" && !p.requires_api_key && p.is_local));
    }

    #[test]
    fn create_provider_rejects_missing_key_and_unknown_type() {
        assert!(create_provider(&cfg("openai", None, None)).is_err());
        assert!(create_provider(&cfg("nope", None, None)).is_err());
    }

    #[test]
    fn an_old_saved_config_loads_as_auto_with_no_extra_json() {
        // What every config saved before the thinking setting looks like.
        let old = r#"{"provider_type":"ollama","api_key":null,"base_url":"http://localhost:11434","auth_type":null,"auth_value":null,"auth_header":null}"#;
        let config: ProviderConfig = serde_json::from_str(old).unwrap();
        assert_eq!(config.thinking, thinking::ThinkingSetting::Auto);
        assert!(config.extra_request_json.is_none());
        let options = config.request_options();
        assert!(options.thinking.is_auto());
        assert!(options.extra_request().is_none());
        assert!(create_provider(&config).is_ok());

        // The frontend sends only the fields it has: provider type alone works.
        let bare: ProviderConfig = serde_json::from_str(r#"{"provider_type":"claude_cli"}"#).unwrap();
        assert!(bare.thinking.is_auto());
        assert!(create_provider(&bare).is_ok());
    }

    #[test]
    fn a_new_config_carries_thinking_and_extra_json_only_where_offered() {
        let json = r#"{"provider_type":"ollama","thinking":"off","extra_request_json":"{\"options\":{\"num_ctx\":8192}}"}"#;
        let config: ProviderConfig = serde_json::from_str(json).unwrap();
        let o = config.request_options();
        assert_eq!(o.thinking, thinking::ThinkingSetting::Off);
        assert_eq!(o.extra_request().unwrap()["options"]["num_ctx"], 8192);

        // OpenAI offers no extra JSON: it is dropped, thinking stays.
        let openai: ProviderConfig = serde_json::from_str(
            r#"{"provider_type":"openai","api_key":"k","thinking":"high","extra_request_json":"{\"a\":1}"}"#,
        )
        .unwrap();
        let o = openai.request_options();
        assert_eq!(o.thinking, thinking::ThinkingSetting::High);
        assert!(o.extra_request().is_none());

        // A damaged value never breaks loading.
        let bad: ProviderConfig = serde_json::from_str(r#"{"provider_type":"ollama","thinking":"nonsense"}"#).unwrap();
        assert!(bad.thinking.is_auto());
    }
}
