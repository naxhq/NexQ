// HTTP download with streaming progress and SHA256 verification.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub engine: String,
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub status: String, // "downloading" | "verifying" | "complete" | "error" | "cancelled"
}

/// Download a file with progress reporting and optional SHA256 verification.
pub async fn download_file(
    url: &str,
    dest: &Path,
    sha256_expected: &str,
    engine: &str,
    model_id: &str,
    cancel_flag: Arc<AtomicBool>,
    app_handle: AppHandle,
) -> Result<(), String> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    log::info!("Starting download: {} -> {}", url, dest.display());

    let emit = |downloaded: u64, total: u64, status: &str| {
        let percent = if total > 0 {
            (downloaded as f32 / total as f32) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "model_download_progress",
            &DownloadProgress {
                engine: engine.to_string(),
                model_id: model_id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent,
                status: status.to_string(),
            },
        );
    };

    // Start the HTTP request
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        emit(0, 0, "error");
        return Err(format!("Download failed with HTTP {}", status));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();

    // Write to a temp file first, rename on success
    let tmp_path = dest.with_extension("download");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    emit(0, total_size, "downloading");

    while let Some(chunk_result) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_path).await;
            emit(downloaded, total_size, "cancelled");
            return Err("Download cancelled".to_string());
        }

        let chunk = chunk_result.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write to file: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        // Emit progress every ~100 KB to avoid flooding
        if downloaded % 102_400 < chunk.len() as u64 || downloaded == total_size {
            emit(downloaded, total_size, "downloading");
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    drop(file);

    // Verify SHA256 if a hash is provided
    if !sha256_expected.is_empty() {
        emit(downloaded, total_size, "verifying");
        let hash = hex(&hasher.finalize());
        if hash != sha256_expected {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            emit(downloaded, total_size, "error");
            return Err(format!(
                "SHA256 mismatch: expected {}, got {}",
                sha256_expected, hash
            ));
        }
        log::info!("SHA256 verification passed");
    }

    // Rename temp file to final destination
    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Failed to rename temp file: {}", e))?;

    // NOTE: We intentionally do NOT emit "complete" here.
    // The caller (ModelManager::download_model) handles the final status
    // because archive models need extraction before they're truly complete.
    log::info!(
        "Download complete: {} ({} bytes)",
        dest.display(),
        downloaded
    );

    Ok(())
}

/// Extract a .tar.bz2 archive into a destination directory.
/// Returns the path to the top-level extracted directory.
pub fn extract_tar_bz2(archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use bzip2::read::BzDecoder;
    use std::fs::File;

    log::info!(
        "Extracting archive: {} -> {}",
        archive_path.display(),
        dest_dir.display()
    );

    let file = File::open(archive_path)
        .map_err(|e| format!("Failed to open archive: {}", e))?;
    let decoder = BzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);

    archive
        .unpack(dest_dir)
        .map_err(|e| format!("Failed to extract archive: {}", e))?;

    // Find the extracted top-level directory by scanning dest_dir.
    // tar.bz2 archives from sherpa-onnx always have a single top-level directory
    // whose name matches the model filename in the registry.
    let mut extracted_dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dest_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    extracted_dirs.push(path);
                }
            }
        }
    }

    // If there's exactly one non-hidden directory, that's the extracted model dir
    if extracted_dirs.len() == 1 {
        log::info!("Extracted to: {}", extracted_dirs[0].display());
        return Ok(extracted_dirs[0].clone());
    }

    log::info!(
        "Extracted {} items to {}",
        extracted_dirs.len(),
        dest_dir.display()
    );
    Ok(dest_dir.to_path_buf())
}

/// Lowercase hex of a digest (sha2 0.11's output type has no `{:x}`).
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn sha256_hex_matches_the_standard_test_vector() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
