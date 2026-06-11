use tauri::{command, AppHandle, Manager};

use crate::state::AppState;
use crate::stt::provider::{self, STTProviderType};

/// Switch the active STT provider.
///
/// `provider` is one of: "windows_native", "deepgram", "whisper_api", "azure_speech", "groq_whisper"
#[command]
pub async fn set_stt_provider(app: AppHandle, provider: String) -> Result<(), String> {
    let provider_type = STTProviderType::from_str(&provider)
        .ok_or_else(|| format!("Unknown STT provider: {}", provider))?;

    let state = app.state::<AppState>();

    // Initialize STTRouter if not yet created
    ensure_stt_initialized(&app, &state)?;

    let stt_arc = state
        .stt
        .as_ref()
        .ok_or("STT router not initialized")?
        .clone();

    // We need to use a tokio task since set_provider is async
    // but we're holding a std::sync::Mutex
    let mut router = stt_arc
        .lock()
        .map_err(|_| "STT state lock poisoned".to_string())?;

    // Load API key from credentials for the selected provider
    if let Some(ref cred_arc) = state.credentials {
        if let Ok(cred) = cred_arc.lock() {
            match provider_type {
                STTProviderType::Deepgram => {
                    if let Ok(Some(key)) = cred.get_key("deepgram") {
                        router.set_deepgram_api_key(&key);
                    }
                }
                STTProviderType::WhisperApi => {
                    if let Ok(Some(key)) = cred.get_key("whisper_api") {
                        router.set_whisper_api_key(&key);
                    }
                }
                STTProviderType::AzureSpeech => {
                    if let Ok(Some(key)) = cred.get_key("azure_speech") {
                        router.set_azure_speech_key(&key);
                    }
                    if let Ok(Some(region)) = cred.get_key("azure_speech_region") {
                        router.set_azure_speech_region(&region);
                    }
                }
                STTProviderType::GroqWhisper => {
                    if let Ok(Some(key)) = cred.get_key("groq_whisper") {
                        router.set_groq_whisper_api_key(&key);
                    }
                }
                STTProviderType::WindowsNative | STTProviderType::WhisperCpp => {
                    // No API key needed for local providers
                }
                STTProviderType::WebSpeech => {
                    // Frontend-only — no API key needed
                }
                STTProviderType::SherpaOnnx | STTProviderType::OrtStreaming | STTProviderType::ParakeetTdt => {
                    // Local providers — no API key needed
                }
            }
        }
    }

    // For async operations on the router, we use block_in_place
    // since the Mutex is std::sync, not tokio
    tokio::task::block_in_place(|| {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async { router.set_provider(provider_type).await })
    })?;

    log::info!("STT provider set to: {}", provider);
    Ok(())
}

/// Update the recognition language used by STT providers.
#[command]
pub async fn set_stt_language(app: AppHandle, language: String) -> Result<(), String> {
    let state = app.state::<AppState>();

    ensure_stt_initialized(&app, &state)?;

    let stt_arc = state
        .stt
        .as_ref()
        .ok_or("STT router not initialized")?
        .clone();

    let mut router = stt_arc
        .lock()
        .map_err(|_| "STT state lock poisoned".to_string())?;

    router.set_language(&language);
    log::info!("STT language set to: {}", language);
    Ok(())
}

/// Test whether a given STT provider is available and configured correctly.
#[command]
pub async fn test_stt_connection(app: AppHandle, provider: String) -> Result<bool, String> {
    let provider_type = STTProviderType::from_str(&provider)
        .ok_or_else(|| format!("Unknown STT provider: {}", provider))?;

    let state = app.state::<AppState>();

    // Initialize STTRouter if needed
    ensure_stt_initialized(&app, &state)?;

    let stt_arc = state
        .stt
        .as_ref()
        .ok_or("STT router not initialized")?
        .clone();

    let mut router = stt_arc
        .lock()
        .map_err(|_| "STT state lock poisoned".to_string())?;

    // Load API keys from credentials before testing
    if let Some(ref cred_arc) = state.credentials {
        if let Ok(cred) = cred_arc.lock() {
            match provider_type {
                STTProviderType::Deepgram => {
                    if let Ok(Some(key)) = cred.get_key("deepgram") {
                        router.set_deepgram_api_key(&key);
                    }
                }
                STTProviderType::WhisperApi => {
                    if let Ok(Some(key)) = cred.get_key("whisper_api") {
                        router.set_whisper_api_key(&key);
                    }
                }
                STTProviderType::AzureSpeech => {
                    if let Ok(Some(key)) = cred.get_key("azure_speech") {
                        router.set_azure_speech_key(&key);
                    }
                    if let Ok(Some(region)) = cred.get_key("azure_speech_region") {
                        router.set_azure_speech_region(&region);
                    }
                }
                STTProviderType::GroqWhisper => {
                    if let Ok(Some(key)) = cred.get_key("groq_whisper") {
                        router.set_groq_whisper_api_key(&key);
                    }
                }
                STTProviderType::WindowsNative | STTProviderType::WhisperCpp => {}
                STTProviderType::WebSpeech => {}
                STTProviderType::SherpaOnnx | STTProviderType::OrtStreaming | STTProviderType::ParakeetTdt => {
                    // Local providers — no API key needed
                }
            }
        }
    }

    let result = tokio::task::block_in_place(|| {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async { router.test_provider_connection(&provider_type).await })
    })?;

    Ok(result)
}

