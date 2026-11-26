use crate::context::{file_loader, pdf_extractor};

/// Extract text from a file based on its type.
///
/// Dispatches to the appropriate extractor:
/// - "pdf" → `pdf_extractor::extract_text_from_pdf`
/// - "txt" or "md" → `file_loader::load_text_file`
/// - "docx" → `extract_docx_text` (simple XML parsing of OOXML)
pub fn extract_text(file_path: &str, file_type: &str) -> Result<String, String> {
    match file_type.to_lowercase().as_str() {
        "pdf" => pdf_extractor::extract_text_from_pdf(file_path),
        "txt" | "md" | "note" => file_loader::load_text_file(file_path),
        "docx" => extract_docx_text(file_path),
        other => Err(format!(
            "Unsupported file type for text extraction: {}",
            other
        )),
    }
}

/// Extract text from a DOCX (Office Open XML) file.
///
/// Opens the file as a ZIP archive, reads `word/document.xml`,
/// and extracts text content from `<w:t>` elements using simple
/// string parsing (no full XML parser dependency).
pub fn extract_docx_text(file_path: &str) -> Result<String, String> {
    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open DOCX file '{}': {}", file_path, e))?;
    docx_from_reader(file)
}

/// Longest `word/document.xml` we unpack (bytes).
pub const MAX_DOCX_XML: u64 = 16 * 1024 * 1024;
/// Most entries a DOCX archive may hold.
pub const MAX_DOCX_ENTRIES: usize = 4000;
/// Largest believable compression ratio of the document part.
const MAX_DOCX_RATIO: u64 = 400;

/// Extract text from DOCX bytes, with bounds against zip bombs: entry count,
/// the declared size and ratio of the document part, and a hard cap on what
/// is actually read from it.
pub fn extract_docx_text_bytes(bytes: &[u8]) -> Result<String, String> {
    docx_from_reader(std::io::Cursor::new(bytes))
}

fn docx_from_reader<R: std::io::Read + std::io::Seek>(reader: R) -> Result<String, String> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Failed to read DOCX as ZIP archive: {}", e))?;
    if archive.len() > MAX_DOCX_ENTRIES {
        return Err("This Word file has too many parts".to_string());
    }
    let document_xml = archive
        .by_name("word/document.xml")
        .map_err(|e| format!("DOCX missing word/document.xml: {}", e))?;
    let (size, packed) = (document_xml.size(), document_xml.compressed_size().max(1));
    if size > MAX_DOCX_XML || (size > 1024 * 1024 && size / packed > MAX_DOCX_RATIO) {
        return Err("This Word file expands to too much data".to_string());
    }
    let mut raw = Vec::new();
    document_xml
        .take(MAX_DOCX_XML + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("Failed to read document.xml: {}", e))?;
    if raw.len() as u64 > MAX_DOCX_XML {
        return Err("This Word file expands to too much data".to_string());
    }
    let xml_content = String::from_utf8_lossy(&raw);
    Ok(parse_docx_xml(&xml_content))
}

/// Parse text content from DOCX XML by extracting `<w:t>` element text.
///
/// Uses simple string splitting rather than a full XML parser:
/// 1. Split on '<' to get tag fragments
/// 2. Look for fragments starting with "w:t>" or "w:t " (the w:t element)
/// 3. Extract the text content after the '>'
/// 4. Track `<w:p>` (paragraph) boundaries to insert newlines
fn parse_docx_xml(xml: &str) -> String {
    let mut result = String::new();
    let mut in_paragraph = false;

    // Split on '<' to get tag-like fragments
    for fragment in xml.split('<') {
        if fragment.is_empty() {
            continue;
        }

        // Check for paragraph start: "w:p " or "w:p>"
        if fragment.starts_with("w:p>") || fragment.starts_with("w:p ") {
            if in_paragraph && !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            in_paragraph = true;
            continue;
        }

        // Check for paragraph end: "/w:p>"
        if fragment.starts_with("/w:p>") {
            if in_paragraph && !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            in_paragraph = false;
            continue;
        }

        // Check for text element: "w:t>" or "w:t " (with attributes like xml:space)
        if fragment.starts_with("w:t>") || fragment.starts_with("w:t ") {
            // Extract text after the closing '>'
            if let Some(pos) = fragment.find('>') {
                let text = &fragment[pos + 1..];
                result.push_str(text);
            }
        }
    }

    let trimmed = result.trim().to_string();

    // Clean up excessive blank lines (collapse multiple newlines to double)
    let mut cleaned = String::with_capacity(trimmed.len());
    let mut prev_newline_count = 0;
    for ch in trimmed.chars() {
        if ch == '\n' {
            prev_newline_count += 1;
            if prev_newline_count <= 2 {
                cleaned.push(ch);
            }
        } else {
            prev_newline_count = 0;
            cleaned.push(ch);
        }
    }

    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_docx_xml_simple() {
        let xml = r#"<w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("Hello World"));
    }

    #[test]
    fn test_parse_docx_xml_multiple_paragraphs() {
        let xml = r#"<w:body><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("First"));
        assert!(text.contains("Second"));
        // Paragraphs should be separated by newlines
        assert!(text.contains('\n'));
    }

    #[test]
    fn test_parse_docx_xml_with_attributes() {
        let xml = r#"<w:p><w:r><w:t xml:space="preserve"> spaced text </w:t></w:r></w:p>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("spaced text"));
    }

    #[test]
    fn test_parse_docx_xml_empty() {
        let text = parse_docx_xml("");
        assert!(text.is_empty());
    }

    #[test]
    fn test_extract_docx_text_from_a_deflated_archive() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("nexq-docx-{}.docx", std::process::id()));
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("word/document.xml", options).unwrap();
            zip.write_all(br#"<w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p></w:body>"#).unwrap();
            zip.finish().unwrap();
        }
        let text = extract_docx_text(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(text.unwrap().contains("Quarterly plan"));
    }

    #[test]
    fn test_extract_text_unsupported() {
        let result = extract_text("test.xyz", "xyz");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported"));
    }

    fn zip_of(entry: &str, body: &[u8], count: usize) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file(entry, options).unwrap();
            zip.write_all(body).unwrap();
            for i in 0..count {
                zip.start_file(format!("extra/{i}.txt"), options).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn docx_bytes_roundtrip_and_bombs_are_rejected() {
        let ok = zip_of("word/document.xml", br#"<w:p><w:r><w:t>Hello plan</w:t></w:r></w:p>"#, 0);
        assert!(extract_docx_text_bytes(&ok).unwrap().contains("Hello plan"));
        // 40 MB of one repeated byte packs to a few dozen KB: past the ratio and size limits
        let bomb = zip_of("word/document.xml", &vec![b'a'; 40 * 1024 * 1024], 0);
        assert!(bomb.len() < 200_000, "{}", bomb.len());
        assert!(extract_docx_text_bytes(&bomb).unwrap_err().contains("too much"));
        let many = zip_of("word/document.xml", b"<w:t>x</w:t>", MAX_DOCX_ENTRIES + 5);
        assert!(extract_docx_text_bytes(&many).unwrap_err().contains("too many"));
        assert!(extract_docx_text_bytes(b"PK\x03\x04 junk").is_err());
    }
}
