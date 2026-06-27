use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{command, AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::audio::device_manager;
use crate::audio::session_monitor;
use crate::audio::vad::{calculate_peak, calculate_rms, VoiceActivityDetector};
use crate::audio::{AudioCaptureManager, AudioLevel, AudioSource};
use crate::stt::provider::STTProvider;
use crate::state::AppState;

/// List all available audio input and output devices.
#[command]
pub async fn list_audio_devices() -> Result<String, String> {
    let device_list = device_manager::enumerate_devices()?;
    serde_json::to_string(&device_list).map_err(|e| format!("Failed to serialize devices: {}", e))
}

/// Start dual audio capture (mic + system).
#[command]
pub async fn start_capture(
    app: AppHandle,
    mic_device_id: String,
    system_device_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Check if already capturing
    {
        let guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        if let Some(ref mgr) = *guard {
            if mgr.is_capturing() {
                return Err("Capture already in progress".to_string());
            }
        }
    }

    // Create the audio chunk channel
    let (tx, mut rx) = mpsc::channel::<crate::audio::AudioChunk>(256);

    // Initialize and start the manager
    {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        mgr.start_capture(&mic_device_id, &system_device_id, false, tx)?;
    }

    // ---- System Audio STT (for remote party in calls) ----
    // Mic transcription is handled by Web Speech API in the frontend.
    // System audio (WASAPI loopback = other party in Zoom/Meet) needs a
    // cloud STT provider (Deepgram/Whisper/Azure/Groq) configured in Settings.
    // If no cloud provider is configured, system audio won't be transcribed.
    let system_stt: Option<Box<dyn STTProvider>> = {
        let stt_config = state.stt.as_ref().and_then(|stt_arc| {
            let router = stt_arc.lock().ok()?;
            let provider_type = router.active_provider_type()?.clone();
            use crate::stt::provider::STTProviderType;
            if provider_type == STTProviderType::WindowsNative {
                return None; // WindowsNative can't transcribe system audio
            }
            Some((
                provider_type,
                router.deepgram_api_key.clone(),
                router.deepgram_config.clone(),
                router.whisper_api_key.clone(),
                router.azure_speech_key.clone(),
                router.azure_speech_region.clone(),
                router.groq_whisper_api_key.clone(),
                router.language.clone(),
            ))
        });

        match stt_config {
            Some((pt, dk, dg_cfg, wk, ak, ar, gk, lang)) => {
                use crate::stt::provider::STTProviderType;
                let p: Box<dyn STTProvider> = match pt {
                    STTProviderType::Deepgram => {
                        let mut p = match dk.as_deref() {
                            Some(k) => crate::stt::deepgram::DeepgramSTT::with_api_key(k),
                            None => crate::stt::deepgram::DeepgramSTT::new(),
                        };
                        p.set_language(&lang);
                        p.set_config(dg_cfg);
                        Box::new(p)
                    }
                    STTProviderType::WhisperApi => {
                        let mut p = match wk.as_deref() {
                            Some(k) => crate::stt::whisper_api::WhisperApiSTT::with_api_key(k),
                            None => crate::stt::whisper_api::WhisperApiSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    STTProviderType::AzureSpeech => {
                        let mut p = match (ak.as_deref(), ar.as_deref()) {
                            (Some(k), Some(r)) => crate::stt::azure_speech::AzureSpeechSTT::with_config(k, r),
                            _ => crate::stt::azure_speech::AzureSpeechSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    STTProviderType::GroqWhisper => {
                        let mut p = match gk.as_deref() {
                            Some(k) => crate::stt::groq_whisper::GroqWhisperSTT::with_api_key(k),
                            None => crate::stt::groq_whisper::GroqWhisperSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    _ => return Ok(()), // shouldn't reach
                };
                Some(p)
            }
            None => {
                log::info!(
                    "No cloud STT configured — system audio (remote party) won't be transcribed. \
                     Set up Deepgram/Whisper/Azure/Groq in Settings → STT."
                );
                None
            }
        }
    };

    // Start system STT if available
    let (sys_stt_tx, mut sys_stt_rx) =
        mpsc::channel::<crate::stt::provider::TranscriptResult>(256);
    let mut system_stt_provider = system_stt;
    let has_system_stt = if let Some(ref mut provider) = system_stt_provider {
        match provider.start_stream(sys_stt_tx).await {
            Ok(()) => {
                log::info!("System audio STT started (remote party transcription)");
                true
            }
            Err(e) => {
                log::warn!("Failed to start system STT: {}", e);
                system_stt_provider = None;
                false
            }
        }
    } else {
        false
    };

    // Emit transcript events from system audio STT (speaker = "Them")
    // Uses the SegmentAccumulator to merge consecutive segments within a
    // configurable pause threshold, producing longer, more readable lines.
    if has_system_stt {
        let stt_app = app.clone();
        let intel_arc = app.state::<AppState>().intelligence.clone();
        let pause_threshold = app.state::<AppState>().pause_threshold_ms.clone();
        tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            let threshold = pause_threshold.load(Ordering::Relaxed);
            let mut accumulator =
                crate::stt::segment_accumulator::SegmentAccumulator::new(threshold);

            while let Some(result) = sys_stt_rx.recv().await {
                // Check for runtime threshold changes
                let current_threshold = pause_threshold.load(Ordering::Relaxed);
                accumulator.set_pause_threshold(current_threshold);

                let outputs = accumulator.feed_result(result);
                for output in outputs {
                    let event_name = if output.is_final {
                        "transcript_final"
                    } else {
                        "transcript_update"
                    };
                    let payload = serde_json::json!({
                        "segment": {
                            "id": output.id,
                            "text": output.text,
                            "speaker": output.speaker,
                            "timestamp_ms": output.timestamp_ms,
                            "is_final": output.is_final,
                            "confidence": output.confidence
                        }
                    });
                    let _ = stt_app.emit(event_name, &payload);

                    // Push final segments to the intelligence engine's
                    // transcript buffer so the AI has access to what "Them" said.
                    if output.is_final {
                        if let Some(ref intel) = intel_arc {
                            if let Ok(mut engine) = intel.lock() {
                                engine.push_transcript(
                                    output.text.clone(),
                                    "Them".to_string(),
                                    output.timestamp_ms,
                                    true,
                                );
                            }
                        }
                    }
                }
            }
        });
    }

    // Grab the recorder handle for WAV recording (with mic/system mixing)
    let recorder = {
        let guard = state.audio.lock().map_err(|_| "lock poisoned".to_string())?;
        guard.as_ref().and_then(|mgr| mgr.get_recorder())
    };

    // Audio processing task: levels + recording + system STT feed
    // (Mic STT is handled by Web Speech API in the frontend)
    let app_handle = app.clone();
    tokio::spawn(async move {
        let mut vad = VoiceActivityDetector::new();
        let mut mic_emit_counter: u32 = 0;
        let mut system_emit_counter: u32 = 0;
        // Mix buffers for proper two-source recording
        let mut mix_mic: Vec<i16> = Vec::new();
        let mut mix_sys: Vec<i16> = Vec::new();

        while let Some(mut chunk) = rx.recv().await {
            let vad_result = vad.process_chunk(&chunk.pcm_data);
            chunk.is_speech = vad_result.is_speech;

            // Emit audio levels — separate counters per source for independent update rates
            let should_emit = match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_emit_counter += 1;
                    mic_emit_counter % 3 == 0
                }
                AudioSource::System => {
                    system_emit_counter += 1;
                    system_emit_counter % 3 == 0
                }
            };
            if should_emit {
                let rms = calculate_rms(&chunk.pcm_data);
                let peak = calculate_peak(&chunk.pcm_data);
                let level = AudioLevel {
                    source: chunk.source.clone(),
                    level: (rms / 3000.0).min(1.0),
                    peak,
                };
                let _ = app_handle.emit("audio_level", &level);
            }

            // Recording with mic/system mixing
            if let Some(ref rec) = recorder {
                match chunk.source {
                    AudioSource::Mic => mix_mic.extend_from_slice(&chunk.pcm_data),
                    AudioSource::System => mix_sys.extend_from_slice(&chunk.pcm_data),
                    AudioSource::Room => rec.write_samples(&chunk.pcm_data),
                }
                // Mix when both buffers have data
                let mix_len = mix_mic.len().min(mix_sys.len());
                if mix_len > 0 {
                    let mixed: Vec<i16> = mix_mic[..mix_len].iter()
                        .zip(&mix_sys[..mix_len])
                        .map(|(&m, &s)| ((m as i32 + s as i32) * 4).clamp(-32768, 32767) as i16)
                        .collect();
                    rec.write_samples(&mixed);
                    mix_mic.drain(..mix_len);
                    mix_sys.drain(..mix_len);
                }
                // Solo flush if one source has >2s buffered with nothing from the other
                if mix_mic.len() > 32000 && mix_sys.is_empty() {
                    rec.write_samples(&mix_mic);
                    mix_mic.clear();
                } else if mix_sys.len() > 32000 && mix_mic.is_empty() {
                    rec.write_samples(&mix_sys);
                    mix_sys.clear();
                }
            }

            // Feed ONLY system audio to the cloud STT provider
            if chunk.source == AudioSource::System {
                if let Some(ref mut provider) = system_stt_provider {
                    let _ = provider.feed_audio(chunk).await;
                }
            }
        }

        // Flush remaining mix buffers on loop exit
        if let Some(ref rec) = recorder {
            let mix_len = mix_mic.len().min(mix_sys.len());
            if mix_len > 0 {
                let mixed: Vec<i16> = mix_mic[..mix_len].iter()
                    .zip(&mix_sys[..mix_len])
                    .map(|(&m, &s)| ((m as i32 + s as i32) * 4).clamp(-32768, 32767) as i16)
                    .collect();
                rec.write_samples(&mixed);
                mix_mic.drain(..mix_len);
                mix_sys.drain(..mix_len);
            }
            if !mix_mic.is_empty() { rec.write_samples(&mix_mic); }
            if !mix_sys.is_empty() { rec.write_samples(&mix_sys); }
        }

        // Clean shutdown
        if let Some(ref mut provider) = system_stt_provider {
            let _ = provider.stop_stream().await;
        }
        log::info!("Audio processing task exiting");
    });

    log::info!("Audio capture started via command");
    Ok(())
}

/// Stop all audio capture.
#[command]
pub async fn stop_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Restore original default capture device if IPolicyConfig override was active
    restore_default_device_if_overridden(&state, &app);

    let recording_info = {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;

        match guard.as_mut() {
            Some(mgr) => {
                let info = mgr.stop_capture();
                log::info!("Audio capture stopped via command");
                info
            }
            None => return Err("No audio manager initialized".to_string()),
        }
    };

    // Store recording info for end_meeting to pick up.
    // The frontend calls stopCapture() then endMeeting() in sequence, so
    // we park the info here and end_meeting consumes it.
    if let Some((wav_path, start_time_ms)) = recording_info {
        let mut pending = state
            .pending_recording
            .lock()
            .map_err(|_| "Pending recording lock poisoned".to_string())?;
        *pending = Some(crate::state::PendingRecording {
            wav_path,
            start_time_ms,
        });
        log::info!("Recording info stored for post-meeting pipeline");
    }

    Ok(())
}

/// Get current audio levels for UI meters.
#[command]
pub async fn get_audio_level(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_ref() {
        Some(mgr) => {
            let (mic_level, _system_level) = mgr.get_audio_levels();
            serde_json::to_string(&mic_level)
                .map_err(|e| format!("Failed to serialize audio level: {}", e))
        }
        None => Ok(r#"{"source":"Mic","level":0.0,"peak":0.0}"#.to_string()),
    }
}

/// Start a real audio test on a device — opens a capture stream and emits
/// audio_level events so the frontend level meter shows live data.
/// For input (mic): opens cpal input stream.
/// For output (system): starts WASAPI loopback capture.
#[command]
pub async fn start_audio_test(
    app: AppHandle,
    device_id: String,
    is_input: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Start test capture and get the audio chunk receiver
    let (mut rx, detected_flag) = {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        let rx = mgr.start_test(&device_id, is_input)?;
        let detected = Arc::clone(&mgr.test_audio_detected);
        (rx, detected)
    };

    // Spawn a tokio task that reads audio chunks from the test stream
    // and emits audio_level events to the frontend for the level meter.
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let rms = calculate_rms(&chunk.pcm_data);
            let peak = calculate_peak(&chunk.pcm_data);

            // Mark audio as detected if we get any meaningful signal
            if rms > 100.0 {
                detected_flag.store(true, Ordering::SeqCst);
            }

            let level = AudioLevel {
                source: if is_input {
                    AudioSource::Mic
                } else {
                    AudioSource::System
                },
                level: (rms / 3000.0).min(1.0),
                peak,
            };
            let _ = app_clone.emit("audio_level", &level);
        }
        log::info!("Audio test processing task exiting");
    });

    Ok(())
}

