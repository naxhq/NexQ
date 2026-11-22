// Static metadata for all downloadable local STT models.
// Supports whisper.cpp, sherpa-onnx, and ort streaming engines.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ModelDefinition {
    pub engine: &'static str,
    pub model_id: &'static str,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub download_url: &'static str,
    pub sha256: &'static str,
    pub accuracy_rating: u8,
    pub speed_rating: u8,
    pub is_streaming: bool,
    pub filename: &'static str,
    /// Whether the download is a .tar.bz2 archive that needs extraction.
    pub is_archive: bool,
}

/// Whisper.cpp GGML models hosted on HuggingFace.
static WHISPER_CPP_MODELS: &[ModelDefinition] = &[
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "tiny",
        display_name: "Whisper Tiny (75 MB)",
        size_bytes: 75_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        sha256: "",
        accuracy_rating: 2,
        speed_rating: 5,
        is_streaming: false,
        filename: "ggml-tiny.bin",
        is_archive: false,
    },
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "base",
        display_name: "Whisper Base (142 MB)",
        size_bytes: 142_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        sha256: "",
        accuracy_rating: 3,
        speed_rating: 4,
        is_streaming: false,
        filename: "ggml-base.bin",
        is_archive: false,
    },
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "small",
        display_name: "Whisper Small (488 MB)",
        size_bytes: 488_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 3,
        is_streaming: false,
        filename: "ggml-small.bin",
        is_archive: false,
    },
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "medium",
        display_name: "Whisper Medium (1.5 GB)",
        size_bytes: 1_500_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 2,
        is_streaming: false,
        filename: "ggml-medium.bin",
        is_archive: false,
    },
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "distil-large-v3",
        display_name: "Distil Whisper Large v3 (809 MB, fast+accurate)",
        size_bytes: 809_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-distil-large-v3.bin",
        sha256: "",
        accuracy_rating: 5,
        speed_rating: 3,
        is_streaming: false,
        filename: "ggml-distil-large-v3.bin",
        is_archive: false,
    },
    ModelDefinition {
        engine: "whisper_cpp",
        model_id: "large-v3-turbo",
        display_name: "Whisper Large v3 Turbo (1.6 GB, best accuracy)",
        size_bytes: 1_600_000_000,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        sha256: "",
        accuracy_rating: 5,
        speed_rating: 2,
        is_streaming: false,
        filename: "ggml-large-v3-turbo.bin",
        is_archive: false,
    },
];

/// Sherpa-ONNX streaming transducer models.
/// Uses in-process ONNX Runtime (same engine as ORT Streaming) — no separate binary needed.
/// Note: "20M" in model names = 20 million parameters, NOT 20 megabytes.
/// size_bytes values are the actual download sizes (tar.bz2 archive).
static SHERPA_ONNX_MODELS: &[ModelDefinition] = &[
    ModelDefinition {
        engine: "sherpa_onnx",
        model_id: "streaming-zipformer-en-20M",
        display_name: "English Small (20M params, fastest)",
        size_bytes: 310_414_022, // actual: 296 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2",
        sha256: "",
        accuracy_rating: 3,
        speed_rating: 5,
        is_streaming: true,
        filename: "sherpa-onnx-streaming-zipformer-en-2023-06-26",
        is_archive: true,
    },
    ModelDefinition {
        engine: "sherpa_onnx",
        model_id: "streaming-zipformer-en-compact",
        display_name: "English Compact (20M params, balanced)",
        size_bytes: 127_887_156, // actual: 122 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 4,
        is_streaming: true,
        filename: "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
        is_archive: true,
    },
    ModelDefinition {
        engine: "sherpa_onnx",
        model_id: "streaming-zipformer-multi",
        display_name: "Chinese/Multilingual (zh-hans, NOT English)",
        size_bytes: 310_380_628, // actual: 296 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12.tar.bz2",
        sha256: "",
        accuracy_rating: 3,
        speed_rating: 3,
        is_streaming: true,
        filename: "sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12",
        is_archive: true,
    },
    ModelDefinition {
        engine: "sherpa_onnx",
        model_id: "sense-voice-small",
        display_name: "SenseVoice Small (Multilingual, ~200 MB, <80ms)",
        size_bytes: 227_000_000, // actual: ~217 MB compressed
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 5,
        is_streaming: false,
        filename: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        is_archive: true,
    },
];

