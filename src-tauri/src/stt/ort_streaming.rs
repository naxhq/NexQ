// ONNX Runtime in-process streaming STT provider.
//
// Loads streaming transducer ONNX models (encoder, decoder, joiner) via the
// `ort` crate and runs inference on a dedicated std::thread.
//
// Key fixes over the original implementation:
// - Uses log-mel filterbank features (80-dim) instead of raw PCM
// - Manages encoder state tensors across chunks for streaming
// - Discovers model files by pattern instead of hardcoded names
// - Surfaces all errors to the frontend dev log via emit_stt_debug

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Audio sample rate expected by the models.
const SAMPLE_RATE: u32 = 16_000;

/// Chunk size in samples: 320ms at 16kHz = 5120 samples.
const CHUNK_SAMPLES: usize = (SAMPLE_RATE as usize) * 320 / 1000;

/// Number of consecutive blank tokens before we consider a segment boundary.
/// Zipformer downsamples ~4x, so each output frame ≈ 40ms.
/// 75 blanks ≈ 3 seconds of silence before splitting segments.
const BLANK_THRESHOLD: usize = 75;

/// The blank token ID used by most transducer vocabularies (token 0).
const BLANK_ID: i64 = 0;

/// Messages from feed_audio to the inference thread.
enum AudioMessage {
    Samples(Vec<i16>),
    Stop,
}

/// ORT Streaming STT provider.
pub struct OrtStreamingSTT {
    model_dir: PathBuf,
    language: String,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    stop_flag: Arc<AtomicBool>,
    audio_tx: Option<std::sync::mpsc::Sender<AudioMessage>>,
    inference_thread: Option<std::thread::JoinHandle<()>>,
    segment_counter: u64,
    app_handle: Option<AppHandle>,
}

impl OrtStreamingSTT {
    pub fn new(model_dir: PathBuf) -> Self {
        Self {
            model_dir,
            language: "en".to_string(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            audio_tx: None,
            inference_thread: None,
            segment_counter: 0,
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }
}

#[async_trait]
impl STTProvider for OrtStreamingSTT {
    fn provider_name(&self) -> &str {
        "ORT Streaming"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::OrtStreaming
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        // Discover model files by pattern (handles epoch-based naming)
        let model_files =
            crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir)
                .map_err(|e| format!("Model discovery failed in {}: {}", self.model_dir.display(), e))?;

        log::info!(
            "OrtStreamingSTT: Discovered models in {} — encoder={}, decoder={}, joiner={}",
            self.model_dir.display(),
            model_files.encoder.file_name().unwrap_or_default().to_string_lossy(),
            model_files.decoder.file_name().unwrap_or_default().to_string_lossy(),
            model_files.joiner.file_name().unwrap_or_default().to_string_lossy(),
        );

        self.stop_flag.store(false, AtomicOrdering::SeqCst);

        let (audio_tx, audio_rx) = std::sync::mpsc::channel::<AudioMessage>();
        self.audio_tx = Some(audio_tx);
        self.result_tx = Some(result_tx.clone());

        let model_dir = self.model_dir.clone();
        let language = self.language.clone();
        let stop_flag = Arc::clone(&self.stop_flag);
        let seg_start = self.segment_counter;
        let app_handle = self.app_handle.clone();
        let encoder_path = model_files.encoder.clone();
        let decoder_path = model_files.decoder.clone();
        let joiner_path = model_files.joiner.clone();
        let tokens_path = model_files.tokens.clone();

        let thread = std::thread::Builder::new()
            .name("ort-stt-inference".to_string())
            .spawn(move || {
                inference_thread_main(
                    model_dir,
                    encoder_path,
                    decoder_path,
                    joiner_path,
                    tokens_path,
                    language,
                    stop_flag,
                    audio_rx,
                    result_tx,
                    seg_start,
                    app_handle,
                );
            })?;

        self.inference_thread = Some(thread);
        self.is_streaming = true;

        log::info!("OrtStreamingSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        if chunk.pcm_data.is_empty() {
            return Ok(());
        }

        if let Some(ref tx) = self.audio_tx {
            if tx.send(AudioMessage::Samples(chunk.pcm_data)).is_err() {
                log::warn!("OrtStreamingSTT: Audio channel closed");
                self.is_streaming = false;
            }
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("OrtStreamingSTT: Stopping stream");

        self.stop_flag.store(true, AtomicOrdering::SeqCst);

        // Send stop signal and drop channel
        if let Some(tx) = self.audio_tx.take() {
            let _ = tx.send(AudioMessage::Stop);
        }

        // Wait for inference thread
        if let Some(thread) = self.inference_thread.take() {
            let _ = thread.join();
        }

        self.is_streaming = false;
        self.result_tx = None;

        log::info!("OrtStreamingSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        match crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir) {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("Model files not found: {}", e).into()),
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language
            .split('-')
            .next()
            .unwrap_or(language)
            .to_string();
        log::info!("OrtStreamingSTT: Language set to {}", self.language);
    }
}

/// Load tokens from tokens.txt. Format: one token per line, either
/// "token_text id" or just "token_text" (index = line number).
fn load_tokens(path: &std::path::Path) -> Result<HashMap<i64, String>, String> {
    use std::io::{BufRead, BufReader};

    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open tokens file: {}", e))?;
    let reader = BufReader::new(file);

    let mut tokens = HashMap::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("Failed to read tokens line: {}", e))?;
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        // Try "token_text id" format first
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            if let Ok(id) = parts.last().unwrap().parse::<i64>() {
                let text = parts[..parts.len() - 1].join(" ");
                tokens.insert(id, text);
                continue;
            }
        }
        // Fallback: line number is the ID
        tokens.insert(idx as i64, line);
    }