/// Stop an active audio test and return whether audio was detected.
#[command]
pub async fn stop_audio_test(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_mut() {
        Some(mgr) => Ok(mgr.stop_test()),
        None => Ok(false),
    }
}

/// Test whether a specific audio device can be opened (legacy quick check).
#[command]
pub async fn test_audio_device(device_id: String) -> Result<bool, String> {
    device_manager::test_device(&device_id)
}

/// Enable or disable audio recording to file.
#[command]
pub async fn set_recording_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_mut() {
        Some(mgr) => {
            mgr.set_recording_enabled(enabled);
            Ok(())
        }
        None => {
            log::info!(
                "Recording {} (will take effect when capture starts)",
                if enabled { "enabled" } else { "disabled" }
            );
            Ok(())
        }
    }
}

/// Peak level entry returned by get_audio_peak_levels.
#[derive(serde::Serialize, Clone)]
pub struct DevicePeakLevel {
    pub device_id: String,
    pub level: f32,
}

/// Return the current peak audio level (0.0–1.0) for every active audio
/// endpoint simultaneously, without opening any capture streams.
///
/// Uses Win32 IAudioMeterInformation — the same mechanism Windows uses in
/// Sound Control Panel. Works for both input (mic) and output (speaker/loopback)
/// devices. All devices are read in one synchronous pass (~1–3 ms).
#[command]
pub async fn get_audio_peak_levels() -> Result<Vec<DevicePeakLevel>, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(get_all_peak_levels_win)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![])
    }
}

#[cfg(target_os = "windows")]
fn get_all_peak_levels_win() -> Result<Vec<DevicePeakLevel>, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        // S_FALSE (0x1) means already initialized on this thread — that's fine
        if hr.is_err() && hr.0 != 1 {
            return Err(format!("COM init failed: {:?}", hr));
        }
        let results = read_all_peaks_raw();
        CoUninitialize();
        Ok(results)
    }
}

/// Read peak levels for all active audio endpoints.
/// Caller must have already called CoInitializeEx on this thread.
#[cfg(target_os = "windows")]
fn read_all_peaks_raw() -> Vec<DevicePeakLevel> {
    use windows::Win32::Media::Audio::{
        Endpoints::IAudioMeterInformation,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return vec![],
            };
        // EDataFlow::eAll = 2 — enumerate both render and capture endpoints
        let e_all = windows::Win32::Media::Audio::EDataFlow(2);
        let collection = match enumerator.EnumAudioEndpoints(e_all, DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        let count = collection.GetCount().unwrap_or(0);
        let mut results = Vec::with_capacity(count as usize);
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            // Use the friendly name as device_id so it matches cpal's name-based IDs
            // used by the frontend device list (device_manager::enumerate_devices).
            let name = match get_device_friendly_name(&device) {
                Some(n) => n,
                None => continue,
            };
            let meter: IAudioMeterInformation = match device.Activate(CLSCTX_ALL, None) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let peak = meter.GetPeakValue().unwrap_or(0.0);
            results.push(DevicePeakLevel { device_id: name, level: peak });
        }
        results
    }
}