/// ORT Streaming: same ONNX model files, loaded in-process via ort crate.
/// size_bytes values are the actual download sizes (tar.bz2 archive).
static ORT_STREAMING_MODELS: &[ModelDefinition] = &[
    ModelDefinition {
        engine: "ort_streaming",
        model_id: "zipformer-en-20M",
        display_name: "Zipformer English (20M params, GPU-accel)",
        size_bytes: 310_414_022, // actual: 296 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2",
        sha256: "",
        accuracy_rating: 3,
        speed_rating: 5,
        is_streaming: true,
        filename: "sherpa-onnx-streaming-zipformer-en-2023-06-26",
        is_archive: true,
    },
    ModelDefinition {
        engine: "ort_streaming",
        model_id: "zipformer-en-compact",
        display_name: "Zipformer English (20M params, compact)",
        size_bytes: 127_887_156, // actual: 122 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 4,
        is_streaming: true,
        filename: "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
        is_archive: true,
    },
];

/// NVIDIA Parakeet TDT models — CTC/TDT architecture, ONNX format.
/// #1 on Open ASR Leaderboard (~6% WER).
static PARAKEET_TDT_MODELS: &[ModelDefinition] = &[
    ModelDefinition {
        engine: "parakeet_tdt",
        model_id: "parakeet-tdt-0.6b-v3-int8",
        display_name: "Parakeet TDT 0.6B v3 (int8, best accuracy)",
        size_bytes: 487_587_840, // 465 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        sha256: "",
        accuracy_rating: 5,
        speed_rating: 3,
        is_streaming: false,
        filename: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        is_archive: true,
    },
    ModelDefinition {
        engine: "parakeet_tdt",
        model_id: "parakeet-tdt-ctc-110m-int8",
        display_name: "Parakeet CTC 110M (int8, fast & lightweight)",
        size_bytes: 104_857_600, // 100 MB
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2",
        sha256: "",
        accuracy_rating: 4,
        speed_rating: 5,
        is_streaming: false,
        filename: "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8",
        is_archive: true,
    },
];

/// Get all model definitions for a given engine.
pub fn get_models_for_engine(engine: &str) -> &'static [ModelDefinition] {
    match engine {
        "whisper_cpp" => WHISPER_CPP_MODELS,
        "sherpa_onnx" => SHERPA_ONNX_MODELS,
        "ort_streaming" => ORT_STREAMING_MODELS,
        "parakeet_tdt" => PARAKEET_TDT_MODELS,
        _ => &[],
    }
}

/// Get a specific model definition by engine and model_id.
pub fn get_model(engine: &str, model_id: &str) -> Option<&'static ModelDefinition> {
    get_models_for_engine(engine)
        .iter()
        .find(|m| m.model_id == model_id)
}

/// Engine metadata for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct EngineInfo {
    pub engine: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

/// Get all available engine metadata.
pub fn get_engines() -> Vec<EngineInfo> {
    vec![
        EngineInfo {
            engine: "whisper_cpp",
            name: "Whisper.cpp",
            description: "OpenAI Whisper running locally via whisper.cpp. High accuracy, offline, free.",
        },
        EngineInfo {
            engine: "sherpa_onnx",
            name: "Sherpa-ONNX",
            description: "Streaming transducer (Zipformer) runs in-process; SenseVoice runs through the sherpa-onnx-offline program. Multilingual. Fully offline, free.",
        },
        EngineInfo {
            engine: "ort_streaming",
            name: "ORT Streaming",
            description: "ONNX Runtime in-process streaming. Zero IPC overhead, GPU-accelerated. For advanced users.",
        },
        EngineInfo {
            engine: "parakeet_tdt",
            name: "Parakeet TDT",
            description: "NVIDIA Parakeet TDT 0.6B — #1 on Open ASR Leaderboard (~6% WER). CTC/TDT architecture via ONNX Runtime.",
        },
    ]
}