/// Update whisper.cpp dual-pass configuration. Takes effect immediately,
/// even during an active meeting.
#[command]
pub async fn update_whisper_dual_pass_config(
    app: AppHandle,
    short_chunk_secs: f32,
    long_chunk_secs: f32,
    pause_secs: f32,
) -> Result<(), String> {
    use crate::stt::provider::DualPassConfig;

    let new_config = DualPassConfig {
        short_chunk_secs: short_chunk_secs.clamp(0.3, 5.0),
        long_chunk_secs: long_chunk_secs.clamp(1.0, 10.0),
        pause_secs: pause_secs.clamp(0.3, 5.0),
    };

    // Write to the shared config — WhisperCppSTT reads this on each feed_audio call.
    let config_arc = app.state::<AppState>().whisper_config.clone();
    let result = {
        match config_arc.write() {
            Ok(mut cfg) => {
                *cfg = new_config;
                log::info!(
                    "Whisper dual-pass config updated: fast={}s, correction={}s, pause={}s",
                    cfg.short_chunk_secs,
                    cfg.long_chunk_secs,
                    cfg.pause_secs
                );
                Ok(())
            }
            Err(_) => Err("Config lock poisoned".to_string()),
        }
    };
    result
}

/// List available STT providers with their metadata.
#[command]
pub async fn get_available_stt_providers() -> Result<String, String> {
    let providers = provider::list_available_providers();
    serde_json::to_string(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))
}

/// Ensure the STTRouter is initialized in the app state.
/// This is a helper that initializes lazily on first use.
fn ensure_stt_initialized(_app: &AppHandle, state: &AppState) -> Result<(), String> {
    // The AppState.stt field is Option<Arc<Mutex<STTRouter>>>.
    // Since AppState is behind Tauri's managed state (immutable reference),
    // we can't directly mutate it here. The STTRouter should be initialized
    // in lib.rs setup. For now, if it's None, we log a warning.
    //
    // In practice, lib.rs should initialize it during setup just like LLMRouter.
    if state.stt.is_none() {
        log::warn!("STT router not initialized — it should be initialized in app setup");
        return Err("STT router not initialized. Please restart the application.".to_string());
    }
    Ok(())
}

/// Update the Deepgram model/feature configuration.
/// The config takes effect on the next Deepgram connection (not mid-stream).
#[command]
pub async fn update_deepgram_config(app: AppHandle, config_json: String) -> Result<(), String> {
    let config: crate::stt::deepgram::DeepgramConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid Deepgram config JSON: {}", e))?;

    let state = app.state::<AppState>();
    if let Some(ref stt_arc) = state.stt {
        let mut router = stt_arc
            .lock()
            .map_err(|_| "STT state lock poisoned".to_string())?;
        router.set_deepgram_config(config);
        log::info!("Deepgram config updated via IPC");
    }
    Ok(())
}

/// Update the Groq Whisper configuration.
/// Takes effect immediately — the running provider reads the shared config
/// on each API call, so settings changes apply to the very next batch.
#[command]
pub async fn update_groq_config(app: AppHandle, config_json: String) -> Result<(), String> {
    let config: crate::stt::groq_whisper::GroqConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid Groq config JSON: {}", e))?;

    let state = app.state::<AppState>();

    // Update the shared config Arc — running providers read this on each API call
    {
        let mut cfg = state
            .shared_groq_config
            .write()
            .map_err(|_| "Groq config lock poisoned".to_string())?;
        *cfg = config.clone();
    }

    // Also update the STTRouter's copy (for new provider creation)
    if let Some(ref stt_arc) = state.stt {
        let mut router = stt_arc
            .lock()
            .map_err(|_| "STT state lock poisoned".to_string())?;
        router.set_groq_config(config);
    }

    log::info!("Groq config updated via IPC (applies immediately to running provider)");
    Ok(())
}

/// Set the universal pause threshold for transcript line-breaking.
/// Takes effect immediately for system audio STT (the spawned task reads
/// the atomic value on each result). Value is in milliseconds.
#[command]
pub async fn set_pause_threshold(app: AppHandle, ms: u64) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let state = app.state::<AppState>();
    state.pause_threshold_ms.store(ms, Ordering::Relaxed);
    log::info!("Pause threshold updated to {}ms", ms);
    Ok(())
}

/// Get the current pause threshold (ms).
#[command]
pub async fn get_pause_threshold(app: AppHandle) -> Result<u64, String> {
    use std::sync::atomic::Ordering;
    let state = app.state::<AppState>();
    Ok(state.pause_threshold_ms.load(Ordering::Relaxed))
}

/// Estimate Deepgram cost for a given meeting duration.
/// Returns JSON: { "cost_usd": 0.46, "streams": 2, "rate_per_min": 0.0043 }
#[command]
pub async fn estimate_deepgram_cost(duration_minutes: f32) -> Result<String, String> {
    let streams = 2u32; // typically You + Them
    let (cost, rate) = crate::stt::deepgram::estimate_cost(duration_minutes, streams);
    let result = serde_json::json!({
        "cost_usd": (cost * 100.0).round() / 100.0,
        "streams": streams,
        "rate_per_min": rate,
    });
    serde_json::to_string(&result)
        .map_err(|e| format!("Failed to serialize cost estimate: {}", e))
}
