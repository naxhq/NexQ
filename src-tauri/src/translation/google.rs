// src-tauri/src/translation/google.rs
use super::*;
use std::time::Instant;

const BASE_URL: &str = "https://translation.googleapis.com/language/translate/v2";

pub struct GoogleTranslator {
    client: reqwest::Client,
    api_key: String,
}

impl GoogleTranslator {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
        }
    }
}

// ── Internal response shapes ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TranslateResponse {
    data: TranslateData,
}

#[derive(Deserialize)]
struct TranslateData {
    translations: Vec<TranslationItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationItem {
    translated_text: String,
    #[serde(default)]
    #[allow(dead_code)]
    detected_source_language: Option<String>,
}

#[derive(Deserialize)]
struct DetectResponse {
    data: DetectData,
}

#[derive(Deserialize)]
struct DetectData {
    detections: Vec<Vec<DetectionItem>>,
}

#[derive(Deserialize)]
struct DetectionItem {
    language: String,
    confidence: f64,
}

#[derive(Deserialize)]
struct LanguagesResponse {
    data: LanguagesData,
}

#[derive(Deserialize)]
struct LanguagesData {
    languages: Vec<LanguageItem>,
}

#[derive(Deserialize)]
struct LanguageItem {
    language: String,
    #[serde(default)]
    name: Option<String>,
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn map_reqwest_err(e: reqwest::Error) -> TranslationError {
    TranslationError::Http(crate::llm::provider::error_text(&e))
}

// ── Trait implementation ──────────────────────────────────────────────────────

#[async_trait]
impl TranslationProvider for GoogleTranslator {
    fn provider_name(&self) -> &str { "Google Cloud Translation" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::Google }
    fn is_local(&self) -> bool { false }

    async fn translate(
        &self,
        text: &str,
        source: Option<&str>,
        target: &str,
    ) -> Result<String, TranslationError> {
        let mut body = serde_json::json!({
            "q": text,
            "target": target,
            "format": "text",
        });
        if let Some(src) = source {
            body["source"] = serde_json::Value::String(src.to_string());
        }

        let resp = self
            .client
            .post(BASE_URL)
            .header("x-goog-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "Google API returned {}: {}",
                status, body_text
            )));
        }

        let parsed: TranslateResponse = resp.json().await.map_err(map_reqwest_err)?;
        parsed
            .data
            .translations
            .into_iter()
            .next()
            .map(|t| t.translated_text)
            .ok_or_else(|| TranslationError::Failed("Empty translations array".into()))
    }

    async fn translate_batch(
        &self,
        texts: &[String],
        source: Option<&str>,
        target: &str,
    ) -> Result<Vec<String>, TranslationError> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        let mut body = serde_json::json!({
            "q": texts,
            "target": target,
            "format": "text",
        });
        if let Some(src) = source {
            body["source"] = serde_json::Value::String(src.to_string());
        }

        let resp = self
            .client
            .post(BASE_URL)
            .header("x-goog-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "Google API returned {}: {}",
                status, body_text
            )));
        }

        let parsed: TranslateResponse = resp.json().await.map_err(map_reqwest_err)?;
        Ok(parsed
            .data
            .translations
            .into_iter()
            .map(|t| t.translated_text)
            .collect())
    }

    async fn detect_language(&self, text: &str) -> Result<DetectedLanguage, TranslationError> {
        let body = serde_json::json!({ "q": text });

        let resp = self
            .client
            .post(format!("{}/detect", BASE_URL))
            .header("x-goog-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "Google API returned {}: {}",
                status, body_text
            )));
        }

        let parsed: DetectResponse = resp.json().await.map_err(map_reqwest_err)?;
        let item = parsed
            .data
            .detections
            .into_iter()
            .next()
            .and_then(|inner| inner.into_iter().next())
            .ok_or_else(|| TranslationError::Failed("Empty detections array".into()))?;

        Ok(DetectedLanguage {
            lang: item.language,
            confidence: item.confidence,
        })
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        let resp = self
            .client
            .get(format!("{}/languages", BASE_URL))
            .header("x-goog-api-key", &self.api_key)
            .query(&[("target", "en")])
            .send()
            .await
            .map_err(map_reqwest_err)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "Google API returned {}: {}",
                status, body_text
            )));
        }

        let parsed: LanguagesResponse = resp.json().await.map_err(map_reqwest_err)?;
        Ok(parsed
            .data
            .languages
            .into_iter()
            .map(|l| Language {
                code: l.language.clone(),
                name: l.name.unwrap_or_else(|| l.language.clone()),
                native_name: None,
            })
            .collect())
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        let start = Instant::now();
        // Translate a short test string to validate the API key
        match self.translate("hello", None, "es").await {
            Ok(_) => {
                let lang_count = self.supported_languages().await
                    .map(|l| l.len())
                    .unwrap_or(0);
                Ok(ConnectionStatus {
                    connected: true,
                    language_count: lang_count,
                    response_ms: start.elapsed().as_millis() as u64,
                    error: None,
                })
            }
            Err(e) => Ok(ConnectionStatus {
                connected: false,
                language_count: 0,
                response_ms: start.elapsed().as_millis() as u64,
                error: Some(e.to_string()),
            }),
        }
    }
}
