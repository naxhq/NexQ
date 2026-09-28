//! Lazy loading of the bundled ONNX Runtime (`onnxruntime.dll`).
//!
//! `ort` is built with `load-dynamic`: no ONNX Runtime code is linked into nexq.exe.
//! The official Microsoft DLL (staged by `scripts/fetch-onnxruntime.mjs` and bundled
//! next to the executable) is loaded the first time a local ONNX model is used.
//! The previously linked static build contained BMI2/AVX2 code that crashed the app
//! at launch on CPUs without those extensions (issue #6).

use std::sync::OnceLock;

/// Load `onnxruntime.dll` from the executable's directory. Must be called before any
/// other `ort` API. Safe to call repeatedly; the outcome of the first call is cached.
pub fn ensure_loaded() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        // Absolute path on purpose: Windows 11 ships an older onnxruntime.dll in System32.
        let dll = std::env::current_exe()
            .map_err(|e| format!("Cannot locate executable: {}", e))?
            .parent()
            .ok_or("Executable has no parent directory")?
            .join("onnxruntime.dll");
        if !dll.exists() {
            return Err(format!(
                "ONNX Runtime not found at {} — reinstall NexQ to restore it",
                dll.display()
            ));
        }
        ort::init_from(&dll)
            .map_err(|e| format!("Failed to load ONNX Runtime from {}: {}", dll.display(), e))?
            .commit();
        log::info!("ONNX Runtime loaded from {}", dll.display());
        Ok(())
    })
    .clone()
}
