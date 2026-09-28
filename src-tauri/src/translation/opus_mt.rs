// OPUS-MT local translation provider with ONNX inference.
// Uses ort (ONNX Runtime) for encoder-decoder inference and the
// tokenizers crate for SentencePiece tokenization.
//
// Model loading is LAZY: the ONNX sessions are loaded on the first
// translate() call, NOT during set_provider(). This prevents panics
// from poisoning the TranslationRouter's Mutex.

use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use super::*;
use super::opus_mt_registry;

/// A loaded ONNX model ready for translation.
struct LoadedModel {
    encoder: ort::session::Session,
    decoder: ort::session::Session,
    tokenizer: tokenizers::Tokenizer,
    eos_token_id: i64,
    decoder_start_token_id: i64,
    /// Language token prefix for multilingual models (e.g. ">>pes<<").
    target_prefix: String,
    /// Decoder input names that require past_key_values (empty tensors for no-cache mode).
    /// Discovered at load time by inspecting session.inputs().
    past_kv_names: Vec<String>,
    /// Number of attention heads (from config.json or input shape).
    num_heads: usize,
    /// Dimension per head (d_model / num_heads).
    head_dim: usize,
    /// Whether the decoder expects a use_cache_branch input.
    has_use_cache_branch: bool,
}

pub struct OpusMtTranslator {
    models_dir: Option<PathBuf>,
    /// The model ID that SHOULD be loaded (set by activation).
    active_model_id: Option<String>,
    /// Currently loaded model — behind a std::sync::Mutex for interior mutability.
    /// translate() can lazy-load without needing &mut self.
    loaded: StdMutex<Option<(String, LoadedModel)>>,
}

// Safety: LoadedModel contains ort::Session which is Send+Sync in ort v2.
// The Mutex provides thread-safe access.
unsafe impl Send for OpusMtTranslator {}
unsafe impl Sync for OpusMtTranslator {}

impl OpusMtTranslator {
    pub fn new() -> Self {
        Self {
            models_dir: None,
            active_model_id: None,
            loaded: StdMutex::new(None),
        }
    }

    pub fn set_models_dir(&mut self, path: PathBuf) {
        self.models_dir = Some(path);
    }

    pub fn set_active_model_id(&mut self, model_id: Option<String>) {
        self.active_model_id = model_id;
    }

}

// ── Model loading (runs on a blocking thread, NOT in async context) ──

/// Load the ONNX model if not already loaded. Must run on a blocking thread.
fn ensure_loaded_blocking(
    loaded: &StdMutex<Option<(String, LoadedModel)>>,
    models_dir: &Option<PathBuf>,
    active_model_id: Option<&str>,
) -> Result<(), String> {
    let model_id = active_model_id
        .ok_or("No OPUS-MT model activated. Activate a model in Settings → Translation.")?;

    // Check if already loaded
    {
        let guard = loaded.lock().map_err(|_| "Model lock error".to_string())?;
        if let Some((loaded_id, _)) = guard.as_ref() {
            if loaded_id == model_id {
                return Ok(());
            }
        }
    }

    let models_dir = models_dir.as_ref()
        .ok_or("OPUS-MT models directory not configured")?;

    let model_dir = models_dir.join(model_id);
    let encoder_path = model_dir.join("encoder_model.onnx");
    let decoder_path = model_dir.join("decoder_model_merged.onnx");
    let tokenizer_path = model_dir.join("tokenizer.json");

    if !encoder_path.exists() || !decoder_path.exists() || !tokenizer_path.exists() {
        return Err(format!("Model files missing in {}", model_dir.display()));
    }

    log::info!("Loading OPUS-MT encoder: {}", encoder_path.display());
    let encoder = load_onnx_session(&encoder_path)?;
    log_session_io("Encoder", &encoder);

    log::info!("Loading OPUS-MT decoder: {}", decoder_path.display());
    let decoder = load_onnx_session(&decoder_path)?;
    log_session_io("Decoder", &decoder);

    // Discover decoder inputs: find past_key_values and use_cache_branch
    let mut past_kv_names = Vec::new();
    let mut has_use_cache_branch = false;
    for input in decoder.inputs() {
        let name = input.name().to_string();
        if name.contains("past_key_values") {
            past_kv_names.push(name);
        } else if name == "use_cache_branch" {
            has_use_cache_branch = true;
        }
    }
    log::info!("Decoder past_kv inputs: {} found, use_cache_branch: {}", past_kv_names.len(), has_use_cache_branch);

    // Read model config for attention dimensions
    let config_path = model_dir.join("config.json");
    let (num_heads, head_dim) = read_model_config(&config_path);

    log::info!("Loading OPUS-MT tokenizer: {}", tokenizer_path.display());
    let tokenizer = load_tokenizer(&tokenizer_path)?;

    let (eos_token_id, decoder_start_token_id) = extract_special_tokens(&tokenizer);

    // Get target_prefix from registry (for multilingual models like en-iir)
    let target_prefix = opus_mt_registry::get_model(model_id)
        .map(|d| d.target_prefix.to_string())
        .unwrap_or_default();

    log::info!("OPUS-MT model ready: {} (eos={}, dec_start={}, prefix={:?}, heads={}, head_dim={})",
        model_id, eos_token_id, decoder_start_token_id, target_prefix, num_heads, head_dim);

    let mut guard = loaded.lock().map_err(|_| "Model lock error".to_string())?;
    *guard = Some((model_id.to_string(), LoadedModel {
        encoder, decoder, tokenizer, eos_token_id, decoder_start_token_id,
        target_prefix, past_kv_names, num_heads, head_dim, has_use_cache_branch,
    }));

    Ok(())
}

