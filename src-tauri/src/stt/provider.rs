// Sub-PRD 4: STT Provider trait and types

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::audio::AudioChunk;

/// Result emitted by an STT provider for each recognition event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptResult {
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    pub timestamp_ms: u64,
    pub speaker: Option<String>,
    pub language: Option<String>,
    /// Optional segment ID — when set, the IPC layer uses this directly
    /// instead of generating one from a counter. Used by dual-pass whisper.cpp.
    #[serde(skip)]
    pub segment_id: Option<String>,
}

/// Runtime configuration for whisper.cpp dual-pass transcription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DualPassConfig {
    /// Fast-pass chunk duration in seconds (default 1.0)
    pub short_chunk_secs: f32,
    /// Correction-pass chunk duration in seconds (default 3.0)
    pub long_chunk_secs: f32,
    /// Silence duration before finalizing a line (default 1.5)
    pub pause_secs: f32,
}

impl Default for DualPassConfig {
    fn default() -> Self {
        Self {
            short_chunk_secs: 1.0,
            long_chunk_secs: 3.0,
            pause_secs: 1.5,
        }
    }
}

/// Configuration common to all STT providers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct STTProviderConfig {
    pub language: String,
    pub api_key: Option<String>,
}

impl Default for STTProviderConfig {
    fn default() -> Self {
        Self {
            language: "en-US".to_string(),
            api_key: None,
        }
    }
}

/// Supported STT provider types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum STTProviderType {
    WindowsNative,
    Deepgram,
    /// Sub-PRD 9: OpenAI Whisper REST API
    WhisperApi,
    /// Sub-PRD 9: Azure Cognitive Services
    AzureSpeech,
    /// Sub-PRD 9: Groq Whisper
    GroqWhisper,
    /// Frontend-only Web Speech API — never instantiated in Rust.
    /// Exists so per-party config can reference it as a valid STT choice.
    WebSpeech,
    /// Local Whisper.cpp engine — runs inference on a dedicated thread.
    WhisperCpp,
    /// Sherpa-ONNX sidecar process — true streaming transducer, fully offline.
    SherpaOnnx,
    /// ONNX Runtime in-process — streaming transducer loaded via ort crate.
    OrtStreaming,
    /// NVIDIA Parakeet TDT — CTC/TDT architecture via ONNX Runtime.
    /// #1 on Open ASR Leaderboard (~6% WER), native streaming.
    ParakeetTdt,
}

impl STTProviderType {
    pub fn as_str(&self) -> &str {
        match self {
            STTProviderType::WindowsNative => "windows_native",
            STTProviderType::Deepgram => "deepgram",
            STTProviderType::WhisperApi => "whisper_api",
            STTProviderType::AzureSpeech => "azure_speech",
            STTProviderType::GroqWhisper => "groq_whisper",
            STTProviderType::WebSpeech => "web_speech",
            STTProviderType::WhisperCpp => "whisper_cpp",
            STTProviderType::SherpaOnnx => "sherpa_onnx",
            STTProviderType::OrtStreaming => "ort_streaming",
            STTProviderType::ParakeetTdt => "parakeet_tdt",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "windows_native" => Some(STTProviderType::WindowsNative),
            "whisper_cpp" => Some(STTProviderType::WhisperCpp),
            "deepgram" => Some(STTProviderType::Deepgram),
            "whisper_api" => Some(STTProviderType::WhisperApi),
            "azure_speech" => Some(STTProviderType::AzureSpeech),
            "groq_whisper" => Some(STTProviderType::GroqWhisper),
            "web_speech" => Some(STTProviderType::WebSpeech),
            "sherpa_onnx" => Some(STTProviderType::SherpaOnnx),
            "ort_streaming" => Some(STTProviderType::OrtStreaming),
            "parakeet_tdt" => Some(STTProviderType::ParakeetTdt),
            _ => None,
        }
    }
}

/// Trait that all STT providers implement.
/// Each provider receives audio chunks and emits transcript results.
#[async_trait]
pub trait STTProvider: Send + Sync {
    /// Human-readable name for this provider.
    fn provider_name(&self) -> &str;

    /// The provider type identifier.
    fn provider_type(&self) -> STTProviderType;

    /// Start the recognition stream.
    /// `result_tx` is the channel where TranscriptResults will be sent.
    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Feed an audio chunk to the provider for recognition.
    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Stop the recognition stream and clean up resources.
    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Test whether the provider is available/configured correctly.
    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;

    /// Set the recognition language (e.g., "en-US", "es-ES").
    fn set_language(&mut self, language: &str);
}

/// Provider info for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct STTProviderInfo {
    pub provider_type: String,
    pub name: String,
    pub requires_api_key: bool,
    pub is_local: bool,
    pub supported_languages: Vec<String>,
}