    Ok(tokens)
}

/// Decode a sequence of token IDs into text.
/// Applies sentence casing since some model vocabularies are ALL CAPS.
fn detokenize(token_ids: &[i64], vocab: &HashMap<i64, String>) -> String {
    let mut result = String::new();
    for &id in token_ids {
        if id == BLANK_ID {
            continue;
        }
        if let Some(text) = vocab.get(&id) {
            let cleaned = text
                .replace('\u{2581}', " ")
                .replace("▁", " ");
            result.push_str(&cleaned);
        }
    }
    let trimmed = result.trim().to_string();
    // Sentence-case: lowercase everything, then capitalize first character
    let lower = trimmed.to_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

/// State tensor that can be f32, i32, or i64 (matching model expectations).
enum StateTensor {
    F32(ndarray::ArrayD<f32>),
    I32(ndarray::ArrayD<i32>),
    I64(ndarray::ArrayD<i64>),
}

/// Encoder state manager for streaming transducer models.
///
/// At load time, introspects the ONNX model's inputs/outputs to discover:
/// - Which inputs are audio features vs. cached states
/// - How state inputs map to state outputs (by "new_" prefix convention)
/// - The shape and element type of each state tensor (for zero-initialization)
/// - The required number of time frames per chunk (fixed models like zipformer)
struct EncoderStateManager {
    /// State tensor data, keyed by input name (supports mixed f32/i64 types).
    states: HashMap<String, StateTensor>,
    /// (input_name, output_name) pairs for state tensors.
    state_pairs: Vec<(String, String)>,
    /// Name of the audio feature input (e.g., "x").
    audio_input_name: String,
    /// Name of the audio length input (e.g., "x_lens").
    lens_input_name: Option<String>,
    /// All input names in session order (for positional building).
    input_order: Vec<String>,
    /// All output names in session order.
    output_order: Vec<String>,
    /// Indices of encoder output tensors (non-state outputs).
    encoder_out_indices: Vec<usize>,
    /// Required number of time frames per encoder call (from model shape).
    required_chunk_frames: usize,
    /// Feature dimension (number of mel channels): 80 for zipformer, 128 for parakeet.
    feature_dim: usize,
}

impl EncoderStateManager {
    /// Discover model structure and initialize states from a loaded encoder session.
    fn discover(session: &ort::session::Session) -> Result<Self, String> {
        let mut audio_input_name = String::new();
        let mut lens_input_name: Option<String> = None;
        let mut state_input_names: Vec<String> = Vec::new();
        let mut input_order: Vec<String> = Vec::new();

        // The required time dimension for the audio input (extracted from model shape).
        let mut required_chunk_frames: usize = 0;
        // Feature dimension (mel channels) from the model's audio input shape.
        let mut feature_dim: usize = 80;

        // Classify inputs
        for input in session.inputs() {
            let name = input.name().to_string();
            input_order.push(name.clone());

            if let ort::value::ValueType::Tensor { shape, .. } = input.dtype() {
                // Audio features: [batch, time, feature_dim] — detect any 3D tensor
                // whose last dim is a plausible mel count (64, 80, 128, etc.)
                let last = shape.last().copied().unwrap_or(0);
                if shape.len() == 3 && last != 0 && audio_input_name.is_empty() {
                    audio_input_name = name.clone();
                    if last > 0 {
                        feature_dim = last as usize;
                    } else {
                        // Dynamic dim (-1): infer from input name convention.
                        // NeMo/Parakeet models use "audio_signal" with 128-dim features.
                        // Most zipformer/conformer models use 80-dim features.
                        feature_dim = if name.contains("audio_signal") { 128 } else { 80 };
                        log::info!(
                            "OrtStreamingSTT: dynamic feature dim on '{}', inferred feature_dim={}",
                            name, feature_dim
                        );
                    }
                    // Extract the required time dimension (shape[1])
                    let time_dim = shape[1];
                    if time_dim > 0 {
                        required_chunk_frames = time_dim as usize;
                    }
                } else if shape.len() == 1
                    && (name.contains("len") || name == "x_lens")
                {
                    lens_input_name = Some(name);
                } else {
                    state_input_names.push(name);
                }
            }
        }

        // Fallback: if no 3D input found, use first input
        if audio_input_name.is_empty() {
            if let Some(first) = input_order.first() {
                log::warn!(
                    "OrtStreamingSTT: No 3D audio input found, using first input '{}' as audio",
                    first
                );
                audio_input_name = first.clone();
                state_input_names.retain(|n| n != first);
            }
        }

        // Classify outputs
        let mut output_order: Vec<String> = Vec::new();
        let mut state_output_names: Vec<String> = Vec::new();
        let mut encoder_out_indices: Vec<usize> = Vec::new();

        for (idx, output) in session.outputs().iter().enumerate() {
            let name = output.name().to_string();
            output_order.push(name.clone());

            let is_state = state_input_names.iter().any(|inp| {
                name == format!("new_{}", inp)
                    || name.strip_prefix("new_").map_or(false, |s| s == inp)
            });

            if is_state {
                state_output_names.push(name);
            } else {
                encoder_out_indices.push(idx);
            }
        }

        // Build state pairs: (input_name, output_name)
        let mut state_pairs: Vec<(String, String)> = Vec::new();
        for inp_name in &state_input_names {
            let out_name = format!("new_{}", inp_name);
            if state_output_names.contains(&out_name) {
                state_pairs.push((inp_name.clone(), out_name));
            }
        }

        // Initialize state tensors to zeros (type-aware: f32 or i64)
        let mut states: HashMap<String, StateTensor> = HashMap::new();
        for input in session.inputs() {
            let inp_name = input.name().to_string();
            if state_input_names.contains(&inp_name) {
                if let ort::value::ValueType::Tensor { ty, shape, .. } = input.dtype() {
                    let dims: Vec<usize> = shape
                        .iter()
                        .map(|&d| if d <= 0 { 1 } else { d as usize })
                        .collect();
                    let state = if *ty == ort::value::TensorElementType::Int64 {
                        StateTensor::I64(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else if *ty == ort::value::TensorElementType::Int32 {
                        StateTensor::I32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else {
                        StateTensor::F32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    };
                    states.insert(inp_name, state);
                }
            }
        }

        // Default to 39 if model has dynamic shape (0 or negative)
        if required_chunk_frames == 0 {
            required_chunk_frames = 39;
            log::info!("EncoderState: dynamic time dim, defaulting to {} frames", required_chunk_frames);
        }

        let i64_count = states.values().filter(|s| matches!(s, StateTensor::I64(_))).count();
        let i32_count = states.values().filter(|s| matches!(s, StateTensor::I32(_))).count();
        let f32_count = states.values().filter(|s| matches!(s, StateTensor::F32(_))).count();
        log::info!(
            "EncoderState: audio='{}', lens={:?}, {} state pairs ({} f32, {} i32, {} i64), {} encoder outputs, chunk={}frames, feature_dim={}",
            audio_input_name,
            lens_input_name,
            state_pairs.len(),
            f32_count,
            i32_count,
            i64_count,
            encoder_out_indices.len(),
            required_chunk_frames,
            feature_dim,
        );

        Ok(Self {
            states,
            state_pairs,
            audio_input_name,
            lens_input_name,
            input_order,
            output_order,
            encoder_out_indices,
            required_chunk_frames,
            feature_dim,
        })
    }

    /// Run encoder with feature frames and manage state tensors.
    fn run_encoder(
        &mut self,
        session: &mut ort::session::Session,
        features: &[Vec<f32>],
    ) -> Result<Vec<Vec<f32>>, String> {
        if features.is_empty() {
            return Ok(vec![]);
        }

        let num_frames = features.len();

        // Build feature tensor [1, num_frames, feature_dim]
        let flat: Vec<f32> = features.iter().flatten().copied().collect();
        let feature_arr = ndarray::Array3::from_shape_vec((1, num_frames, self.feature_dim), flat)
            .map_err(|e| format!("feature shape: {}", e))?;

        // Build lens tensor [1]
        let lens_arr = ndarray::Array1::from_vec(vec![num_frames as i64]);

        // Build named input values: Vec<(Cow<str>, SessionInputValue)>
        let mut input_values: Vec<(
            std::borrow::Cow<'_, str>,
            ort::session::SessionInputValue<'_>,
        )> = Vec::new();

        for name in &self.input_order {
            if *name == self.audio_input_name {
                let tensor = ort::value::Tensor::from_array(feature_arr.clone())
                    .map_err(|e| format!("audio tensor: {}", e))?;
                input_values.push((name.clone().into(), tensor.into()));
            } else if self.lens_input_name.as_ref() == Some(name) {
                let tensor = ort::value::Tensor::from_array(lens_arr.clone())
                    .map_err(|e| format!("lens tensor: {}", e))?;
                input_values.push((name.clone().into(), tensor.into()));
            } else if let Some(state_tensor) = self.states.get(name) {
                match state_tensor {
                    StateTensor::F32(arr) => {
                        let tensor = ort::value::Tensor::from_array(arr.clone())
                            .map_err(|e| format!("state '{}' (f32): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                    StateTensor::I32(arr) => {
                        let tensor = ort::value::Tensor::from_array(arr.clone())
                            .map_err(|e| format!("state '{}' (i32): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                    StateTensor::I64(arr) => {
                        let tensor = ort::value::Tensor::from_array(arr.clone())
                            .map_err(|e| format!("state '{}' (i64): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                }
            }
        }

        let outputs = session
            .run(input_values)
            .map_err(|e| format!("encoder run: {}", e))?;

        // Extract encoder output frames from the first encoder output index
        let mut frames = Vec::new();
        if let Some(&out_idx) = self.encoder_out_indices.first() {
            let (shape, flat_out) = outputs[out_idx]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("encoder output extract: {}", e))?;

            let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
            let time_out = if dims.len() >= 2 { dims[1] } else { 1 };
            let enc_dim = if dims.len() >= 3 {
                dims[2]
            } else {
                flat_out.len() / time_out.max(1)
            };

            for t in 0..time_out {
                let start = t * enc_dim;
                let end = start + enc_dim;
                if end <= flat_out.len() {
                    frames.push(flat_out[start..end].to_vec());
                }
            }
        }

        // Update states from outputs (type-aware: match input type)
        for (input_name, output_name) in &self.state_pairs {
            if let Some(out_idx) = self.output_order.iter().position(|n| n == output_name) {
                if out_idx < outputs.len() {
                    let is_i64 = matches!(self.states.get(input_name), Some(StateTensor::I64(_)));
                    let is_i32 = matches!(self.states.get(input_name), Some(StateTensor::I32(_)));
                    let new_state = if is_i64 {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<i64>()
                            .map_err(|e| format!("state output '{}' (i64): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::I64(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("state reshape '{}': {}", input_name, e))?,
                        )
                    } else if is_i32 {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<i32>()
                            .map_err(|e| format!("state output '{}' (i32): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::I32(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("state reshape '{}': {}", input_name, e))?,
                        )
                    } else {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<f32>()
                            .map_err(|e| format!("state output '{}' (f32): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::F32(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("state reshape '{}': {}", input_name, e))?,
                        )
                    };
                    self.states.insert(input_name.clone(), new_state);
                }
            }
        }

        Ok(frames)
    }
}

/// Main inference thread function.
fn inference_thread_main(
    _model_dir: PathBuf,
    encoder_path: PathBuf,
    decoder_path: PathBuf,
    joiner_path: PathBuf,
    tokens_path: PathBuf,
    language: String,
    stop_flag: Arc<AtomicBool>,
    audio_rx: std::sync::mpsc::Receiver<AudioMessage>,
    result_tx: mpsc::Sender<TranscriptResult>,
    segment_counter_start: u64,
    app_handle: Option<AppHandle>,
) {
    // Helper to emit both to Rust log and frontend dev log
    let debug = |level: &str, msg: &str| {
        match level {
            "error" => log::error!("[ort_streaming] {}", msg),
            "warn" => log::warn!("[ort_streaming] {}", msg),
            _ => log::info!("[ort_streaming] {}", msg),
        }
        if let Some(ref handle) = app_handle {
            crate::stt::emit_stt_debug(handle, level, "ort_streaming", msg);
        }
    };

    debug("info", "Inference thread started, loading models...");

    // Load tokens
    let tokens = match load_tokens(&tokens_path) {
        Ok(t) => {
            debug("info", &format!("Loaded {} tokens", t.len()));
            t
        }
        Err(e) => {
            debug("error", &format!("Failed to load tokens: {}", e));
            return;
        }
    };

    // Load ORT sessions (mut required for session.run())
    let mut encoder = match load_ort_session(&encoder_path) {
        Ok(s) => s,
        Err(e) => {
            debug("error", &format!("Encoder load failed: {}", e));
            return;
        }
    };
    let mut decoder = match load_ort_session(&decoder_path) {
        Ok(s) => s,
        Err(e) => {
            debug("error", &format!("Decoder load failed: {}", e));
            return;
        }
    };
    let mut joiner = match load_ort_session(&joiner_path) {
        Ok(s) => s,
        Err(e) => {
            debug("error", &format!("Joiner load failed: {}", e));
            return;
        }
    };

    // Discover joiner input ranks (rank 2 for Zipformer, rank 3 for Parakeet TDT)
    let joiner_info = JoinerInfo::discover(&joiner);
    debug(
        "info",
        &format!(
            "Joiner input ranks: encoder={}, decoder={}",
            joiner_info.encoder_input_rank, joiner_info.decoder_input_rank
        ),
    );

    // Initialize encoder state manager (introspects model inputs/outputs)
    let mut state_mgr = match EncoderStateManager::discover(&encoder) {
        Ok(s) => s,
        Err(e) => {
            debug(
                "error",
                &format!("Encoder state discovery failed: {}", e),
            );
            return;
        }
    };

    // Initialize decoder state manager (handles LSTM states for TDT, no-op for stateless decoders)
    let mut decoder_state_mgr = match DecoderStateManager::discover(&decoder) {
        Ok(s) => s,
        Err(e) => {
            debug(
                "error",
                &format!("Decoder state discovery failed: {}", e),
            );
            return;
        }
    };

    debug(
        "info",
        &format!(
            "Models loaded successfully: {} state inputs, {} tokens",
            state_mgr.states.len(),
            tokens.len()
        ),
    );

    // Initialize Fbank feature extractor with the model's expected feature dimension
    let feature_dim = state_mgr.feature_dim;
    let mut fbank = crate::stt::fbank::FbankExtractor::with_num_mels(feature_dim);

    // Buffer for accumulating Fbank frames until we have enough for one encoder call
    let mut feature_buffer: Vec<Vec<f32>> = Vec::new();
    let chunk_frames = state_mgr.required_chunk_frames;

    debug(
        "info",
        &format!(
            "Encoder requires {} frames per chunk ({:.0}ms), feature_dim={}",
            chunk_frames,
            chunk_frames as f64 * 10.0,
            feature_dim,
        ),
    );

    // Helper: current epoch time in milliseconds (matches frontend Date.now())
    let epoch_ms = || -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    };

    // Decode state
    let mut pcm_buffer: Vec<f32> = Vec::new();
    let mut emitted_tokens: Vec<i64> = Vec::new();
    let mut last_decoder_error: Option<std::time::Instant> = None;
    let mut segment_counter = segment_counter_start;
    let mut consecutive_blanks: usize = 0;
    let mut first_transcription = true;

    // Diagnostic counters for periodic stats logging
    let mut total_samples_fed: u64 = 0;
    let mut total_encoder_runs: u64 = 0;
    let mut total_blank_frames: u64 = 0;
    let mut total_nonblank_frames: u64 = 0;
    let mut last_stats_time = std::time::Instant::now();

    // Main decode loop
    loop {
        if stop_flag.load(AtomicOrdering::SeqCst) {
            break;
        }

        // Periodic diagnostic stats (every 10 seconds)
        if last_stats_time.elapsed().as_secs() >= 10 {
            debug(
                "info",
                &format!(
                    "Stats: samples_fed={}, encoder_runs={}, blanks={}, non_blanks={}, tokens={}",
                    total_samples_fed,
                    total_encoder_runs,
                    total_blank_frames,
                    total_nonblank_frames,
                    emitted_tokens.len()
                ),
            );
            last_stats_time = std::time::Instant::now();
        }

        // Receive audio with timeout
        match audio_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(AudioMessage::Samples(samples)) => {
                total_samples_fed += samples.len() as u64;
                for &s in &samples {
                    pcm_buffer.push(s as f32 / 32768.0);
                }
            }
            Ok(AudioMessage::Stop) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        // Extract Fbank frames from available PCM and accumulate in feature_buffer
        while pcm_buffer.len() >= CHUNK_SAMPLES {
            let chunk: Vec<f32> = pcm_buffer.drain(..CHUNK_SAMPLES).collect();
            let new_frames = fbank.process_chunk(&chunk);
            feature_buffer.extend(new_frames);
        }

        // Process encoder when we have accumulated enough frames
        while feature_buffer.len() >= chunk_frames {
            let chunk: Vec<Vec<f32>> = feature_buffer.drain(..chunk_frames).collect();

            // Run encoder with state management
            let encoder_frames = match state_mgr.run_encoder(&mut encoder, &chunk) {
                Ok(frames) => frames,
                Err(e) => {
                    debug("error", &format!("Encoder error: {}", e));
                    continue;
                }
            };

            total_encoder_runs += 1;

            // Log first encoder output characteristics for diagnostics
            if total_encoder_runs == 1 && !encoder_frames.is_empty() {
                let frame = &encoder_frames[0];
                let min_val = frame.iter().cloned().fold(f32::INFINITY, f32::min);
                let max_val = frame.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let mean = frame.iter().sum::<f32>() / frame.len().max(1) as f32;
                debug(
                    "info",
                    &format!(
                        "First encoder output: {} frames x {} dim, range=[{:.4}, {:.4}], mean={:.4}",
                        encoder_frames.len(),
                        frame.len(),
                        min_val,
                        max_val,
                        mean
                    ),
                );
            }

            // Process each encoder output frame through the transducer
            for enc_frame in &encoder_frames {
                // Run decoder on current context (with LSTM state management)
                let decoder_out = match decoder_state_mgr.run_decoder(&mut decoder, &emitted_tokens) {
                    Ok(out) => out,
                    Err(e) => {
                        let now = std::time::Instant::now();
                        if last_decoder_error.map_or(true, |t| now.duration_since(t).as_secs() >= 5) {
                            debug("error", &format!("Decoder error: {}", e));
                            last_decoder_error = Some(now);
                        }
                        continue;
                    }
                };

                // Run joiner
                let logits = match run_joiner(&mut joiner, enc_frame, &decoder_out, &joiner_info) {
                    Ok(l) => l,
                    Err(e) => {
                        debug("error", &format!("Joiner error: {}", e));
                        continue;
                    }
                };

                // Greedy decode: argmax
                let top_token = logits
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| {
                        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|(idx, _)| idx as i64)
                    .unwrap_or(BLANK_ID);

                if top_token != BLANK_ID {
                    total_nonblank_frames += 1;
                    emitted_tokens.push(top_token);
                    consecutive_blanks = 0;

                    // Emit interim result
                    let text = detokenize(&emitted_tokens, &tokens);
                    if !text.is_empty() {
                        if first_transcription {
                            debug("info", "First transcription produced");
                            first_transcription = false;
                        }
                        let seg_id = format!("ort_{}", segment_counter);
                        let _ = result_tx.blocking_send(TranscriptResult {
                            text,
                            is_final: false,
                            confidence: 0.80,
                            timestamp_ms: epoch_ms(),
                            speaker: None,
                            language: Some(language.clone()),
                            segment_id: Some(seg_id),
                        });
                    }
                } else {
                    total_blank_frames += 1;
                    consecutive_blanks += 1;

                    // Segment boundary: too many blanks
                    if consecutive_blanks >= BLANK_THRESHOLD && !emitted_tokens.is_empty() {
                        let text = detokenize(&emitted_tokens, &tokens);
                        if !text.is_empty() {
                            let seg_id = format!("ort_{}", segment_counter);
                            let _ = result_tx.blocking_send(TranscriptResult {
                                text,
                                is_final: true,
                                confidence: 0.90,
                                timestamp_ms: epoch_ms(),
                                speaker: None,
                                language: Some(language.clone()),
                                segment_id: Some(seg_id),
                            });
                        }

                        // Reset for next segment
                        emitted_tokens.clear();
                        consecutive_blanks = 0;
                        segment_counter += 1;
                        decoder_state_mgr.reset_states(&decoder);
                    }
                }
            }
        }
    }

    // Flush remaining tokens
    if !emitted_tokens.is_empty() {
        let text = detokenize(&emitted_tokens, &tokens);
        if !text.is_empty() {
            let seg_id = format!("ort_{}", segment_counter);
            let _ = result_tx.blocking_send(TranscriptResult {
                text,
                is_final: true,
                confidence: 0.85,
                timestamp_ms: epoch_ms(),
                speaker: None,
                language: Some(language),
                segment_id: Some(seg_id),
            });
        }
    }

    debug("info", "Inference thread exiting");
}

/// Load an ORT session from a file.
fn load_ort_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
    let filename = path.file_name().unwrap_or_default().to_string_lossy();

    crate::ort_runtime::ensure_loaded()?;
    let session = ort::session::Session::builder()
        .map_err(|e| format!("Session builder error: {}", e))?
        .with_intra_threads(4)
        .map_err(|e| format!("Thread config error: {}", e))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load {}: {}", filename, e))?;

    log::info!(
        "OrtStreamingSTT: Loaded {} ({} inputs, {} outputs)",
        filename,
        session.inputs().len(),
        session.outputs().len(),
    );
    Ok(session)
}

/// Decoder state manager for transducer models with LSTM prediction networks.
///
/// Simple decoders (e.g., zipformer) take only token context and have no state.
/// LSTM decoders (e.g., Parakeet TDT) carry hidden/cell states between calls.
/// This struct handles both cases transparently.
struct DecoderStateManager {
    /// Whether the token input expects i32 (Parakeet TDT) vs i64 (zipformer).
    expects_i32: bool,
    /// Name of the token context input.
    token_input_name: String,
    /// Required token context length (from model shape, e.g. 2).
    context_len: usize,
    /// State tensors keyed by input name (empty for stateless decoders).
    states: HashMap<String, StateTensor>,
    /// (input_name, output_name) pairs for state tensors.
    state_pairs: Vec<(String, String)>,
    /// All input names in session order.
    input_order: Vec<String>,
    /// All output names in session order.
    output_order: Vec<String>,
    /// Index of the decoder embedding output (non-state output).
    decoder_out_index: usize,
}

impl DecoderStateManager {
    /// Discover decoder model structure and initialize states.
    fn discover(session: &ort::session::Session) -> Result<Self, String> {
        let mut token_input_name = String::new();
        let mut expects_i32 = false;
        let mut context_len: usize = 2;
        let mut state_input_names: Vec<String> = Vec::new();
        let mut input_order: Vec<String> = Vec::new();

        // Classify inputs: integer tensors are token context, float tensors are states
        for input in session.inputs() {
            let name = input.name().to_string();
            input_order.push(name.clone());

            if let ort::value::ValueType::Tensor { ty, shape, .. } = input.dtype() {
                match ty {
                    ort::value::TensorElementType::Int32 | ort::value::TensorElementType::Int64 => {
                        if token_input_name.is_empty() {
                            token_input_name = name.clone();
                            expects_i32 = *ty == ort::value::TensorElementType::Int32;
                            // Extract context length from shape (last dim)
                            if let Some(&last) = shape.last() {
                                if last > 0 {
                                    context_len = last as usize;
                                }
                            }
                        } else {
                            // Additional integer inputs treated as state
                            state_input_names.push(name);
                        }
                    }
                    _ => {
                        // Float/other tensors are state inputs
                        state_input_names.push(name);
                    }
                }
            }
        }

        if token_input_name.is_empty() {
            // Fallback: use first input
            if let Some(first) = input_order.first() {
                token_input_name = first.clone();
            } else {
                return Err("Decoder has no inputs".to_string());
            }
        }

        // Classify outputs: match state outputs by "new_" prefix
        let mut output_order: Vec<String> = Vec::new();
        let mut state_output_names: Vec<String> = Vec::new();
        let mut decoder_out_index: usize = 0;

        for (idx, output) in session.outputs().iter().enumerate() {
            let name = output.name().to_string();
            output_order.push(name.clone());

            let is_state = state_input_names.iter().any(|inp| {
                name == format!("new_{}", inp)
                    || name.strip_prefix("new_").map_or(false, |s| s == inp)
            });

            if is_state {
                state_output_names.push(name);
            } else if idx == 0 || decoder_out_index == 0 {
                decoder_out_index = idx;
            }
        }

        // Build state pairs
        let mut state_pairs: Vec<(String, String)> = Vec::new();
        for inp_name in &state_input_names {
            let out_name = format!("new_{}", inp_name);
            if state_output_names.contains(&out_name) {
                state_pairs.push((inp_name.clone(), out_name));
            }
        }

        // Initialize state tensors to zeros
        let mut states: HashMap<String, StateTensor> = HashMap::new();
        for input in session.inputs() {
            let inp_name = input.name().to_string();
            if state_input_names.contains(&inp_name) {
                if let ort::value::ValueType::Tensor { ty, shape, .. } = input.dtype() {
                    let dims: Vec<usize> = shape
                        .iter()
                        .map(|&d| if d <= 0 { 1 } else { d as usize })
                        .collect();
                    let state = if *ty == ort::value::TensorElementType::Int64 {
                        StateTensor::I64(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else if *ty == ort::value::TensorElementType::Int32 {
                        StateTensor::I32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else {
                        StateTensor::F32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    };
                    states.insert(inp_name, state);
                }
            }
        }

        log::info!(
            "DecoderState: token_input='{}' ({}), context_len={}, {} state pairs, decoder_out_idx={}",
            token_input_name,
            if expects_i32 { "i32" } else { "i64" },
            context_len,
            state_pairs.len(),
            decoder_out_index,
        );

        Ok(Self {
            expects_i32,
            token_input_name,
            context_len,
            states,
            state_pairs,
            input_order,
            output_order,
            decoder_out_index,
        })
    }

    /// Run decoder with token context and manage LSTM states.
    fn run_decoder(
        &mut self,
        session: &mut ort::session::Session,
        token_context: &[i64],
    ) -> Result<Vec<f32>, String> {
        use ort::value::Tensor;

        // Build token context (pad with blanks if needed)
        let context: Vec<i64> = if token_context.len() >= self.context_len {
            token_context[token_context.len() - self.context_len..].to_vec()
        } else {
            let mut ctx = vec![BLANK_ID; self.context_len];
            for (i, &t) in token_context.iter().rev().enumerate() {
                if i < self.context_len {
                    ctx[self.context_len - 1 - i] = t;
                }
            }
            ctx
        };

        // Build named input values in session order
        let mut input_values: Vec<(
            std::borrow::Cow<'_, str>,
            ort::session::SessionInputValue<'_>,
        )> = Vec::new();

        for name in &self.input_order {
            if *name == self.token_input_name {
                // Token context input
                if self.expects_i32 {
                    let context_i32: Vec<i32> = context.iter().map(|&t| t as i32).collect();
                    let arr = ndarray::Array2::from_shape_vec((1, self.context_len), context_i32)
                        .map_err(|e| format!("decoder token shape: {}", e))?;
                    let tensor = Tensor::from_array(arr)
                        .map_err(|e| format!("decoder token tensor: {}", e))?;
                    input_values.push((name.clone().into(), tensor.into()));
                } else {
                    let arr = ndarray::Array2::from_shape_vec((1, self.context_len), context.clone())
                        .map_err(|e| format!("decoder token shape: {}", e))?;
                    let tensor = Tensor::from_array(arr)
                        .map_err(|e| format!("decoder token tensor: {}", e))?;
                    input_values.push((name.clone().into(), tensor.into()));
                }
            } else if let Some(state_tensor) = self.states.get(name) {
                // State input (LSTM hidden/cell)
                match state_tensor {
                    StateTensor::F32(arr) => {
                        let tensor = Tensor::from_array(arr.clone())
                            .map_err(|e| format!("decoder state '{}' (f32): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                    StateTensor::I32(arr) => {
                        let tensor = Tensor::from_array(arr.clone())
                            .map_err(|e| format!("decoder state '{}' (i32): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                    StateTensor::I64(arr) => {
                        let tensor = Tensor::from_array(arr.clone())
                            .map_err(|e| format!("decoder state '{}' (i64): {}", name, e))?;
                        input_values.push((name.clone().into(), tensor.into()));
                    }
                }
            }
        }

        let outputs = session
            .run(input_values)
            .map_err(|e| format!("decoder inference failed: {}", e))?;

        // Extract decoder embedding output — try i32 first (Parakeet TDT),
        // fall back to f32 for other transducer models.
        let out_idx = self.decoder_out_index.min(outputs.len().saturating_sub(1));
        let result: Vec<f32> = match outputs[out_idx].try_extract_tensor::<i32>() {
            Ok((_shape, data)) => data.iter().map(|&x| x as f32).collect(),
            Err(_) => {
                let (_shape, data) = outputs[out_idx]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("decoder output extraction failed: {}", e))?;
                data.to_vec()
            }
        };

        // Update states from outputs
        for (input_name, output_name) in &self.state_pairs {
            if let Some(out_idx) = self.output_order.iter().position(|n| n == output_name) {
                if out_idx < outputs.len() {
                    let is_i64 = matches!(self.states.get(input_name), Some(StateTensor::I64(_)));
                    let is_i32 = matches!(self.states.get(input_name), Some(StateTensor::I32(_)));
                    let new_state = if is_i64 {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<i64>()
                            .map_err(|e| format!("decoder state out '{}' (i64): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::I64(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("decoder state reshape '{}': {}", input_name, e))?,
                        )
                    } else if is_i32 {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<i32>()
                            .map_err(|e| format!("decoder state out '{}' (i32): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::I32(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("decoder state reshape '{}': {}", input_name, e))?,
                        )
                    } else {
                        let (shape, data) = outputs[out_idx]
                            .try_extract_tensor::<f32>()
                            .map_err(|e| format!("decoder state out '{}' (f32): {}", output_name, e))?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        StateTensor::F32(
                            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&dims), data.to_vec())
                                .map_err(|e| format!("decoder state reshape '{}': {}", input_name, e))?,
                        )
                    };
                    self.states.insert(input_name.clone(), new_state);
                }
            }
        }

        Ok(result)
    }

    /// Reset all LSTM states to zeros (call on segment boundary).
    fn reset_states(&mut self, session: &ort::session::Session) {
        for input in session.inputs() {
            let inp_name = input.name().to_string();
            if self.states.contains_key(&inp_name) {
                if let ort::value::ValueType::Tensor { ty, shape, .. } = input.dtype() {
                    let dims: Vec<usize> = shape
                        .iter()
                        .map(|&d| if d <= 0 { 1 } else { d as usize })
                        .collect();
                    let state = if *ty == ort::value::TensorElementType::Int64 {
                        StateTensor::I64(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else if *ty == ort::value::TensorElementType::Int32 {
                        StateTensor::I32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    } else {
                        StateTensor::F32(ndarray::ArrayD::zeros(ndarray::IxDyn(&dims)))
                    };
                    self.states.insert(inp_name, state);
                }
            }
        }
    }
}

/// Joiner input rank metadata, discovered at load time.
///
/// Different transducer models expect different tensor ranks for joiner inputs:
/// - Zipformer: rank 2 `[batch, feature_dim]`
/// - Parakeet TDT: rank 3 `[batch, time=1, feature_dim]`
///
/// This struct stores the expected ranks so `run_joiner()` can adapt dynamically.
struct JoinerInfo {
    /// Expected rank of encoder_outputs input (2 or 3).
    encoder_input_rank: usize,
    /// Expected rank of decoder_outputs input (2 or 3).
    decoder_input_rank: usize,
}

impl JoinerInfo {
    fn discover(session: &ort::session::Session) -> Self {
        let mut enc_rank = 2usize;
        let mut dec_rank = 2usize;
        for input in session.inputs() {
            let name = input.name().to_lowercase();
            if let ort::value::ValueType::Tensor { shape, .. } = input.dtype() {
                let rank = shape.len();
                if name.contains("encoder") {
                    enc_rank = rank;
                } else if name.contains("decoder") {
                    dec_rank = rank;
                }
            }
        }
        Self {
            encoder_input_rank: enc_rank,
            decoder_input_rank: dec_rank,
        }
    }
}

/// Run joiner on encoder frame + decoder output to get logits.
fn run_joiner(
    session: &mut ort::session::Session,
    encoder_frame: &[f32],
    decoder_out: &[f32],
    joiner_info: &JoinerInfo,
) -> Result<Vec<f32>, String> {
    use ort::value::Tensor;

    let enc_dim = encoder_frame.len();
    let dec_dim = decoder_out.len();

    // Adaptive tensor creation: rank 3 [batch, time=1, dim] for Parakeet TDT,
    // rank 2 [batch, dim] for Zipformer — determined by JoinerInfo introspection.
    let enc: ort::session::SessionInputValue<'_> = if joiner_info.encoder_input_rank >= 3 {
        let arr = ndarray::Array3::from_shape_vec((1, 1, enc_dim), encoder_frame.to_vec())
            .map_err(|e| format!("joiner enc shape error (rank 3): {}", e))?;
        Tensor::from_array(arr)
            .map_err(|e| format!("joiner enc tensor: {}", e))?
            .into()
    } else {
        let arr = ndarray::Array2::from_shape_vec((1, enc_dim), encoder_frame.to_vec())
            .map_err(|e| format!("joiner enc shape error (rank 2): {}", e))?;
        Tensor::from_array(arr)
            .map_err(|e| format!("joiner enc tensor: {}", e))?
            .into()
    };

    let dec: ort::session::SessionInputValue<'_> = if joiner_info.decoder_input_rank >= 3 {
        let arr = ndarray::Array3::from_shape_vec((1, 1, dec_dim), decoder_out.to_vec())
            .map_err(|e| format!("joiner dec shape error (rank 3): {}", e))?;
        Tensor::from_array(arr)
            .map_err(|e| format!("joiner dec tensor: {}", e))?
            .into()
    } else {
        let arr = ndarray::Array2::from_shape_vec((1, dec_dim), decoder_out.to_vec())
            .map_err(|e| format!("joiner dec shape error (rank 2): {}", e))?;
        Tensor::from_array(arr)
            .map_err(|e| format!("joiner dec tensor: {}", e))?
            .into()
    };

    let outputs = session
        .run(ort::inputs![enc, dec])
        .map_err(|e| format!("joiner inference failed: {}", e))?;

    let (_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("joiner output extraction failed: {}", e))?;

    Ok(data.to_vec())
}