#[async_trait]
impl TranslationProvider for OpusMtTranslator {
    fn provider_name(&self) -> &str { "OPUS-MT (Local)" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::OpusMt }
    fn is_local(&self) -> bool { true }

    async fn translate(
        &self,
        text: &str,
        _source: Option<&str>,
        _target: &str,
    ) -> Result<String, TranslationError> {
        let text_owned = text.to_string();
        let models_dir = self.models_dir.clone();
        let active_model_id = self.active_model_id.clone();

        // Safety: the OpusMtTranslator lives behind an Arc in the router,
        // and we await the spawn_blocking result before returning.
        let loaded_ptr = &self.loaded as *const StdMutex<Option<(String, LoadedModel)>>;
        let loaded_ref = unsafe { &*loaded_ptr };

        // ALL heavy work (model loading + inference) runs in a blocking thread.
        // ORT's native C++ code can crash if called from a tokio async context.
        let result = tokio::task::spawn_blocking(move || {
            // Lazy-load model if needed (inside blocking thread, safe for ORT)
            ensure_loaded_blocking(loaded_ref, &models_dir, active_model_id.as_deref())?;

            let mut guard = loaded_ref.lock()
                .map_err(|_| "Model lock error during inference".to_string())?;
            let (_, model) = guard.as_mut()
                .ok_or_else(|| "Model unloaded during inference".to_string())?;
            translate_blocking(&text_owned, model)
        })
        .await
        .map_err(|e| TranslationError::Failed(format!("Inference task failed: {}", e)))?
        .map_err(|e| TranslationError::Failed(e))?;

        Ok(result)
    }

    async fn detect_language(&self, _text: &str) -> Result<DetectedLanguage, TranslationError> {
        Err(TranslationError::NotConfigured(
            "Language detection requires a cloud provider".into(),
        ))
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        let mut langs: Vec<Language> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for model in opus_mt_registry::all_models() {
            if seen.insert(model.source_lang) {
                langs.push(Language {
                    code: model.source_lang.into(),
                    name: model.source_name.into(),
                    native_name: None,
                });
            }
            if seen.insert(model.target_lang) {
                langs.push(Language {
                    code: model.target_lang.into(),
                    name: model.target_name.into(),
                    native_name: None,
                });
            }
        }

        langs.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(langs)
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        let Some(dir) = &self.models_dir else {
            return Ok(ConnectionStatus {
                connected: false,
                language_count: 0,
                response_ms: 0,
                error: Some("Models directory not configured".into()),
            });
        };

        if !dir.exists() {
            return Ok(ConnectionStatus {
                connected: false,
                language_count: 0,
                response_ms: 0,
                error: Some("Models directory not found".into()),
            });
        }

        let model_count = opus_mt_registry::all_models()
            .iter()
            .filter(|m| {
                let model_dir = dir.join(m.model_id);
                model_dir.join("encoder_model.onnx").exists()
                    && model_dir.join("decoder_model_merged.onnx").exists()
                    && model_dir.join("tokenizer.json").exists()
            })
            .count();

        if model_count == 0 {
            return Ok(ConnectionStatus {
                connected: false,
                language_count: 0,
                response_ms: 0,
                error: Some("No models downloaded".into()),
            });
        }

        let has_loaded = self.loaded.lock()
            .map(|g| g.is_some())
            .unwrap_or(false);

        Ok(ConnectionStatus {
            connected: has_loaded || self.active_model_id.is_some(),
            language_count: model_count,
            response_ms: 0,
            error: None,
        })
    }
}