/// List of available providers with metadata.
pub fn list_available_providers() -> Vec<STTProviderInfo> {
    vec![
        STTProviderInfo {
            provider_type: "web_speech".to_string(),
            name: "Web Speech API".to_string(),
            requires_api_key: false,
            is_local: true,
            supported_languages: vec![
                "en-US".to_string(),
                "en-GB".to_string(),
                "es-ES".to_string(),
                "fr-FR".to_string(),
                "de-DE".to_string(),
                "it-IT".to_string(),
                "pt-BR".to_string(),
                "ja-JP".to_string(),
                "zh-CN".to_string(),
                "ko-KR".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "whisper_cpp".to_string(),
            name: "Whisper.cpp (Local)".to_string(),
            requires_api_key: false,
            is_local: true,
            supported_languages: vec![
                "en-US".to_string(),
                "en-GB".to_string(),
                "es-ES".to_string(),
                "fr-FR".to_string(),
                "de-DE".to_string(),
                "it-IT".to_string(),
                "pt-BR".to_string(),
                "ja-JP".to_string(),
                "zh-CN".to_string(),
                "ko-KR".to_string(),
                "nl-NL".to_string(),
                "hi-IN".to_string(),
                "ru-RU".to_string(),
                "ar-SA".to_string(),
                "tr-TR".to_string(),
                "pl-PL".to_string(),
                "sv-SE".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "deepgram".to_string(),
            name: "Deepgram".to_string(),
            requires_api_key: true,
            is_local: false,
            supported_languages: vec![
                "en".to_string(),
                "en-US".to_string(),
                "en-GB".to_string(),
                "es".to_string(),
                "fr".to_string(),
                "de".to_string(),
                "it".to_string(),
                "pt".to_string(),
                "ja".to_string(),
                "zh".to_string(),
                "ko".to_string(),
                "nl".to_string(),
                "hi".to_string(),
                "ru".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "whisper_api".to_string(),
            name: "Whisper API (OpenAI)".to_string(),
            requires_api_key: true,
            is_local: false,
            supported_languages: vec![
                "en".to_string(),
                "es".to_string(),
                "fr".to_string(),
                "de".to_string(),
                "it".to_string(),
                "pt".to_string(),
                "ja".to_string(),
                "zh".to_string(),
                "ko".to_string(),
                "nl".to_string(),
                "hi".to_string(),
                "ru".to_string(),
                "ar".to_string(),
                "tr".to_string(),
                "pl".to_string(),
                "sv".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "azure_speech".to_string(),
            name: "Azure Speech".to_string(),
            requires_api_key: true,
            is_local: false,
            supported_languages: vec![
                "en-US".to_string(),
                "en-GB".to_string(),
                "es-ES".to_string(),
                "fr-FR".to_string(),
                "de-DE".to_string(),
                "it-IT".to_string(),
                "pt-BR".to_string(),
                "ja-JP".to_string(),
                "zh-CN".to_string(),
                "ko-KR".to_string(),
                "nl-NL".to_string(),
                "hi-IN".to_string(),
                "ru-RU".to_string(),
                "ar-SA".to_string(),
                "tr-TR".to_string(),
                "pl-PL".to_string(),
                "sv-SE".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "groq_whisper".to_string(),
            name: "Groq Whisper".to_string(),
            requires_api_key: true,
            is_local: false,
            supported_languages: vec![
                "en".to_string(),
                "es".to_string(),
                "fr".to_string(),
                "de".to_string(),
                "it".to_string(),
                "pt".to_string(),
                "ja".to_string(),
                "zh".to_string(),
                "ko".to_string(),
                "nl".to_string(),
                "hi".to_string(),
                "ru".to_string(),
                "ar".to_string(),
                "tr".to_string(),
                "pl".to_string(),
                "sv".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "sherpa_onnx".to_string(),
            name: "Sherpa-ONNX (Local, Streaming)".to_string(),
            requires_api_key: false,
            is_local: true,
            supported_languages: vec![
                "en".to_string(),
                "zh".to_string(),
                "de".to_string(),
                "es".to_string(),
                "fr".to_string(),
                "ja".to_string(),
                "ko".to_string(),
                "ru".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "ort_streaming".to_string(),
            name: "ORT Streaming (Local, GPU)".to_string(),
            requires_api_key: false,
            is_local: true,
            supported_languages: vec![
                "en".to_string(),
                "zh".to_string(),
                "de".to_string(),
                "es".to_string(),
                "fr".to_string(),
                "ja".to_string(),
                "ko".to_string(),
                "ru".to_string(),
            ],
        },
        STTProviderInfo {
            provider_type: "parakeet_tdt".to_string(),
            name: "Parakeet TDT (Best Local)".to_string(),
            requires_api_key: false,
            is_local: true,
            supported_languages: vec![
                "bg".to_string(),
                "hr".to_string(),
                "cs".to_string(),
                "da".to_string(),
                "nl".to_string(),
                "en".to_string(),
                "et".to_string(),
                "fi".to_string(),
                "fr".to_string(),
                "de".to_string(),
                "el".to_string(),
                "hu".to_string(),
                "it".to_string(),
                "lv".to_string(),
                "lt".to_string(),
                "mt".to_string(),
                "pl".to_string(),
                "pt".to_string(),
                "ro".to_string(),
                "sk".to_string(),
                "sl".to_string(),
                "es".to_string(),
                "sv".to_string(),
                "ru".to_string(),
                "uk".to_string(),
            ],
        },
    ]
}