/// Extract the friendly name from a Windows audio endpoint device,
/// matching the format that cpal uses for device names.
#[cfg(target_os = "windows")]
fn get_device_friendly_name(device: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
    use windows::core::GUID;
    unsafe {
        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
        let pkey = PROPERTYKEY {
            fmtid: GUID::from_values(
                0xa45c254e,
                0xdf1c,
                0x4efd,
                [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
            ),
            pid: 14,
        };
        let store = device.OpenPropertyStore(windows::Win32::System::Com::STGM(0)).ok()?;
        let prop = store.GetValue(&pkey).ok()?;
        let s = format!("{}", prop);
        if s.is_empty() || s == "VT_EMPTY" {
            return None;
        }
        Some(s)
    }
}

/// Holds a WASAPI capture client opened on an input endpoint.
/// Keeping this alive activates the audio engine's peak metering for the device.
/// Without an active capture client, IAudioMeterInformation returns 0 for input devices.
#[cfg(target_os = "windows")]
struct InputPeakActivator {
    client: windows::Win32::Media::Audio::IAudioClient,
    capture: windows::Win32::Media::Audio::IAudioCaptureClient,
}

#[cfg(target_os = "windows")]
impl InputPeakActivator {
    /// Drain any accumulated capture buffers so they don't overflow.
    unsafe fn drain(&self) {
        loop {
            let size = self.capture.GetNextPacketSize().unwrap_or(0);
            if size == 0 {
                break;
            }
            let mut buf = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            if self.capture
                .GetBuffer(&mut buf, &mut frames, &mut flags, None, None)
                .is_ok()
            {
                let _ = self.capture.ReleaseBuffer(frames);
            } else {
                break;
            }
        }
    }
}

/// Open shared-mode WASAPI capture streams on all active input endpoints.
/// This activates the audio engine's peak metering for capture devices.
#[cfg(target_os = "windows")]
fn activate_input_peak_meters() -> Vec<InputPeakActivator> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    let mut activators = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return vec![],
            };

        // eCapture = 1 — only input endpoints
        let collection = match enumerator.EnumAudioEndpoints(EDataFlow(1), DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let count = collection.GetCount().unwrap_or(0);
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let format_ptr = match client.GetMixFormat() {
                Ok(f) => f,
                Err(_) => continue,
            };

            // Initialize shared-mode with 200ms buffer
            let init_ok = client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    0,
                    2_000_000, // 200ms in 100-nanosecond units
                    0,
                    format_ptr,
                    None,
                )
                .is_ok();
            CoTaskMemFree(Some(format_ptr as *const _));
            if !init_ok {
                continue;
            }

            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if client.Start().is_err() {
                continue;
            }
            activators.push(InputPeakActivator { client, capture });
        }
    }
    log::info!(
        "Device monitor: activated peak metering on {} input endpoints",
        activators.len()
    );
    activators
}

/// Dedicated monitor thread: initializes COM once, reads all peak levels at ~60 fps,
/// and emits a `device_levels` Tauri event after each read.
/// Opens capture streams on input devices to activate their peak meters.
/// Exits when `stop` flips to false.
#[cfg(target_os = "windows")]
fn run_device_monitor_loop(app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 1 {
            return;
        }

        // Open capture streams on input devices to enable peak metering
        let input_activators = activate_input_peak_meters();

        while stop.load(Ordering::SeqCst) {
            // Drain capture buffers to prevent overflow
            for a in &input_activators {
                a.drain();
            }

            let levels = read_all_peaks_raw();
            if !levels.is_empty() {
                let _ = app.emit("device_levels", &levels);
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }

        // Clean up capture streams
        for a in &input_activators {
            let _ = a.client.Stop();
        }

        CoUninitialize();
    }
}

/// Start the Live Monitor background thread.
/// Idempotent — stops any running monitor first, waits for it to exit, then starts fresh.
#[command]
pub async fn start_device_monitor(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<crate::state::AppState>();

        // Signal any existing thread to stop
        state.device_monitor_running.store(false, Ordering::SeqCst);
        // Wait long enough for the old thread to see the flag (loop sleeps 16ms)
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        // Start fresh
        state.device_monitor_running.store(true, Ordering::SeqCst);
        let stop_flag = Arc::clone(&state.device_monitor_running);
        let app_clone = app.clone();
        std::thread::spawn(move || {
            run_device_monitor_loop(app_clone, stop_flag);
            // Don't reset the flag here — only start/stop commands manage it.
            // This prevents a race where an exiting thread resets the flag
            // after a new thread has already been started.
        });
    }
    Ok(())
}