// ── ONNX inference helpers ──

fn load_onnx_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
    crate::ort_runtime::ensure_loaded()?;
    ort::session::Session::builder()
        .map_err(|e| format!("Failed to create session builder: {}", e))?
        .with_intra_threads(4)
        .map_err(|e| format!("Failed to set thread count: {}", e))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load ONNX model {}: {}", path.display(), e))
}

fn log_session_io(name: &str, session: &ort::session::Session) {
    let inputs: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();
    let outputs: Vec<String> = session.outputs().iter().map(|o| o.name().to_string()).collect();
    log::info!("{} inputs: {:?}", name, inputs);
    log::info!("{} outputs: {:?}", name, outputs);
}

/// Load tokenizer from file, patching known incompatibilities.
/// Xenova MarianMT exports have `normalizer: { "type": "Precompiled", "precompiled_charsmap": null }`
/// which the tokenizers crate rejects. We strip the null normalizer before loading.
fn load_tokenizer(path: &std::path::Path) -> Result<tokenizers::Tokenizer, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read tokenizer: {}", e))?;

    let mut json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse tokenizer JSON: {}", e))?;

    // Patch: remove normalizer if its precompiled_charsmap is null
    if let Some(norm) = json.get("normalizer") {
        if norm.get("precompiled_charsmap") == Some(&serde_json::Value::Null) {
            json["normalizer"] = serde_json::Value::Null;
            log::info!("Patched tokenizer: removed null precompiled_charsmap normalizer");
        }
    }

    let patched = serde_json::to_string(&json)
        .map_err(|e| format!("Failed to serialize patched tokenizer: {}", e))?;

    tokenizers::Tokenizer::from_bytes(patched.as_bytes())
        .map_err(|e| format!("Tokenizer load failed: {}", e))
}

/// Read num_heads and head_dim from config.json. Falls back to MarianMT defaults.
fn read_model_config(config_path: &std::path::Path) -> (usize, usize) {
    if let Ok(raw) = std::fs::read_to_string(config_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let d_model = json.get("d_model").and_then(|v| v.as_u64()).unwrap_or(512) as usize;
            let num_heads = json.get("decoder_attention_heads").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
            let head_dim = if num_heads > 0 { d_model / num_heads } else { 64 };
            return (num_heads, head_dim);
        }
    }
    (8, 64) // MarianMT defaults
}

fn extract_special_tokens(tokenizer: &tokenizers::Tokenizer) -> (i64, i64) {
    let eos_id = tokenizer
        .token_to_id("</s>")
        .map(|id| id as i64)
        .unwrap_or(0);

    let pad_id = tokenizer
        .token_to_id("<pad>")
        .map(|id| id as i64)
        .unwrap_or(eos_id);

    (eos_id, pad_id)
}

