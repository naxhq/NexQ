use std::path::Path;

/// Extract text content from a PDF file.
/// Returns the extracted text, or an empty string with a warning log on failure.
pub fn extract_text_from_pdf(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);

    if !path.exists() {
        return Err(format!("PDF file not found: {}", file_path));
    }

    match pdf_extract::extract_text(path) {
        Ok(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                log::warn!(
                    "PDF extraction returned empty text for: {}",
                    file_path
                );
            }
            Ok(trimmed)
        }
        Err(e) => {
            Err(format!("Failed to extract text from PDF: {}", e))
        }
    }
}