/// Stop the Live Monitor background thread.
#[command]
pub async fn stop_device_monitor(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<crate::state::AppState>();
        state.device_monitor_running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

/// Enumerate active audio sessions (per-app audio awareness).
/// Returns JSON array of AudioSessionInfo.
#[command]
pub async fn get_audio_sessions() -> Result<String, String> {
    let sessions = session_monitor::enumerate_audio_sessions()?;
    serde_json::to_string(&sessions)
        .map_err(|e| format!("Failed to serialize audio sessions: {}", e))
}

/// Start per-party audio capture with independent STT pipelines.
///
/// Each party (You / Them) independently selects:
///   - An audio device (mic or output/loopback)
///   - An STT provider (web_speech, windows_native, deepgram, etc.)
///
/// If STT = "web_speech", Rust skips STT for that party (frontend handles it).
/// Audio is still captured for levels, recording, and (optionally) the other party's STT.
#[command]
pub async fn start_capture_per_party(
    app: AppHandle,
    you_config: String,
    them_config: String,
) -> Result<(), String> {
    use crate::audio::PartyAudioConfig;

    let you: PartyAudioConfig =
        serde_json::from_str(&you_config).map_err(|e| format!("Invalid you_config: {}", e))?;
    let them: PartyAudioConfig =
        serde_json::from_str(&them_config).map_err(|e| format!("Invalid them_config: {}", e))?;

    let state = app.state::<AppState>();

    // If already capturing, stop first (allows mid-meeting hot-swap)
    {
        // Restore any previous IPolicyConfig override before hot-swap
        restore_default_device_if_overridden(&state, &app);

        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        if let Some(ref mut mgr) = *guard {
            if mgr.is_capturing() {
                log::info!("start_capture_per_party: stopping existing capture for hot-swap");
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    "Hot-swap: stopping existing audio capture + STT providers");
                mgr.stop_capture();
            }
        }
    }

    log::info!(
        "Starting per-party capture: You={{device='{}', input={}, stt={}}}, Them={{device='{}', input={}, stt={}}}",
        you.device_id,
        you.is_input_device,
        you.stt_provider,
        them.device_id,
        them.is_input_device,
        them.stt_provider
    );

    // Create the audio chunk channel
    let (tx, mut rx) = mpsc::channel::<crate::audio::AudioChunk>(256);

    // Use the existing AudioCaptureManager for the physical capture
    // Map "You" → mic device, "Them" → system device (backward compat with existing manager)
    let mic_device = if you.is_input_device {
        you.device_id.clone()
    } else {
        "default".to_string()
    };
    // Always use the user's selected device for "Them" — the AudioCaptureManager
    // will choose the right capture method (loopback vs input) based on system_is_input.
    let system_device = them.device_id.clone();
    let system_is_input = them.is_input_device;

    // ── IPolicyConfig: override system default mic BEFORE starting capture ──
    // Web Speech and Windows Speech always use the OS default recording device.
    // The override must happen before capture starts so that Web Speech API
    // picks up the correct device when recognition.start() is called.
    {
        let needs_override = |config: &crate::audio::PartyAudioConfig, role: &str| -> bool {
            let provider = config.stt_provider.as_str();
            let is_web_or_win = provider == "web_speech" || provider == "windows_native";
            let result = is_web_or_win && config.is_input_device && config.device_id != "default";
            log::info!(
                "IPolicyConfig check [{}]: provider='{}', is_input={}, device_id='{}', needs_override={}",
                role, provider, config.is_input_device, config.device_id, result
            );
            result
        };

        if needs_override(&you, "You") || needs_override(&them, "Them") {
            // Pick the device that needs the override (prefer "You" if both need it)
            let target_device = if needs_override(&you, "You") {
                &you.device_id
            } else {
                &them.device_id
            };

            crate::stt::emit_stt_debug(&app, "info", "audio",
                &format!("IPolicyConfig: overriding default capture → '{}'", target_device));

            match crate::audio::device_default::override_default_capture_device(target_device) {
                Ok(Some(original)) => {
                    // Store original so we can restore it on stop
                    if let Ok(mut guard) = state.original_default_device.lock() {
                        *guard = Some(original.clone());
                    }
                    // Also store the resolved target endpoint for ensure_ipolicy_override
                    match crate::audio::device_default::find_capture_endpoint_id_by_name(target_device) {
                        Ok(target_ep) => {
                            if let Ok(mut guard) = state.ipolicy_target_endpoint.lock() {
                                *guard = Some(target_ep.clone());
                            }
                            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                                &format!("IPolicyConfig: stored target endpoint '{}'", target_ep));
                        }
                        Err(e) => {
                            crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                                &format!("IPolicyConfig: could not resolve target endpoint: {}", e));
                        }
                    }
                    crate::stt::emit_stt_debug(&app, "info", "audio",
                        &format!("IPolicyConfig: saved original default '{}', override active", original));

                    // Verify the override took effect by reading back the current default
                    match crate::audio::device_default::get_default_capture_endpoint_id() {
                        Ok(current) => {
                            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                                &format!("Current default after override: '{}'", current));
                        }
                        Err(e) => {
                            crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                                &format!("Could not verify override: {}", e));
                        }
                    }
                }
                Ok(None) => {
                    // Target was already the default — no override applied
                    crate::stt::emit_stt_debug(&app, "info", "audio",
                        "IPolicyConfig: selected device is already the default — no override needed");
                    // Still store the target endpoint — it IS the current default
                    match crate::audio::device_default::get_default_capture_endpoint_id() {
                        Ok(ep) => {
                            if let Ok(mut guard) = state.ipolicy_target_endpoint.lock() {
                                *guard = Some(ep);
                            }
                        }
                        Err(_) => {}
                    }
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(&app, "warn", "audio",
                        &format!("IPolicyConfig: override failed ({}). STT will use OS default mic.", e));
                }
            }
        } else {
            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                "IPolicyConfig: no override needed (neither party uses web_speech/windows_native with non-default input)");
        }

        // Emit IPolicyConfig status event for frontend synchronization
        let override_applied = needs_override(&you, "You") || needs_override(&them, "Them");
        let _ = app.emit("ipolicy_status", serde_json::json!({
            "applied": override_applied,
            "target_device": if needs_override(&you, "You") { &you.device_id } else { &them.device_id },
        }));
    }

    {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        log::info!(
            "AudioCaptureManager::start_capture mic='{}', system='{}'",
            mic_device, system_device
        );
        mgr.start_capture(&mic_device, &system_device, system_is_input, tx)?;
    }

    // ── Create STT provider for "You" party (if not web_speech) ──
    let you_stt = create_stt_provider_for_party(&you, &state, &app, "You").await?;

    // ── Create STT provider for "Them" party (if not web_speech) ──
    let them_stt = create_stt_provider_for_party(&them, &state, &app, "Them").await?;

    // Start STT streams
    let (you_stt_tx, mut you_stt_rx) =
        mpsc::channel::<crate::stt::provider::TranscriptResult>(256);
    let (them_stt_tx, mut them_stt_rx) =
        mpsc::channel::<crate::stt::provider::TranscriptResult>(256);

    let mut you_stt_provider = you_stt;
    let mut them_stt_provider = them_stt;

    if let Some(ref mut provider) = you_stt_provider {
        crate::stt::emit_stt_debug(&app, "info", "stt",
            &format!("Starting 'You' STT ({})", you.stt_provider));
        match provider.start_stream(you_stt_tx).await {
            Ok(()) => {
                log::info!("'You' party STT started ({})", you.stt_provider);
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    &format!("'You' STT started: {}", you.stt_provider));
            }
            Err(e) => {
                log::warn!("Failed to start 'You' STT: {}", e);
                crate::stt::emit_stt_debug(&app, "error", "stt",
                    &format!("'You' STT failed to start: {}", e));
                let _ = app.emit("stt_connection_status", serde_json::json!({
                    "provider": you.stt_provider,
                    "party": "You",
                    "status": "error",
                    "message": format!("Failed to start STT: {}", e)
                }));
                you_stt_provider = None;
            }
        }
    }

    if let Some(ref mut provider) = them_stt_provider {
        crate::stt::emit_stt_debug(&app, "info", "stt",
            &format!("Starting 'Them' STT ({})", them.stt_provider));
        match provider.start_stream(them_stt_tx).await {
            Ok(()) => {
                log::info!("'Them' party STT started ({})", them.stt_provider);
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    &format!("'Them' STT started: {}", them.stt_provider));
            }
            Err(e) => {
                log::warn!("Failed to start 'Them' STT: {}", e);
                crate::stt::emit_stt_debug(&app, "error", "stt",
                    &format!("'Them' STT failed to start: {}", e));
                let _ = app.emit("stt_connection_status", serde_json::json!({
                    "provider": them.stt_provider,
                    "party": "Them",
                    "status": "error",
                    "message": format!("Failed to start STT: {}", e)
                }));
                them_stt_provider = None;
            }
        }
    }

    // Unique session prefix to avoid segment ID collisions across mid-meeting restarts.
    // Each restart of start_capture_per_party gets a distinct prefix, so segment IDs
    // like "you_a3_1" won't collide with "you_b7_1" from a previous session.
    let session_prefix = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() % 0xFFFF);

    // Emit transcript events from "You" STT (speaker = "User")
    // Uses SegmentAccumulator for cloud providers (Deepgram, Groq, etc.)
    // Skips accumulator for web_speech (browser handles segmentation)
    // and whisper_cpp (dual-pass engine manages its own line breaking).
    if you_stt_provider.is_some() {
        let stt_app = app.clone();
        let prefix = session_prefix.clone();
        let use_accumulator = you.stt_provider != "web_speech"
            && you.stt_provider != "whisper_cpp";
        let pause_threshold = if use_accumulator {
            Some(app.state::<AppState>().pause_threshold_ms.clone())
        } else {
            None
        };
        tokio::spawn(async move {
            if let Some(pause_threshold) = pause_threshold {
                // Accumulator path: merge same-speaker segments
                use std::sync::atomic::Ordering;
                let threshold = pause_threshold.load(Ordering::Relaxed);
                let mut accumulator =
                    crate::stt::segment_accumulator::SegmentAccumulator::new(threshold);

                while let Some(result) = you_stt_rx.recv().await {
                    let current_threshold = pause_threshold.load(Ordering::Relaxed);
                    accumulator.set_pause_threshold(current_threshold);

                    let outputs = accumulator.feed_result(result);
                    for output in outputs {
                        let event_name = if output.is_final {
                            "transcript_final"
                        } else {
                            "transcript_update"
                        };
                        let seg_id = format!("you_{}_{}", prefix, output.id);
                        let payload = serde_json::json!({
                            "segment": {
                                "id": seg_id,
                                "text": output.text,
                                "speaker": "User",
                                "timestamp_ms": output.timestamp_ms,
                                "is_final": output.is_final,
                                "confidence": output.confidence
                            }
                        });
                        let _ = stt_app.emit(event_name, &payload);
                    }
                }

                // Flush remaining accumulated segment on meeting end
                if let Some(output) = accumulator.flush() {
                    let seg_id = format!("you_{}_{}", prefix, output.id);
                    let payload = serde_json::json!({
                        "segment": {
                            "id": seg_id,
                            "text": output.text,
                            "speaker": "User",
                            "timestamp_ms": output.timestamp_ms,
                            "is_final": true,
                            "confidence": output.confidence
                        }
                    });
                    let _ = stt_app.emit("transcript_final", &payload);
                }
            } else {
                // Direct path: web_speech / whisper_cpp handle their own segmentation
                let mut counter = 0u64;
                while let Some(result) = you_stt_rx.recv().await {
                    let seg_id = if let Some(ref custom_id) = result.segment_id {
                        format!("you_{}_{}", prefix, custom_id)
                    } else {
                        if result.is_final {
                            counter += 1;
                        }
                        if result.is_final {
                            format!("you_{}_{}", prefix, counter)
                        } else {
                            format!("you_{}_{}", prefix, counter + 1)
                        }
                    };
                    let event_name = if result.is_final {
                        "transcript_final"
                    } else {
                        "transcript_update"
                    };
                    let payload = serde_json::json!({
                        "segment": {
                            "id": seg_id,
                            "text": result.text,
                            "speaker": "User",
                            "timestamp_ms": result.timestamp_ms,
                            "is_final": result.is_final,
                            "confidence": result.confidence
                        }
                    });
                    let _ = stt_app.emit(event_name, &payload);
                }
            }
        });
    }

    // Emit transcript events from "Them" STT (speaker = "Them")
    // Uses SegmentAccumulator to merge consecutive same-speaker segments
    // within the configurable pause threshold, producing longer lines.
    if them_stt_provider.is_some() {
        let stt_app = app.clone();
        let prefix = session_prefix.clone();
        let intel_arc = app.state::<AppState>().intelligence.clone();
        let pause_threshold = app.state::<AppState>().pause_threshold_ms.clone();
        tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            let threshold = pause_threshold.load(Ordering::Relaxed);
            let mut accumulator =
                crate::stt::segment_accumulator::SegmentAccumulator::new(threshold);

            while let Some(result) = them_stt_rx.recv().await {
                // Live-update threshold from settings changes
                let current_threshold = pause_threshold.load(Ordering::Relaxed);
                accumulator.set_pause_threshold(current_threshold);

                let outputs = accumulator.feed_result(result);
                for output in outputs {
                    let event_name = if output.is_final {
                        "transcript_final"
                    } else {
                        "transcript_update"
                    };
                    // Namespace IDs to avoid collision with "You" accumulator
                    let seg_id = format!("them_{}_{}", prefix, output.id);
                    // Extract diarized speaker_id from accumulator output
                    let speaker_id_val = if output.speaker.starts_with("speaker_") {
                        Some(output.speaker.clone())
                    } else {
                        None
                    };
                    let mut seg = serde_json::json!({
                        "id": seg_id,
                        "text": output.text,
                        "speaker": "Them",
                        "timestamp_ms": output.timestamp_ms,
                        "is_final": output.is_final,
                        "confidence": output.confidence
                    });
                    if let Some(ref sid) = speaker_id_val {
                        seg["speaker_id"] = serde_json::json!(sid);
                    }
                    let payload = serde_json::json!({ "segment": seg });
                    let _ = stt_app.emit(event_name, &payload);

                    // Push final segments to the intelligence engine
                    if output.is_final {
                        if let Some(ref intel) = intel_arc {
                            if let Ok(mut engine) = intel.lock() {
                                engine.push_transcript(
                                    output.text.clone(),
                                    "Them".to_string(),
                                    output.timestamp_ms,
                                    true,
                                );
                            }
                        }
                    }
                }
            }

            // Flush remaining accumulated segment on meeting end
            if let Some(output) = accumulator.flush() {
                let seg_id = format!("them_{}_{}", prefix, output.id);
                let speaker_id_val = if output.speaker.starts_with("speaker_") {
                    Some(output.speaker.clone())
                } else {
                    None
                };
                let mut seg = serde_json::json!({
                    "id": seg_id,
                    "text": output.text,
                    "speaker": "Them",
                    "timestamp_ms": output.timestamp_ms,
                    "is_final": output.is_final,
                    "confidence": output.confidence
                });
                if let Some(ref sid) = speaker_id_val {
                    seg["speaker_id"] = serde_json::json!(sid);
                }
                let payload = serde_json::json!({ "segment": seg });
                let _ = stt_app.emit("transcript_final", &payload);

                if let Some(ref intel) = intel_arc {
                    if let Ok(mut engine) = intel.lock() {
                        engine.push_transcript(
                            output.text.clone(),
                            "Them".to_string(),
                            output.timestamp_ms,
                            true,
                        );
                    }
                }
            }
        });
    }

    // Grab the recorder handle for WAV recording (with mic/system mixing)
    let recorder = {
        let guard = state.audio.lock().map_err(|_| "lock poisoned".to_string())?;
        guard.as_ref().and_then(|mgr| mgr.get_recorder())
    };

    // Grab mute flags so the audio loop can check them lock-free
    let you_muted_flag = state.you_muted.clone();
    let them_muted_flag = state.them_muted.clone();

    // Audio processing task: levels + recording + STT feed per party
    let app_handle = app.clone();
    tokio::spawn(async move {
        // Separate VAD instances per audio source — sharing one VAD across
        // interleaved mic + system chunks corrupts smoothed_energy state.
        let mut mic_vad = VoiceActivityDetector::new();
        let mut sys_vad = VoiceActivityDetector::new();
        let mut mic_emit_ctr: u32 = 0;
        let mut sys_emit_ctr: u32 = 0;
        let mut mic_chunk_count: u64 = 0;
        let mut system_chunk_count: u64 = 0;

        // Time-based stats — emit only every 120s to reduce dev log noise
        let mut last_mic_stats = std::time::Instant::now();
        let mut last_sys_stats = std::time::Instant::now();
        let stats_interval = std::time::Duration::from_secs(120);

        // Mix buffers for proper two-source recording
        let mut mix_mic: Vec<i16> = Vec::new();
        let mut mix_sys: Vec<i16> = Vec::new();

        // Track feed_audio errors per provider (emit once, not every chunk)
        let mut you_feed_error_emitted = false;
        let mut them_feed_error_emitted = false;

        while let Some(mut chunk) = rx.recv().await {
            // Apply VAD from the correct per-source instance
            let vad_result = match chunk.source {
                AudioSource::Mic | AudioSource::Room => mic_vad.process_chunk(&chunk.pcm_data),
                AudioSource::System => sys_vad.process_chunk(&chunk.pcm_data),
            };
            chunk.is_speech = vad_result.is_speech;

            // Track chunk counts for diagnostics (time-based stats)
            match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_chunk_count += 1;
                    if mic_chunk_count == 1 {
                        let label = if chunk.source == AudioSource::Room { "room" } else { "mic" };
                        log::info!("First {} audio chunk received", label);
                        crate::stt::emit_stt_debug(&app_handle, "info", "audio",
                            &format!("First {} chunk received — audio pipeline active", label));
                    }
                    if last_mic_stats.elapsed() >= stats_interval {
                        let rms = calculate_rms(&chunk.pcm_data);
                        let label = if chunk.source == AudioSource::Room { "Room" } else { "Mic" };
                        crate::stt::emit_stt_debug_ex(&app_handle, "info", "audio",
                            &format!("{}: {} chunks, speech={}, rms={:.0}", label, mic_chunk_count, chunk.is_speech, rms),
                            Some("audio_mic_stats"));
                        last_mic_stats = std::time::Instant::now();
                    }
                }
                AudioSource::System => {
                    system_chunk_count += 1;
                    if system_chunk_count == 1 {
                        log::info!("First system audio chunk received — 'Them' capture is active");
                        crate::stt::emit_stt_debug(&app_handle, "info", "audio",
                            "First system chunk received — system audio capture active");
                    }
                    if last_sys_stats.elapsed() >= stats_interval {
                        let rms = calculate_rms(&chunk.pcm_data);
                        crate::stt::emit_stt_debug_ex(&app_handle, "info", "audio",
                            &format!("System: {} chunks, speech={}, rms={:.0}", system_chunk_count, chunk.is_speech, rms),
                            Some("audio_sys_stats"));
                        last_sys_stats = std::time::Instant::now();
                    }
                }
            }

            // Emit audio levels — separate counters per source for independent update rates
            let should_emit = match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_emit_ctr += 1;
                    mic_emit_ctr % 3 == 0
                }
                AudioSource::System => {
                    sys_emit_ctr += 1;
                    sys_emit_ctr % 3 == 0
                }
            };
            if should_emit {
                let rms = calculate_rms(&chunk.pcm_data);
                let peak = calculate_peak(&chunk.pcm_data);
                let level = AudioLevel {
                    source: chunk.source.clone(),
                    level: (rms / 3000.0).min(1.0),
                    peak,
                };
                let _ = app_handle.emit("audio_level", &level);
            }

            // Recording with mic/system mixing
            if let Some(ref rec) = recorder {
                match chunk.source {
                    AudioSource::Mic => mix_mic.extend_from_slice(&chunk.pcm_data),
                    AudioSource::System => mix_sys.extend_from_slice(&chunk.pcm_data),
                    AudioSource::Room => rec.write_samples(&chunk.pcm_data),
                }
                let mix_len = mix_mic.len().min(mix_sys.len());
                if mix_len > 0 {
                    let mixed: Vec<i16> = mix_mic[..mix_len].iter()
                        .zip(&mix_sys[..mix_len])
                        .map(|(&m, &s)| ((m as i32 + s as i32) * 4).clamp(-32768, 32767) as i16)
                        .collect();
                    rec.write_samples(&mixed);
                    mix_mic.drain(..mix_len);
                    mix_sys.drain(..mix_len);
                }
                if mix_mic.len() > 32000 && mix_sys.is_empty() {
                    rec.write_samples(&mix_mic);
                    mix_mic.clear();
                } else if mix_sys.len() > 32000 && mix_mic.is_empty() {
                    rec.write_samples(&mix_sys);
                    mix_sys.clear();
                }
            }

            // Route to the correct party's STT provider (surface errors once).
            // Mute gate: when a party is muted, skip feed_audio entirely —
            // audio levels + recording still flow, only STT is silenced.
            match chunk.source {
                AudioSource::Mic => {
                    if !you_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = you_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !you_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'You' feed_audio error: {}", e));
                                    you_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
                AudioSource::System => {
                    if !them_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = them_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !them_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'Them' feed_audio error: {}", e));
                                    them_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
                AudioSource::Room => {
                    // In-person mode: room audio routes to the "Them" provider
                    // (which handles diarization). Use the same mute gate.
                    if !them_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = them_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !them_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'Room' feed_audio error: {}", e));
                                    them_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Flush remaining mix buffers
        if let Some(ref rec) = recorder {
            let mix_len = mix_mic.len().min(mix_sys.len());
            if mix_len > 0 {
                let mixed: Vec<i16> = mix_mic[..mix_len].iter()
                    .zip(&mix_sys[..mix_len])
                    .map(|(&m, &s)| ((m as i32 + s as i32) * 4).clamp(-32768, 32767) as i16)
                    .collect();
                rec.write_samples(&mixed);
                mix_mic.drain(..mix_len);
                mix_sys.drain(..mix_len);
            }
            if !mix_mic.is_empty() { rec.write_samples(&mix_mic); }
            if !mix_sys.is_empty() { rec.write_samples(&mix_sys); }
        }

        // Clean shutdown
        if let Some(ref mut provider) = you_stt_provider {
            let _ = provider.stop_stream().await;
        }
        if let Some(ref mut provider) = them_stt_provider {
            let _ = provider.stop_stream().await;
        }

        // Restore IPolicyConfig override if active (crash recovery for async task exit)
        {
            let original = app_handle
                .try_state::<AppState>()
                .and_then(|s| s.original_default_device.lock().ok()?.take());
            if let Some(ref original_id) = original {
                let _ = crate::audio::device_default::restore_default_capture_device(original_id);
                log::info!("IPolicyConfig: restored default device on audio task exit");
            }
        }

        log::info!("Per-party audio processing task exiting");
    });

    log::info!("Per-party audio capture started");
    Ok(())
}

/// Create an STT provider for a party based on their config.
/// Returns None if the party uses web_speech (frontend-only).
///
/// API keys are read directly from the credential store (not the STTRouter)
/// because per-party mode never calls set_stt_provider(), so the router's
/// cached keys are always None.
async fn create_stt_provider_for_party(
    config: &crate::audio::PartyAudioConfig,
    state: &AppState,
    app: &AppHandle,
    party_role: &str,
) -> Result<Option<Box<dyn STTProvider>>, String> {
    use crate::stt::provider::STTProviderType;

    let stt_type = STTProviderType::from_str(&config.stt_provider)
        .ok_or_else(|| format!("Unknown STT provider: {}", config.stt_provider))?;
    let stt_language = get_stt_language(state);

    crate::stt::emit_stt_debug(app, "info", "stt",
        &format!("[{}] Creating provider: {} (lang: {}, model: {})",
            party_role, config.stt_provider,
            stt_language,
            config.local_model_id.as_deref().unwrap_or("n/a")));

    match stt_type {
        STTProviderType::WebSpeech => Ok(None), // Frontend handles this
        STTProviderType::WhisperCpp => {
            let model_id = config.local_model_id.as_deref().unwrap_or("base");
            let model_result = get_local_model_path(state, "whisper_cpp", model_id)
                .or_else(|_| find_any_downloaded_model(state, "whisper_cpp"));
            match model_result {
                Ok(model_path) => {
                    let lang = get_stt_language(state);
                    let whisper_config = state.whisper_config.clone();
                    let mut p = crate::stt::whisper_cpp::WhisperCppSTT::new(model_path, whisper_config);
                    p.set_language(&lang);
                    Ok(Some(Box::new(p)))
                }
                Err(e) => {
                    log::warn!(
                        "WhisperCpp: {} — no transcription for this party. \
                         Download the model in Settings.",
                        e
                    );
                    Ok(None)
                }
            }
        }
        STTProviderType::WindowsNative => {
            use crate::stt::windows_native::WindowsNativeSTT;
            let lang = get_stt_language(state);
            let mut provider = if config.is_input_device {
                // IPolicyConfig already overrides system default to the selected device,
                // so DirectMic mode correctly captures from non-default devices too
                WindowsNativeSTT::for_mic()
            } else {
                // System audio: feed PCM from pipeline
                WindowsNativeSTT::for_custom_stream()
            };
            provider.set_language(&lang);
            provider.set_app_handle(app.clone());
            provider.set_party(party_role);
            Ok(Some(Box::new(provider)))
        }
        STTProviderType::Deepgram => {
            let lang = get_stt_language(state);
            let key = get_credential_key(state, "deepgram");
            log::info!("Deepgram key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let dg_config = get_deepgram_config(state);
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::deepgram::DeepgramSTT::with_api_key(k),
                None => crate::stt::deepgram::DeepgramSTT::new(),
            };
            p.set_language(&lang);
            p.set_config(dg_config);
            p.set_app_handle(app.clone());
            p.set_party(party_role);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::WhisperApi => {
            let lang = get_stt_language(state);
            let key = get_credential_key(state, "whisper_api");
            log::info!("WhisperApi key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::whisper_api::WhisperApiSTT::with_api_key(k),
                None => crate::stt::whisper_api::WhisperApiSTT::new(),
            };
            p.set_language(&lang);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::AzureSpeech => {
            let lang = get_stt_language(state);
            let key = get_credential_key(state, "azure_speech");
            let region = get_credential_key(state, "azure_speech_region");
            log::info!("Azure key for '{}': {}, region: {}", party_role,
                if key.is_some() { "present" } else { "MISSING" },
                if region.is_some() { "present" } else { "MISSING" });
            let mut p = match (key.as_deref(), region.as_deref()) {
                (Some(k), Some(r)) => crate::stt::azure_speech::AzureSpeechSTT::with_config(k, r),
                _ => crate::stt::azure_speech::AzureSpeechSTT::new(),
            };
            p.set_language(&lang);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::GroqWhisper => {
            let lang = get_stt_language(state);
            let key = get_credential_key(state, "groq_whisper");
            log::info!("Groq key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::groq_whisper::GroqWhisperSTT::with_api_key(k),
                None => crate::stt::groq_whisper::GroqWhisperSTT::new(),
            };
            p.set_language(&lang);
            // Use shared config Arc — provider reads latest config on each API call,
            // so settings changes take effect immediately without restarting
            p.set_shared_config(state.shared_groq_config.clone());
            p.set_app_handle(app.clone());
            p.set_party(party_role);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::SherpaOnnx => {
            // Guard: ignore model_id from a different engine (e.g., parakeet model)
            let raw_model_id = config.local_model_id.as_deref();
            let model_id = match raw_model_id {
                Some(id) if id.contains("parakeet") || id.contains("nemo") => {
                    log::warn!("SherpaOnnx: ignoring cross-engine model_id '{}', using default", id);
                    "streaming-zipformer-en-20M"
                }
                Some(id) => id,
                None => "streaming-zipformer-en-20M",
            };
            let model_result = get_local_model_path(state, "sherpa_onnx", model_id);
            match model_result {
                Ok(model_dir) => {
                    let lang = get_stt_language(state);
                    // Check if this is a non-transducer model (SenseVoice, etc.)
                    // by trying offline discovery first.
                    let offline_files = crate::stt::local_engines::model_discovery::discover_offline_model_files(&model_dir);
                    if let Ok(offline) = offline_files {
                        // Non-transducer model → use offline sidecar (sherpa-onnx-offline.exe)
                        let binary = find_offline_binary_for_state(state);
                        match binary {
                            Some(binary_path) => {
                                crate::stt::emit_stt_debug(app, "info", "stt",
                                    &format!("[{}] SherpaOnnx offline model '{}' from {} (lang={})",
                                        party_role, model_id, model_dir.display(), lang));
                                // Detect model type from model_id
                                let model_type = if model_id.contains("sense-voice") {
                                    crate::stt::sherpa_offline::OfflineModelType::SenseVoice
                                } else {
                                    crate::stt::sherpa_offline::OfflineModelType::NemoCtc
                                };
                                let mut p = crate::stt::sherpa_offline::SherpaOfflineSTT::new(
                                    binary_path,
                                    offline.model,
                                    offline.tokens,
                                    model_type,
                                    STTProviderType::SherpaOnnx,
                                );
                                p.set_language(&lang);
                                p.set_app_handle(app.clone());
                                Ok(Some(Box::new(p)))
                            }
                            None => {
                                crate::stt::emit_stt_debug(app, "error", "stt",
                                    &format!("[{}] sherpa-onnx-offline.exe not found. Download Sherpa-ONNX binary in Settings.",
                                        party_role));
                                Ok(None)
                            }
                        }
                    } else {
                        // Transducer model → use in-process ORT engine
                        crate::stt::emit_stt_debug(app, "info", "stt",
                            &format!("[{}] SherpaOnnx loading model '{}' from {} (lang={})",
                                party_role, model_id, model_dir.display(), lang));
                        let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                        p.set_language(&lang);
                        p.set_app_handle(app.clone());
                        Ok(Some(Box::new(p)))
                    }
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] SherpaOnnx model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
        STTProviderType::OrtStreaming => {
            let model_id = config.local_model_id.as_deref().unwrap_or("zipformer-en-20M");
            let model_result = get_local_model_path(state, "ort_streaming", model_id);
            match model_result {
                Ok(model_dir) => {
                    let lang = get_stt_language(state);
                    crate::stt::emit_stt_debug(app, "info", "stt",
                        &format!("[{}] ORT loading model '{}' from {} (lang={})",
                            party_role, model_id, model_dir.display(), lang));
                    let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                    p.set_language(&lang);
                    p.set_app_handle(app.clone());
                    Ok(Some(Box::new(p)))
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] ORT model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
        STTProviderType::ParakeetTdt => {
            // Guard: ignore model_id from a different engine (e.g., sense-voice-small from sherpa_onnx)
            let raw_model_id = config.local_model_id.as_deref();
            let model_id = match raw_model_id {
                Some(id) if id.contains("parakeet") || id.contains("nemo") => id,
                Some(id) => {
                    log::warn!("ParakeetTdt: ignoring cross-engine model_id '{}', using default", id);
                    "parakeet-tdt-0.6b-v3-int8"
                }
                None => "parakeet-tdt-0.6b-v3-int8",
            };
            crate::stt::emit_stt_debug(app, "info", "stt",
                &format!("[{}] Parakeet TDT: looking for model '{}' (local_model_id={:?})",
                    party_role, model_id, config.local_model_id));
            let model_result = get_local_model_path(state, "parakeet_tdt", model_id)
                .or_else(|_| find_any_downloaded_model(state, "parakeet_tdt"));
            match model_result {
                Ok(model_dir) => {
                    let lang = get_stt_language(state);
                    // Auto-detect model type: transducer (encoder/decoder/joiner) vs CTC (model.onnx)
                    let transducer = crate::stt::local_engines::model_discovery::discover_model_files(&model_dir);
                    if transducer.is_ok() {
                        // Transducer model (e.g., 0.6B v3) → use in-process ORT streaming
                        crate::stt::emit_stt_debug(app, "info", "stt",
                            &format!("[{}] Parakeet transducer model from {} (lang={})",
                                party_role, model_dir.display(), lang));
                        let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                        p.set_language(&lang);
                        p.set_app_handle(app.clone());
                        Ok(Some(Box::new(p)))
                    } else {
                        // CTC model (e.g., 110M) → use offline sidecar
                        let offline_files = crate::stt::local_engines::model_discovery::discover_offline_model_files(&model_dir);
                        match offline_files {
                            Ok(offline) => {
                                let binary = find_offline_binary_for_state(state);
                                match binary {
                                    Some(binary_path) => {
                                        crate::stt::emit_stt_debug(app, "info", "stt",
                                            &format!("[{}] Parakeet CTC offline model from {} (lang={})",
                                                party_role, model_dir.display(), lang));
                                        let mut p = crate::stt::sherpa_offline::SherpaOfflineSTT::new(
                                            binary_path, offline.model, offline.tokens,
                                            crate::stt::sherpa_offline::OfflineModelType::NemoCtc,
                                            STTProviderType::ParakeetTdt,
                                        );
                                        p.set_language(&lang);
                                        p.set_app_handle(app.clone());
                                        Ok(Some(Box::new(p)))
                                    }
                                    None => {
                                        crate::stt::emit_stt_debug(app, "error", "stt",
                                            &format!("[{}] sherpa-onnx-offline.exe not found.", party_role));
                                        Ok(None)
                                    }
                                }
                            }
                            Err(e) => {
                                crate::stt::emit_stt_debug(app, "error", "stt",
                                    &format!("[{}] Parakeet model discovery failed: {}", party_role, e));
                                Ok(None)
                            }
                        }
                    }
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] Parakeet model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
    }
}

/// Find the sherpa-onnx-offline.exe binary from the ModelManager's models directory.
fn find_offline_binary_for_state(state: &AppState) -> Option<std::path::PathBuf> {
    let model_mgr = state.model_manager.as_ref()?;
    let mgr = model_mgr.lock().ok()?;
    crate::stt::sherpa_offline::find_offline_binary(mgr.models_dir())
}

/// Find any downloaded model for an engine (fallback when requested model isn't available).
fn find_any_downloaded_model(
    state: &AppState,
    engine: &str,
) -> Result<std::path::PathBuf, String> {
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;
    let mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;
    let engines = mgr.list_engines_with_status();
    for eng in &engines {
        if eng.engine == engine {
            for m in &eng.models {
                if m.is_downloaded {
                    if let Some(path) = mgr.get_model_path(engine, m.definition.model_id) {
                        log::info!(
                            "WhisperCpp: using fallback model '{}' (requested model unavailable)",
                            m.definition.model_id
                        );
                        return Ok(path);
                    }
                }
            }
        }
    }
    Err(format!("No {} models downloaded", engine))
}

/// Get the model path for a local STT engine from the ModelManager.
fn get_local_model_path(
    state: &AppState,
    engine: &str,
    model_id: &str,
) -> Result<std::path::PathBuf, String> {
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;
    let mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;
    mgr.get_model_path(engine, model_id)
        .ok_or_else(|| format!("Model {}:{} not downloaded", engine, model_id))
}

/// Get the current STT language from the router.
fn get_stt_language(state: &AppState) -> String {
    state
        .stt
        .as_ref()
        .and_then(|stt| stt.lock().ok().map(|r| r.language.clone()))
        .unwrap_or_else(|| "en-US".to_string())
}

/// Read an API key directly from the credential store (Windows Credential Manager).
/// This bypasses the STTRouter, which only has keys when set_stt_provider() was called.
/// Per-party mode never calls set_stt_provider(), so we read credentials directly.
fn get_credential_key(state: &AppState, provider: &str) -> Option<String> {
    state.credentials.as_ref()
        .and_then(|cred_arc| cred_arc.lock().ok())
        .and_then(|cred| cred.get_key(provider).ok().flatten())
}

/// Get the current Deepgram config from the STT router.
fn get_deepgram_config(state: &AppState) -> crate::stt::deepgram::DeepgramConfig {
    state
        .stt
        .as_ref()
        .and_then(|stt| stt.lock().ok().map(|r| r.deepgram_config.clone()))
        .unwrap_or_default()
}

// ── IPolicyConfig verification for Web Speech restart ───────────────

/// Verify the OS default capture device still matches the IPolicy target.
/// If Windows has reset the default (drift), re-apply the override.
/// Called by the frontend before each Web Speech restart.
/// Non-destructive: only reads original_default_device and ipolicy_target_endpoint.
#[command]
pub async fn ensure_ipolicy_override(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();

    // 1. Check if an override is active (peek, not take)
    let original = match state.original_default_device.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return Err("State lock poisoned".to_string()),
    };
    if original.is_none() {
        return serde_json::to_string(&serde_json::json!({
            "active": false,
            "was_drifted": false
        })).map_err(|e| e.to_string());
    }

    // 2. Get the target endpoint (peek, not take)
    let target = match state.ipolicy_target_endpoint.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return Err("State lock poisoned".to_string()),
    };
    let target = match target {
        Some(t) => t,
        None => {
            log::warn!("IPolicyConfig: override active but no target endpoint stored");
            return serde_json::to_string(&serde_json::json!({
                "active": true,
                "was_drifted": false,
                "current_device": ""
            })).map_err(|e| e.to_string());
        }
    };

    // 3. Read current OS default (handles COM init internally)
    log::info!("IPolicyConfig: verifying default capture device...");

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

        let result = unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let we_initialized = hr.0 == 0;
            if hr.is_err() && hr.0 as u32 != 0x80010106 {
                return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
            }

            let res = (|| -> Result<String, String> {
                let current = crate::audio::device_default::get_default_capture_endpoint_id()?;
                log::debug!("IPolicyConfig verify: current='{}', target='{}'", current, target);

                let was_drifted = current != target;
                if was_drifted {
                    log::warn!(
                        "IPolicyConfig: drift detected! current='{}' != target='{}', re-applying...",
                        current, target
                    );
                    crate::audio::device_default::set_default_capture_endpoint(&target)?;
                    crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                        &format!("IPolicyConfig drift corrected: '{}' → '{}'", current, target));
                } else {
                    log::info!("IPolicyConfig: no drift — default is still correct");
                }

                serde_json::to_string(&serde_json::json!({
                    "active": true,
                    "was_drifted": was_drifted,
                    "current_device": target
                })).map_err(|e| e.to_string())
            })();

            if we_initialized {
                CoUninitialize();
            }
            res
        };
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        serde_json::to_string(&serde_json::json!({
            "active": false,
            "was_drifted": false
        })).map_err(|e| e.to_string())
    }
}

// ── IPolicyConfig restore helper ────────────────────────────────────

/// Restore the original default capture device if an IPolicyConfig override is active.
/// Safe to call even if no override was applied (no-op in that case).
/// Uses `take()` to atomically remove the stored value, preventing TOCTOU races
/// where a concurrent hot-swap could lose a newly-stored override.
fn restore_default_device_if_overridden(state: &AppState, app: &tauri::AppHandle) {
    // Atomically take the value — if another thread races, only one gets Some
    let original = match state.original_default_device.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };

    // Also clear the target endpoint
    if let Ok(mut target_guard) = state.ipolicy_target_endpoint.lock() {
        target_guard.take();
    }

    if let Some(ref original_id) = original {
        crate::stt::emit_stt_debug(app, "info", "audio",
            &format!("IPolicyConfig: restoring default capture → '{}'", original_id));

        match crate::audio::device_default::restore_default_capture_device(original_id) {
            Ok(()) => {
                crate::stt::emit_stt_debug(app, "info", "audio",
                    "IPolicyConfig: default capture device restored");
            }
            Err(e) => {
                crate::stt::emit_stt_debug(app, "error", "audio",
                    &format!("IPolicyConfig: restore failed: {}", e));
            }
        }
    }
}

// ── Per-party mute control ──────────────────────────────────────────

/// Mute or unmute a specific audio source.
/// When muted, audio is still captured (levels + recording) but NOT forwarded to STT.
///
/// `source` must be "you" or "them".
#[command]
pub async fn set_source_muted(
    app: AppHandle,
    source: String,
    muted: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    match source.as_str() {
        "you" => {
            state.you_muted.store(muted, Ordering::Relaxed);
            log::info!("'You' audio source {}", if muted { "muted" } else { "unmuted" });
        }
        "them" => {
            state.them_muted.store(muted, Ordering::Relaxed);
            log::info!("'Them' audio source {}", if muted { "muted" } else { "unmuted" });
        }
        _ => return Err(format!("Unknown source: '{}' (expected 'you' or 'them')", source)),
    }
    Ok(())
}

/// Get the current mute status for both sources.
#[command]
pub async fn get_mute_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let status = serde_json::json!({
        "you": state.you_muted.load(Ordering::Relaxed),
        "them": state.them_muted.load(Ordering::Relaxed),
    });
    serde_json::to_string(&status).map_err(|e| format!("Failed to serialize: {}", e))
}

