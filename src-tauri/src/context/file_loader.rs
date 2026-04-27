use std::fs;
use std::path::Path;

/// Load a text file (.txt or .md) and return its contents as a String.
/// Tries UTF-8 first (stripping BOM if present), then falls back to Windows-1252.
pub fn load_text_file(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);

    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if extension != "txt" && extension != "md" {
        return Err(format!(
            "Unsupported text file type: .{}. Expected .txt or .md",
            extension
        ));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Strip UTF-8 BOM if present (EF BB BF)
    let payload = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes
    };

    // Try UTF-8 first
    if let Ok(text) = std::str::from_utf8(payload) {
        return Ok(text.to_string());
    }

    // Fallback: Windows-1252 (covers Latin-1 and most Western European encodings)
    log::warn!(
        "File '{}' is not valid UTF-8 — decoding as Windows-1252",
        file_path
    );
    let (text, _, had_errors) = encoding_rs::WINDOWS_1252.decode(payload);
    if had_errors {
        log::warn!(
            "Some characters in '{}' could not be decoded and were replaced",
            file_path
        );
    }
    Ok(text.into_owned())
}
