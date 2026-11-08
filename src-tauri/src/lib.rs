pub mod audio;
pub mod commands;
pub mod context;
pub mod credentials;
pub mod db;
pub mod intelligence;
pub mod logging;
pub mod rag;
pub mod llm;
pub mod meeting_detect;
pub mod ort_runtime;
pub mod state;
pub mod stt;
pub mod translation;
pub mod tray;

use state::AppState;
use std::sync::{Arc, Mutex};
use tauri::{
    tray::{TrayIconEvent, MouseButton},
    Emitter, Manager,
};

// == MODULE COMMANDS: audio ==
use commands::audio_commands;
// == MODULE COMMANDS: stt ==
use commands::stt_commands;
// == MODULE COMMANDS: llm ==
use commands::llm_commands;
use commands::log_commands;
// == MODULE COMMANDS: intelligence ==
use commands::intelligence_commands;
// == MODULE COMMANDS: context ==
use commands::context_commands;
// == MODULE COMMANDS: credentials ==
use commands::credential_commands;
// == MODULE COMMANDS: meetings ==
use commands::meeting_commands;
use commands::meeting_chat_commands;
// == MODULE COMMANDS: settings ==
use commands::settings_commands;
// == MODULE COMMANDS: models ==
use commands::model_commands;
// == MODULE COMMANDS: stealth ==
use commands::stealth_commands;
// == MODULE COMMANDS: gemini cache ==
use commands::gemini_cache_commands;
// == MODULE COMMANDS: rag ==
use commands::rag_commands;
// == MODULE COMMANDS: recording ==
use commands::recording_commands;
// == MODULE COMMANDS: translation ==
use commands::translation_commands;
// == MODULE COMMANDS: translation models ==
use commands::translation_model_commands;
// == MODULE COMMANDS: tray ==
use commands::tray_commands;
// == MODULE COMMANDS: updater ==
use commands::updater_commands;
// == MODULE COMMANDS: claude cli ==
use commands::claude_cli_commands;

/// Show the launcher window and hide the overlay window.
fn show_launcher(app: &tauri::AppHandle) {
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.show();
        let _ = launcher.unminimize();
        let _ = launcher.set_focus();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

/// Show the overlay window and hide the launcher window.
fn show_overlay(app: &tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_focus();
    }
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.hide();
    }
}

/// Launching NexQ again while it runs: bring up the overlay during a meeting
/// (hiding it would hide the meeting), else the launcher.
fn show_for_second_launch(app: &tauri::AppHandle) {
    let meeting_active = app
        .try_state::<AppState>()
        .map(|s| s.meeting_active.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false);
    if !meeting_active {
        show_launcher(app);
        return;
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.unminimize();
        let _ = overlay.set_focus();
    }
}