/// Run the full encoder-decoder translation on the current thread.
fn translate_blocking(text: &str, model: &mut LoadedModel) -> Result<String, String> {
    use ndarray::{Array2, ArrayD, IxDyn};

    // 1. Tokenize input (prepend language token for multilingual models)
    let input_text = if model.target_prefix.is_empty() {
        text.to_string()
    } else {
        format!("{} {}", model.target_prefix, text)
    };

    let encoding = model
        .tokenizer
        .encode(input_text.as_str(), true)
        .map_err(|e| format!("Tokenization failed: {}", e))?;

    let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let seq_len = input_ids.len();

    if seq_len == 0 {
        return Ok(String::new());
    }

    let input_ids_arr = Array2::from_shape_vec((1, seq_len), input_ids.clone())
        .map_err(|e| format!("Input tensor error: {}", e))?;

    let attention_mask_arr = Array2::from_shape_vec(
        (1, seq_len),
        vec![1i64; seq_len],
    )
    .map_err(|e| format!("Attention mask error: {}", e))?;

    // 2. Run encoder
    let enc_ids_tensor = ort::value::Tensor::from_array(input_ids_arr.clone())
        .map_err(|e| format!("Encoder input_ids tensor: {}", e))?;
    let enc_mask_tensor = ort::value::Tensor::from_array(attention_mask_arr.clone())
        .map_err(|e| format!("Encoder attention_mask tensor: {}", e))?;

    let encoder_inputs: Vec<(
        std::borrow::Cow<'_, str>,
        ort::session::SessionInputValue<'_>,
    )> = vec![
        ("input_ids".into(), enc_ids_tensor.into()),
        ("attention_mask".into(), enc_mask_tensor.into()),
    ];

    let encoder_outputs = model
        .encoder
        .run(encoder_inputs)
        .map_err(|e| format!("Encoder inference failed: {}", e))?;

    let (enc_shape, enc_data) = encoder_outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Failed to extract encoder output: {}", e))?;

    let enc_dims: Vec<usize> = enc_shape.iter().map(|&d| d as usize).collect();
    let encoder_hidden = ArrayD::from_shape_vec(IxDyn(&enc_dims), enc_data.to_vec())
        .map_err(|e| format!("Encoder output reshape: {}", e))?;

    // 3. Greedy decode loop
    let max_new_tokens = 512;
    let mut decoder_input_ids: Vec<i64> = vec![model.decoder_start_token_id];

    for _step in 0..max_new_tokens {
        let dec_len = decoder_input_ids.len();
        let dec_ids_arr = Array2::from_shape_vec(
            (1, dec_len),
            decoder_input_ids.clone(),
        )
        .map_err(|e| format!("Decoder input error: {}", e))?;

        let dec_ids_tensor = ort::value::Tensor::from_array(dec_ids_arr)
            .map_err(|e| format!("Decoder input_ids tensor: {}", e))?;
        let dec_mask_tensor = ort::value::Tensor::from_array(attention_mask_arr.clone())
            .map_err(|e| format!("Decoder attention_mask tensor: {}", e))?;
        let dec_hidden_tensor = ort::value::Tensor::from_array(encoder_hidden.clone())
            .map_err(|e| format!("Decoder hidden_states tensor: {}", e))?;

        let mut decoder_inputs: Vec<(
            std::borrow::Cow<'_, str>,
            ort::session::SessionInputValue<'_>,
        )> = vec![
            ("input_ids".into(), dec_ids_tensor.into()),
            ("encoder_attention_mask".into(), dec_mask_tensor.into()),
            ("encoder_hidden_states".into(), dec_hidden_tensor.into()),
        ];

        // Merged decoder: provide use_cache_branch=false and empty past_key_values
        if model.has_use_cache_branch {
            let cache_flag = ndarray::Array1::from_vec(vec![false]);
            let cache_tensor = ort::value::Tensor::from_array(cache_flag)
                .map_err(|e| format!("use_cache_branch tensor: {}", e))?;
            decoder_inputs.push(("use_cache_branch".into(), cache_tensor.into()));
        }

        // Provide empty past_key_values tensors (shape [1, num_heads, 0, head_dim])
        let empty_kv_vecs: Vec<ndarray::ArrayD<f32>> = model.past_kv_names.iter().map(|_| {
            ndarray::ArrayD::zeros(ndarray::IxDyn(&[1, model.num_heads, 0, model.head_dim]))
        }).collect();

        for (name, arr) in model.past_kv_names.iter().zip(empty_kv_vecs.into_iter()) {
            let tensor = ort::value::Tensor::from_array(arr)
                .map_err(|e| format!("past_kv tensor '{}': {}", name, e))?;
            decoder_inputs.push((name.clone().into(), tensor.into()));
        }

        let decoder_outputs = model
            .decoder
            .run(decoder_inputs)
            .map_err(|e| format!("Decoder inference failed: {}", e))?;

        let (logits_shape, logits_data) = decoder_outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract decoder output: {}", e))?;

        let logits_dims: Vec<usize> = logits_shape.iter().map(|&d| d as usize).collect();
        let vocab_size = logits_dims.last().copied().unwrap_or(0);
        let last_pos = dec_len - 1;

        let offset = last_pos * vocab_size;
        let mut max_val = f32::NEG_INFINITY;
        let mut max_idx: i64 = 0;
        for i in 0..vocab_size {
            let val = logits_data[offset + i];
            if val > max_val {
                max_val = val;
                max_idx = i as i64;
            }
        }

        if max_idx == model.eos_token_id {
            break;
        }

        decoder_input_ids.push(max_idx);
    }

    // 4. Decode output tokens (skip the start token)
    let output_tokens: Vec<u32> = decoder_input_ids[1..]
        .iter()
        .map(|&id| id as u32)
        .collect();

    let decoded = model
        .tokenizer
        .decode(&output_tokens, true)
        .map_err(|e| format!("Decoding failed: {}", e))?;

    Ok(decoded.trim().to_string())
}