/// Hide all windows (minimize to tray).
fn hide_all(app: &tauri::AppHandle) {
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.hide();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Relaunched by the installer of an update installed on quit: the user
    // quit NexQ, so exit before anything (single-instance hand-off, windows,
    // tray) happens.
    if updater_commands::is_post_update_quit(std::env::args_os()) {
        return;
    }

    // App log: stderr plus a rotating file (opened in setup, once the log
    // folder is known). Without a logger every log statement is a no-op.
    logging::init();

    tauri::Builder::default()
        // Must be first: a second launch forwards to this process and exits,
        // preventing duplicate tray icons.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_for_second_launch(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        // Windows opened later (e.g. the dev log) follow stealth mode too.
        .on_page_load(|webview, _payload| {
            stealth_commands::apply_to_new_window(&webview.window());
        })
        .setup(|app| {
            log_commands::start(app.handle());
            let mut app_state = AppState::new();

            // -- Initialize DatabaseManager --
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");
            match db::DatabaseManager::new(app_data_dir.clone()) {
                Ok(db_mgr) => {
                    app_state.database = Some(Arc::new(Mutex::new(db_mgr)));
                    log::info!("Database initialized successfully");
                }
                Err(e) => {
                    log::error!("Failed to initialize database: {}", e);
                }
            }

            // -- Initialize ModelManager --
            let models_dir = app_data_dir.join("models");
            let model_mgr = stt::local_engines::ModelManager::new(models_dir);
            app_state.model_manager = Some(Arc::new(Mutex::new(model_mgr)));
            log::info!("Model manager initialized");

            // -- Initialize CredentialManager --
            let cred_mgr = credentials::CredentialManager::new();
            app_state.credentials = Some(Arc::new(Mutex::new(cred_mgr)));
            log::info!("Credential manager initialized");

            // -- Initialize ContextManager --
            let ctx_mgr = context::ContextManager::new();
            app_state.context = Some(Arc::new(Mutex::new(ctx_mgr)));
            log::info!("Context manager initialized");

            // -- Initialize RagManager --
            let rag_config = rag::config::RagConfig::default();
            let rag_mgr = rag::RagManager::new(rag_config);
            app_state.rag = Some(Arc::new(Mutex::new(rag_mgr)));
            log::info!("RAG manager initialized");

            // -- Restore persisted context resources from DB --
            // Load stored metadata first (while holding DB lock), then restore into
            // ContextManager (different lock), then clean up any stale DB entries.
            if let (Some(db_arc), Some(ctx_arc)) = (&app_state.database, &app_state.context) {
                let stored = {
                    match db_arc.lock() {
                        Ok(db_guard) => {
                            db::context::list_context_resources(db_guard.connection())
                                .unwrap_or_default()
                        }
                        Err(_) => Vec::new(),
                    }
                };

                let mut missing_ids: Vec<String> = Vec::new();

                if let Ok(mut ctx) = ctx_arc.lock() {
                    for db_res in stored {
                        let id = db_res.id.clone();
                        let res = context::ContextResource {
                            id: db_res.id,
                            name: db_res.name,
                            file_type: db_res.file_type,
                            file_path: db_res.file_path,
                            size_bytes: db_res.size_bytes as u64,
                            token_count: db_res.token_count as usize,
                            preview: db_res.preview,
                            loaded_at: db_res.loaded_at,
                        };
                        match ctx.restore_resource(res) {
                            Ok(()) => {}
                            Err(e) => {
                                log::warn!("Context resource {} no longer on disk, removing: {}", id, e);
                                missing_ids.push(id);
                            }
                        }
                    }
                    log::info!(
                        "Restored {} context resource(s) from DB",
                        ctx.list_resources().len()
                    );
                }

                // Clean up DB entries whose files have been deleted outside the app
                if !missing_ids.is_empty() {
                    if let Ok(db_guard) = db_arc.lock() {
                        for id in &missing_ids {
                            let _ = db::context::delete_context_resource(db_guard.connection(), id);
                            let _ = db::rag::delete_chunks_by_file(db_guard.connection(), id);
                        }
                        log::info!("Cleaned up {} stale context resource(s)", missing_ids.len());
                    }
                }
            }

            // -- Initialize STTRouter --
            let mut stt_router = stt::STTRouter::new();
            stt_router.set_app_handle(app.handle().clone());
            app_state.stt = Some(Arc::new(Mutex::new(stt_router)));
            log::info!("STT router initialized");

            // -- Initialize LLMRouter with auto-detected provider --
            let mut llm_router = llm::LLMRouter::new();

            // Try to auto-detect Ollama as default provider (no API key needed)
            let ollama_config = llm::ProviderConfig {
                provider_type: "ollama".to_string(),
                api_key: None,
                base_url: None,
                auth_type: None,
                auth_value: None,
                auth_header: None,
            };
            match llm_router.set_provider(ollama_config) {
                Ok(()) => {
                    log::info!("LLM router: Ollama set as default provider");
                }
                Err(e) => {
                    log::warn!("LLM router: Failed to set Ollama as default: {}", e);
                }
            }

            app_state.llm = Some(Arc::new(Mutex::new(llm_router)));
            log::info!("LLM router initialized");

            // -- Initialize IntelligenceEngine --
            let intel_engine = intelligence::IntelligenceEngine::new();
            app_state.intelligence = Some(Arc::new(Mutex::new(intel_engine)));
            log::info!("Intelligence engine initialized");

            // -- Initialize TranslationRouter --
            let opus_mt_dir = app_data_dir.join("models").join("opus_mt");
            let mut translation_router = translation::TranslationRouter::new();
            translation_router.set_opus_mt_models_dir(opus_mt_dir.clone());
            app_state.translation = Some(Arc::new(Mutex::new(translation_router)));
            log::info!("Translation router initialized");

            // -- Initialize OPUS-MT ModelManager --
            let opus_mt_mgr = translation::opus_mt_manager::OpusMtManager::new(opus_mt_dir);
            // Sync the active model ID to the translation router
            if let Some(active_id) = opus_mt_mgr.active_model_id() {
                if let Some(tr) = &app_state.translation {
                    if let Ok(mut router) = tr.lock() {
                        router.set_opus_mt_active_model(Some(active_id.to_string()));
                    }
                }
            }
            app_state.opus_mt_manager = Some(Arc::new(Mutex::new(opus_mt_mgr)));
            log::info!("OPUS-MT model manager initialized");

            // -- Claude CLI session manager (sessions start lazily) --
            app_state.agent_sessions = Arc::new(llm::cli_agent::manager::AgentSessionManager::new(
                Arc::new(llm::cli_agent::manager::ClaudeSpawner),
                Arc::new(llm::cli_agent::manager::TauriStatusSink(app.handle().clone())),
                app_state.claude_cli_config.clone(),
            )
            .with_catalog(app_state.claude_models.clone()));
            tauri::async_runtime::spawn(llm::cli_agent::manager::run_idle_reaper(
                app_state.agent_sessions.clone(),
            ));
            // Re-probe an unavailable Claude every 60 s (no model call).
            tauri::async_runtime::spawn(llm::cli_agent::routing::run_health_probe(
                app.handle().clone(),
            ));

            app.manage(app_state);

            // -- Auto-detect first Ollama model in background --
            let auto_detect_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Give Ollama a moment to be ready
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                let state = auto_detect_app.state::<AppState>();
                if let Some(ref llm_arc) = state.llm {
                    // Get the provider arc while holding the std lock briefly
                    let (provider_arc, needs_model) = {
                        match llm_arc.lock() {
                            Ok(router) => {
                                let needs = router.active_model().is_empty();
                                let provider = router.get_provider().ok();
                                (provider, needs)
                            }
                            Err(_) => return,
                        }
                    };

                    if needs_model {
                        if let Some(provider_arc) = provider_arc {
                            let provider = provider_arc.lock().await;
                            match provider.list_models().await {
                                Ok(models) if !models.is_empty() => {
                                    let first_model = models[0].id.clone();
                                    let model_count = models.len();
                                    drop(provider); // release tokio lock before std lock

                                    if let Ok(mut router) = llm_arc.lock() {
                                        router.set_active_model(first_model.clone());
                                        log::info!(
                                            "Auto-detected Ollama model: {} (from {} available)",
                                            first_model,
                                            model_count
                                        );
                                    }
                                }
                                Ok(_) => {
                                    log::warn!("Ollama running but no models found");
                                }
                                Err(e) => {
                                    log::warn!("Ollama not reachable for auto-detect: {}", e);
                                }
                            }
                        }
                    }
                }
            });

            // -- Initialize TrayManager (non-fatal — app works without enhanced tray) --
            match tray::IconSet::new(include_bytes!("../icons/icon.png")) {
                Ok(icon_set) => {
                    let manager = tray::TrayManager::new(icon_set);
                    let state = app.state::<AppState>();
                    *state.tray_manager.lock().unwrap() = Some(manager);

                    // Build initial idle menu (best-effort)
                    if let Ok(menu) = tray::menu::build_idle_menu(app.handle()) {
                        if let Some(tray_icon) = app.tray_by_id("main") {
                            let _ = tray_icon.set_menu(Some(menu));
                        }
                    }
                    log::info!("TrayManager initialized successfully");
                }
                Err(e) => {
                    log::error!("Failed to initialize TrayManager: {}. Tray will use defaults.", e);
                }
            }

            // -- Handle tray menu item clicks --
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().as_ref();
                // A deferred quit is waiting on a recording; don't start new work.
                if updater_commands::quit_pending() && id != "quit" {
                    log::info!("Ignoring tray action '{}' while quit is pending", id);
                    return;
                }
                match id {
                    "start_meeting" => {
                        let _ = _app.emit("tray_start_meeting", ());
                        show_overlay(&app_handle);
                    }
                    "stop_meeting" => {
                        let _ = _app.emit("tray_stop_meeting", ());
                    }
                    "toggle_mic" => {
                        let _ = _app.emit("tray_toggle_mic", ());
                    }
                    "toggle_system" => {
                        let _ = _app.emit("tray_toggle_system", ());
                    }
                    "toggle_stealth" => {
                        let _ = _app.emit("tray_toggle_stealth", ());
                    }
                    "toggle_screen_share_stealth" => {
                        let app = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let enabled = !stealth_commands::stealth_enabled();
                            match stealth_commands::set_stealth_mode(app.clone(), enabled).await {
                                Ok(()) => {
                                    let _ = app.emit("stealth_mode_changed", enabled);
                                }
                                Err(e) => log::warn!("Tray stealth toggle failed: {e}"),
                            }
                        });
                    }
                    "show_overlay" => {
                        // The overlay window switches to the meeting view, then
                        // shows itself (showing it first flashed an empty window).
                        let _ = _app.emit("tray_show_overlay", ());
                    }
                    "copy_ai_answer" => {
                        let _ = _app.emit("tray_copy", "ai_answer");
                    }
                    "copy_action_items" => {
                        let _ = _app.emit("tray_copy", "action_items");
                    }
                    "copy_summary" => {
                        let _ = _app.emit("tray_copy", "summary");
                    }
                    "copy_transcript" => {
                        let _ = _app.emit("tray_copy", "transcript");
                    }
                    "settings" => {
                        let _ = _app.emit("tray_open_settings", ());
                        show_launcher(&app_handle);
                    }
                    "quit" => {
                        _app.exit(0);
                    }
                    _ => {
                        // Check for recent meeting clicks (id format: "recent_{id}")
                        if let Some(meeting_id) = id.strip_prefix("recent_") {
                            let _ = _app.emit("tray_open_meeting", meeting_id.to_string());
                            show_launcher(&app_handle);
                        }
                    }
                }
            });

            // -- Handle tray icon click events (single/double/middle) --
            // -- Handle tray icon click events --
            // Windows fires Click on EVERY mouse-up, including both ups in a double-click.
            // This makes Click unreliable for toggle. Standard Windows UX:
            //   Left double-click → show/toggle window
            //   Middle click → mute toggle
            //   Right-click → context menu (handled by Tauri menu system)
            let tray_app = app.handle().clone();
            if let Some(tray_icon) = app.tray_by_id("main") {
                tray_icon.on_tray_icon_event(move |_tray, event| {
                    match event {
                        TrayIconEvent::DoubleClick { button, .. } => match button {
                            MouseButton::Left => {
                                tray::click::handle_single_click(&tray_app);
                            }
                            _ => {}
                        },
                        TrayIconEvent::Click { button, .. } => match button {
                            MouseButton::Middle => {
                                tray::click::handle_middle_click(&tray_app);
                            }
                            _ => {} // Ignore left-click — use double-click instead
                        },
                        _ => {}
                    }
                });
            }

            // -- Meeting detection (idle until the frontend pushes its settings) --
            meeting_detect::start(app.handle());

            // -- Stealth mode saved on: hide windows from capture before the webviews load --
            stealth_commands::restore_on_startup(app.handle());

            // -- Intercept launcher window close: hide instead of quit --
            if let Some(launcher) = app.get_webview_window("launcher") {
                let close_app = app.handle().clone();
                launcher.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_all(&close_app);
                    }
                });
            }

            // -- Live blur-behind on the overlay (real desktop passthrough), only while shown --
            #[cfg(target_os = "windows")]
            if let Some(overlay) = app.get_webview_window("overlay") {
                stealth_commands::blur_behind_while_visible(&overlay.as_ref().window());
            }

            log::info!("NexQ initialized successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // == COMMANDS: audio ==
            audio_commands::list_audio_devices,
            audio_commands::start_capture,
            audio_commands::stop_capture,
            audio_commands::get_audio_level,
            audio_commands::test_audio_device,
            audio_commands::start_audio_test,
            audio_commands::stop_audio_test,
            audio_commands::set_recording_enabled,
            audio_commands::get_audio_sessions,
            audio_commands::get_audio_peak_levels,
            audio_commands::start_capture_per_party,
            audio_commands::start_device_monitor,
            audio_commands::stop_device_monitor,
            audio_commands::set_source_muted,
            audio_commands::get_mute_status,
            audio_commands::set_echo_cancellation,
            audio_commands::ensure_ipolicy_override,
            // == COMMANDS: stt ==
            stt_commands::set_stt_provider,
            stt_commands::set_stt_language,
            stt_commands::test_stt_connection,
            stt_commands::get_available_stt_providers,
            stt_commands::update_whisper_dual_pass_config,
            stt_commands::estimate_deepgram_cost,
            stt_commands::update_deepgram_config,
            stt_commands::update_groq_config,
            stt_commands::set_pause_threshold,
            stt_commands::get_pause_threshold,
            // == COMMANDS: llm ==
            llm_commands::set_llm_provider,
            llm_commands::list_models,
            llm_commands::set_active_model,
            llm_commands::test_llm_connection,
            llm_commands::get_llm_providers,
            llm_commands::list_openrouter_models,
            // == COMMANDS: intelligence ==
            intelligence_commands::generate_assist,
            intelligence_commands::cancel_generation,
            intelligence_commands::set_auto_trigger,
            intelligence_commands::set_context_window_seconds,
            intelligence_commands::push_transcript,
            intelligence_commands::update_action_configs,
            intelligence_commands::get_action_configs,
            intelligence_commands::set_active_scenario,
            intelligence_commands::update_speaker_context,
            // == COMMANDS: context ==
            context_commands::load_context_file,
            context_commands::remove_context_file,
            context_commands::list_context_resources,
            context_commands::set_custom_instructions,
            context_commands::get_assembled_context,
            context_commands::get_token_budget,
            // == COMMANDS: credentials ==
            credential_commands::store_api_key,
            credential_commands::get_api_key,
            credential_commands::delete_api_key,
            credential_commands::has_api_key,
            // == COMMANDS: meetings ==
            meeting_commands::start_meeting,
            meeting_commands::end_meeting,
            meeting_commands::list_meetings,
            meeting_commands::get_meeting,
            meeting_commands::delete_meeting,
            meeting_commands::search_meetings,
            meeting_commands::append_transcript_segment,
            meeting_commands::save_meeting_ai_interactions,
            meeting_commands::rename_meeting,
            meeting_commands::update_meeting_summary,
            meeting_commands::save_meeting_speakers,
            meeting_commands::save_meeting_bookmarks,
            meeting_commands::add_meeting_bookmark,
            meeting_commands::update_meeting_bookmark,
            meeting_commands::delete_meeting_bookmark,
            meeting_commands::save_meeting_action_items,
            meeting_commands::update_action_item,
            meeting_commands::delete_action_item,
            meeting_commands::save_meeting_topic_sections,
            meeting_commands::rename_speaker,
            meeting_commands::update_meeting_mode,
            meeting_commands::start_past_meeting_session,
            meeting_commands::close_past_meeting_session,
            meeting_chat_commands::ask_meeting,
            meeting_chat_commands::list_meeting_chat,
            // == COMMANDS: settings ==
            settings_commands::get_config,
            settings_commands::set_config,
            // == COMMANDS: models ==
            model_commands::list_local_stt_engines,
            model_commands::download_local_stt_model,
            model_commands::cancel_model_download,
            model_commands::delete_local_stt_model,
            // == COMMANDS: stealth ==
            stealth_commands::set_stealth_mode,
            stealth_commands::get_stealth_support,
            log_commands::get_log_info,
            log_commands::set_verbose_logging,
            log_commands::open_log_folder,
            log_commands::get_recent_logs,
            log_commands::write_frontend_log,
            // == COMMANDS: meeting detection ==
            meeting_detect::set_meeting_detection_config,
            meeting_detect::get_detected_meeting,
            meeting_detect::dismiss_meeting_prompt,
            // == COMMANDS: tray ==
            tray_commands::set_tray_state,
            tray_commands::set_tray_tooltip,
            tray_commands::set_meeting_start_time,
            tray_commands::rebuild_tray_menu,
            // == COMMANDS: gemini cache ==
            gemini_cache_commands::create_gemini_context_cache,
            gemini_cache_commands::delete_gemini_context_cache,
            gemini_cache_commands::get_gemini_cache_status,
            // == COMMANDS: rag ==
            rag_commands::rebuild_rag_index,
            rag_commands::rebuild_file_index,
            rag_commands::clear_rag_index,
            rag_commands::get_rag_status,
            rag_commands::test_rag_search,
            rag_commands::get_rag_config,
            rag_commands::update_rag_config,
            rag_commands::test_ollama_embedding_connection,
            rag_commands::pull_embedding_model,
            rag_commands::test_rag_answer,
            rag_commands::remove_file_rag_index,
            // == COMMANDS: recording ==
            recording_commands::get_recording_info,
            recording_commands::get_recording_file_url,
            recording_commands::delete_recording,
            // == COMMANDS: translation ==
            translation_commands::set_translation_provider,
            translation_commands::translate_text,
            translation_commands::translate_segments,
            translation_commands::translate_batch,
            translation_commands::detect_language,
            translation_commands::test_translation_connection,
            translation_commands::get_translation_languages,
            translation_commands::get_meeting_translations,
            translation_commands::get_all_meeting_translations,
            translation_commands::export_translated_transcript,
            translation_commands::set_translation_languages,
            // == COMMANDS: translation models ==
            translation_model_commands::list_opus_mt_models,
            translation_model_commands::download_opus_mt_model,
            translation_model_commands::cancel_opus_mt_download,
            translation_model_commands::delete_opus_mt_model,
            translation_model_commands::activate_opus_mt_model,
            // == COMMANDS: updater ==
            updater_commands::check_for_update,
            updater_commands::download_update,
            updater_commands::install_update_now,
            updater_commands::get_pending_update,
            updater_commands::is_quit_pending,
            // == COMMANDS: claude cli ==
            claude_cli_commands::claude_cli_status,
            claude_cli_commands::set_claude_cli_config,
            claude_cli_commands::claude_cli_models,
            claude_cli_commands::seed_claude_cli_models,
            claude_cli_commands::get_agent_sessions,
            claude_cli_commands::open_claude_login_terminal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building NexQ")
        .run(|app, event| {
            // How NexQ ends up quitting, for bug reports (a window closing,
            // an exit request, or the OS terminating the app).
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                log::info!("Window '{label}' closed");
            }
            // Tray Quit (`app.exit(0)`) and any other exit request: install a
            // downloaded update first (exits inside the call on success), or
            // defer the quit while the last recording is still saving.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                let meeting_active = app.state::<AppState>().meeting_active.load(std::sync::atomic::Ordering::SeqCst);
                log::info!("Exit requested (code {code:?}, meeting active: {meeting_active})");
                if *code != Some(tauri::RESTART_EXIT_CODE) {
                    updater_commands::on_exit_requested(app, api);
                }
            }
            // Close Claude CLI sessions (each gets 2 s, in parallel). If the
            // process exits elsewhere (e.g. inside an update install), the
            // children still see stdin EOF and exit on their own.
            if let tauri::RunEvent::Exit = &event {
                let meeting_active = app.state::<AppState>().meeting_active.load(std::sync::atomic::Ordering::SeqCst);
                log::info!("NexQ is exiting (meeting active: {meeting_active})");
                let sessions = app.state::<AppState>().agent_sessions.clone();
                tauri::async_runtime::block_on(sessions.close_all());
                logging::flush(std::time::Duration::from_millis(500));
            }
        });
}
